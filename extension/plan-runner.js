/**
 * サーバーが組み立てた「実行手順」を、お客さまのブラウザで実行する。
 *
 * ★ここに note の仕様は書かない。
 *   何をどの順で叩くかはサーバーが決め、この中身は「言われた通りに叩く」だけ。
 *   note の仕様が変わったときに直すのはサーバー側だけで済む
 *   （拡張はお客さまのパソコンに配ったら、こちらから直せないため）。
 *
 * ★なぜお客さまのブラウザで実行するのか:
 *   サーバーから全員ぶんを叩くと、note から見て「1つの出どころ」に見える。
 *   1件がスパム判定されると全員が巻き添えになる。本人のブラウザから叩けば、
 *   影響はその人だけに閉じる。ログイン情報もこちらで預からずに済む。
 */

export const NOTE_ORIGIN = 'https://note.com';

/**
 * 叩いてよいのは note の API だけ。ここが最後の歯止め。
 * ★クエリ文字列（?id=...&is_temp_saved=true）は note の下書き保存で実際に使う。
 */
const ALLOWED_PATH = /^\/api\/v[0-9]{1,2}\/[A-Za-z0-9_\-/.]+(\?[A-Za-z0-9_\-=&%.]*)?$/;

export class PlanError extends Error {
  constructor(message, { stepId = null, status = 0, code = '' } = {}) {
    super(message);
    this.name = 'PlanError';
    this.stepId = stepId;
    this.status = status;
    this.code = code;
  }
}

/** `{{name}}` を、これまでに取り込んだ値で置き換える（文字列・配列・オブジェクトを再帰）。 */
export function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

/**
 * note の API 以外を叩かせない。
 *
 * ★形の検査だけで終わらせず、組み立てた URL の行き先そのものを確かめる。
 *   万一サーバー側が乗っ取られても、ここでよそへは飛ばない。
 */
export function assertSafePath(path, stepId) {
  if (typeof path !== 'string' || path.includes('..') || !ALLOWED_PATH.test(path)) {
    throw new PlanError(`許可されていない宛先です: ${String(path).slice(0, 80)}`, { stepId });
  }
  let url;
  try {
    url = new URL(path, NOTE_ORIGIN);
  } catch {
    throw new PlanError(`宛先を解釈できませんでした: ${path.slice(0, 80)}`, { stepId });
  }
  if (url.origin !== NOTE_ORIGIN) {
    throw new PlanError(`許可されていない宛先です: ${url.origin}`, { stepId });
  }
  return url.toString();
}

/** レスポンスから値を取り込む（note は data でくるむことがある）。 */
function captureFrom(json, spec, vars, stepId) {
  const body = json && typeof json === 'object' && json.data !== undefined ? json.data : json;
  for (const [name, field] of Object.entries(spec ?? {})) {
    const v = body?.[field];
    if (v === undefined || v === null) {
      throw new PlanError(`note の応答に ${field} がありませんでした`, { stepId });
    }
    vars[name] = v;
  }
}

/**
 * 手順を順番に実行する。
 *
 * @param plan { version, steps: [{ id, method, path, json?, form?, capture? }] }
 * @param ctx  { fetchNote(url, init), fetchAsset(assetId) -> Blob, onStep?(id) }
 */
export async function runPlan(plan, ctx) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new PlanError('実行する手順がありません');
  }

  const vars = {};
  const done = [];

  for (const raw of plan.steps) {
    const step = { ...raw };
    ctx.onStep?.(step.id);

    const url = assertSafePath(substitute(step.path, vars), step.id);
    const init = {
      method: step.method ?? 'GET',
      credentials: 'include',
      // ★転送（リダイレクト）は追わない。追うと、よそのサイトへ
      //   ログイン状態つきで飛ばされる余地が残る
      redirect: 'error',
      headers: {},
    };

    if (step.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(substitute(step.json, vars));
    } else if (Array.isArray(step.form)) {
      const form = new FormData();
      for (const field of step.form) {
        if (field.asset) {
          const blob = await ctx.fetchAsset(field.asset);
          form.append(field.name, blob, field.fileName ?? 'file');
        } else {
          form.append(field.name, substitute(String(field.value ?? ''), vars));
        }
      }
      init.body = form;  // Content-Type は境界文字列つきで自動設定させる
    }

    // ★note が求めるヘッダ。ブラウザから叩くので Cookie は自動で付く
    init.headers['X-Requested-With'] = 'XMLHttpRequest';
    init.headers['Accept'] = 'application/json, text/plain, */*';

    const res = await ctx.fetchNote(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML が返ることがある */ }

    if (!res.ok || json?.error) {
      const code = json?.error?.code ?? '';
      const message = json?.error?.message ?? text.slice(0, 200);
      throw new PlanError(message || `HTTP ${res.status}`, { stepId: step.id, status: res.status, code });
    }

    captureFrom(json, step.capture, vars, step.id);
    done.push(step.id);
  }

  return { vars, steps: done };
}
