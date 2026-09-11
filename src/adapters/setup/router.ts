/**
 * セットアップ画面（/setup）。配備したあと、ブラウザだけで仕上げるための口。
 *
 * ★この画面がやること
 *   1. 暗号化の鍵が無ければ作る（既にあれば絶対に触らない）
 *   2. LINE の設定を代行する（Webhook・疎通確認・リッチメニュー）
 *   3. いまの状態を見せる
 *
 * ★この画面が**やらないこと**（源蔵レビュー 2026-08-31 の条件）
 *   ・鍵やトークンを受け取らない／表示しない
 *   ・note 連携のコードを出さない（あれは LINE 側だけで発行する）
 *   ・Claude への質問を受け付けない
 *     （無認証だと LLM の踏み台にされ、顧客の Anthropic アカウントが止まる）
 *
 * ★書き込みは「初回だけ」無認証。以後は LINE で受け取ったコードが要る（条件3）。
 */
import { Hono } from 'hono';
import type { Env } from '../../env';
import { Db, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { ensureMasterKey, resolveMasterKey } from '../../core/setup/masterkey';
import { mayRun, markSetupCompleted, isSetupCompleted } from '../../core/setup/state';
import { provisionLine, type Step } from '../../core/line/provision';
import {
  DAILY_LIMIT_OPTIONS, INTERVAL_OPTIONS, RATE_RISK_NOTE,
  SUGGESTED_DAILY_LIMIT, SUGGESTED_INTERVAL_SEC,
  limitLabel, intervalLabel, parseDailyLimit, parseIntervalSec,
} from '../../core/policy/options';
import { log } from '../../lib/mask';

export const setupRouter = new Hono<{ Bindings: Env }>();

/** 画面に出す状態。★秘密は一切入れない */
interface Status {
  origin: string;
  masterKey: 'env' | 'kv' | 'none';
  lineConfigured: boolean;
  noteConnected: boolean;
  completed: boolean;
  /** ★実行にコードが要るか。表示と実行で同じ値を使う（ずれるとボタンを押して 403 になる） */
  requiresCode: boolean;
  /** いまの投稿レート設定。まだ表が無ければ null */
  rate: { daily: number; interval: number } | null;
}

async function readStatus(c: { env: Env; req: { url: string } }): Promise<Status> {
  const origin = new URL(c.req.url).origin;
  const [{ source }, completed] = await Promise.all([
    resolveMasterKey(c.env),
    isSetupCompleted(c.env.KV),
  ]);

  let noteConnected = false;
  try {
    const row = await c.env.DB
      .prepare(`SELECT 1 FROM note_sessions WHERE tenant_id = ? AND status = 'active' LIMIT 1`)
      .bind(DEFAULT_TENANT_ID)
      .first();
    noteConnected = !!row;
  } catch { /* まだテーブルが無いだけ。未接続として扱う */ }

  // ★ここは SELECT だけにする。画面を開いただけで行を作らない
  //   （見ただけの人が設定を書き込んだことになるのを避ける）
  let rate: Status['rate'] = null;
  try {
    const row = await c.env.DB
      .prepare('SELECT daily_post_limit, min_interval_sec FROM tenants WHERE id = ?')
      .bind(DEFAULT_TENANT_ID)
      .first<{ daily_post_limit: number; min_interval_sec: number }>();
    if (row) rate = { daily: row.daily_post_limit, interval: row.min_interval_sec };
  } catch { /* まだ表が無い。セットアップ後に出せばよい */ }

  return {
    origin,
    masterKey: source,
    lineConfigured: !!c.env.LINE_CHANNEL_ACCESS_TOKEN,
    noteConnected,
    completed,
    // すでに動いている環境（note と繋がっている）も「設定済み」として扱う
    requiresCode: completed || noteConnected,
    rate,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** 選択欄。いまの値が選択肢に無くても消えないよう、必ず1つは選ばれた状態にする */
function options(list: readonly number[], current: number, label: (n: number) => string): string {
  const all = list.includes(current) ? [...list] : [...list, current].sort((a, b) => a - b);
  return all.map((n) =>
    `<option value="${n}"${n === current ? ' selected' : ''}>${esc(label(n))}</option>`).join('');
}

/**
 * 投稿の設定。
 *
 * ★LINE からも同じことができる（「投稿設定」）。どちらで変えても同じ値を書く。
 * ★★出している本数は note の基準ではない。RATE_RISK_NOTE をここから外さないこと。
 */
function rateSection(status: Status): string {
  if (!status.rate) {
    return `<h2>投稿の設定</h2>
<div class="note">セットアップが終わると、ここで「1日の本数」と「投稿の間隔」を決められます。</div>`;
  }

  return `<h2>投稿の設定</h2>
<div class="note">${esc(RATE_RISK_NOTE).replace(/\n/g, '<br>')}</div>
<p class="lead">迷ったときは <b>${esc(limitLabel(SUGGESTED_DAILY_LIMIT))}</b>・
<b>${esc(intervalLabel(SUGGESTED_INTERVAL_SEC))}</b> あたりから始めて、
様子を見ながら上げてください（これも note の基準ではなく、こちらの目安です）。</p>
<form method="post" action="/setup/settings">
 <label for="daily">1日に投稿できる本数</label>
 <select id="daily" name="daily">${options(DAILY_LIMIT_OPTIONS, status.rate.daily, limitLabel)}</select>
 <label for="interval" style="margin-top:1rem">前の投稿からあける時間</label>
 <select id="interval" name="interval">${options(INTERVAL_OPTIONS, status.rate.interval, intervalLabel)}</select>
 ${status.requiresCode ? `<label for="code3" style="margin-top:1rem">LINE で受け取ったコード</label>
 <input id="code3" name="code" placeholder="ABCD-2345" autocomplete="off" required>` : ''}
 <button type="submit">この内容で保存する</button>
</form>
<p class="d" style="margin-left:0">LINE で「投稿設定」と送っても、同じことができます。</p>`;
}

function page(status: Status, steps: Step[] = [], message = ''): string {
  const mark = (ok: boolean) => ok ? '<span class="ok">✓</span>' : '<span class="ng">×</span>';
  const rows = steps.map((s) =>
    `<li>${mark(s.ok)} ${esc(s.label)}${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ''}</li>`).join('');

  return `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>セットアップ</title>
<style>
 body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;line-height:1.8;
      max-width:38rem;margin:0 auto;padding:2rem 1.2rem 6rem;color:#1a1a1a}
 h1{font-size:1.4rem;margin:0 0 .3rem} h2{font-size:1.05rem;margin:2rem 0 .6rem}
 .lead{color:#555;font-size:.95rem;margin:0 0 1.6rem}
 code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px;font-size:.9em;word-break:break-all}
 table{border-collapse:collapse;width:100%;font-size:.95rem}
 td{border-bottom:1px solid #eee;padding:.5rem .2rem} td:first-child{color:#666;width:11rem}
 .ok{color:#0a7d3f;font-weight:700} .ng{color:#c0392b;font-weight:700}
 ul{list-style:none;padding:0} li{border-bottom:1px solid #eee;padding:.5rem 0}
 .d{color:#666;font-size:.85rem;margin-left:1.4rem}
 form{margin-top:1.2rem} label{display:block;font-size:.9rem;color:#555;margin-bottom:.3rem}
 input,select{font-size:1rem;padding:.6rem;width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;background:#fff}
 button{font-size:1rem;padding:.75rem 1.4rem;margin-top:.9rem;border:0;border-radius:6px;
        background:#0a7d3f;color:#fff;cursor:pointer}
 .note{background:#fff8e6;border:1px solid #f0dfa8;padding:.8rem 1rem;border-radius:6px;font-size:.9rem;margin:1.2rem 0}
 .msg{background:#eef6ff;border:1px solid #cfe2f7;padding:.8rem 1rem;border-radius:6px;margin:1.2rem 0}
</style>
<h1>セットアップ</h1>
<p class="lead">このシステムを使える状態にします。押すだけで終わります。</p>

${message ? `<div class="msg">${esc(message)}</div>` : ''}

<h2>いまの状態</h2>
<table>
 <tr><td>あなたのURL</td><td><code>${esc(status.origin)}</code></td></tr>
 <tr><td>暗号化の鍵</td><td>${mark(status.masterKey !== 'none')} ${
   status.masterKey === 'none' ? 'まだありません（下のボタンで作ります）' : '用意できています'}</td></tr>
 <tr><td>LINE のトークン</td><td>${mark(status.lineConfigured)} ${
   status.lineConfigured ? '登録されています' : '未登録（配備し直しが必要です）'}</td></tr>
 <tr><td>note との連携</td><td>${mark(status.noteConnected)} ${
   status.noteConnected ? 'つながっています' : 'まだです（LINE で「note連携」と送ってください）'}</td></tr>
</table>

${steps.length ? `<h2>実行の結果</h2><ul>${rows}</ul>` : ''}

<h2>${status.requiresCode ? 'もう一度実行する' : 'セットアップを実行する'}</h2>
${status.requiresCode ? `
<div class="note">一度セットアップが終わっているため、実行にはコードが要ります。
LINE で <b>「セットアップ」</b> と送ると、10分間だけ使えるコードが届きます。</div>
<form method="post" action="/setup/run">
 <label for="code">LINE で受け取ったコード</label>
 <input id="code" name="code" placeholder="ABCD-2345" autocomplete="off" required>
 <button type="submit">実行する</button>
</form>` : `
<div class="note">押すと、次のことをまとめて行います。<br>
 ・暗号化の鍵を作る　・LINE の受け口を設定する　・メニューを作る</div>
<form method="post" action="/setup/run"><button type="submit">セットアップを実行する</button></form>`}

${rateSection(status)}

<h2>持ち主を変える</h2>
<div class="note">
 「最初にトークへ話しかけた人」が持ち主になります。<b>間違った人が持ち主になってしまったとき</b>や、
 <b>担当者を引き継ぐとき</b>は、ここで登録をやめてください。<br>
 やめたあと、<b>次に話しかけた人</b>が新しい持ち主になります。
</div>
<form method="post" action="/setup/reset-owner">
 ${status.requiresCode ? `<label for="code2">LINE で受け取ったコード</label>
 <input id="code2" name="code" placeholder="ABCD-2345" autocomplete="off" required>` : ''}
 <button type="submit">持ち主の登録をやめる</button>
</form>

<h2>このあと</h2>
<ol>
 <li>LINE の <b>応答設定 → 応答メッセージ</b> を <b>オフ</b> にする（画面からしか変えられません）</li>
 <li>LINE のトークに何か1通送る（<b>最初に送った人が持ち主</b>になります）</li>
 <li>LINE で <b>「note連携」</b> と送り、出たコードを Chrome 拡張に貼る</li>
</ol>
</html>`;
}

setupRouter.get('/setup', async (c) => c.html(page(await readStatus(c))));

setupRouter.post('/setup/run', async (c) => {
  const status = await readStatus(c);

  // ★書き込みの許可を先に確かめる（初回のみ無認証）
  const form = await c.req.formData().catch(() => null);
  const code = (form?.get('code') as string | null) ?? null;
  // ★印が無くても、すでに note と繋がっているなら「設定済み」として扱う。
  //   稼働中の環境に /setup が生えたとき、無認証で叩かれないようにするため
  const permission = await mayRun(c.env.KV, code, status.requiresCode);

  if (!permission.allowed) {
    const msg = permission.reason === 'code_required'
      ? 'コードが必要です。LINE で「セットアップ」と送ると届きます。'
      : 'コードが違うか、期限が切れています。LINE で取り直してください。';
    log.warn('セットアップの実行を断りました', permission.reason);
    return c.html(page(status, [], msg), 403);
  }

  const steps: Step[] = [];

  // 1. 暗号化の鍵
  const key = await ensureMasterKey(c.env, status.noteConnected);
  if (key.ok) {
    steps.push({ label: '暗号化の鍵', ok: true,
      detail: key.created ? '新しく作りました' : 'すでにあるものを使います' });
  } else {
    steps.push({ label: '暗号化の鍵', ok: false,
      detail: key.reason === 'would_break_existing'
        ? '連携済みなのに鍵が見つかりません。作り直すと、いまの連携が読めなくなるため中止しました。提供元にご連絡ください。'
        : '保管庫に書き込めませんでした。少し待ってからやり直してください。' });
  }

  // 2. LINE の設定
  if (!c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    steps.push({ label: 'LINE の設定', ok: false, detail: 'トークンが登録されていません' });
  } else {
    const line = await provisionLine(
      c.env.LINE_CHANNEL_ACCESS_TOKEN, status.origin, c.env.KV, status.noteConnected);
    steps.push(...line.steps);
  }

  const allOk = steps.every((s) => s.ok);
  if (allOk) {
    await markSetupCompleted(c.env.KV);
    try {
      await new Db(c.env.DB).audit(DEFAULT_TENANT_ID, 'setup.completed', 'web', null, 'ok', null);
    } catch { /* 監査に失敗しても本体は止めない */ }
  }

  return c.html(page(await readStatus(c), steps,
    allOk ? 'セットアップが終わりました。下の「このあと」に進んでください。'
          : '一部が終わっていません。内容を確認して、もう一度実行してください。'));
});


setupRouter.post('/setup/reset-owner', async (c) => {
  const status = await readStatus(c);

  const form = await c.req.formData().catch(() => null);
  const code = (form?.get('code') as string | null) ?? null;
  const permission = await mayRun(c.env.KV, code, status.requiresCode);

  if (!permission.allowed) {
    const msg = permission.reason === 'code_required'
      ? 'コードが必要です。LINE で「セットアップ」と送ると届きます。'
      : 'コードが違うか、期限が切れています。LINE で取り直してください。';
    return c.html(page(status, [], msg), 403);
  }

  // ★環境変数で固定されている場合は、ここからは変えられない。黙って成功と言わない
  if (c.env.LINE_OWNER_USER_ID) {
    return c.html(page(status, [{
      label: '持ち主の登録をやめる', ok: false,
      detail: '持ち主が固定されています。Cloudflare の画面 → 設定 → 変数とシークレット で '
        + 'LINE_OWNER_USER_ID を消してから、もう一度お試しください。',
    }]), 409);
  }

  const cleared = await new Db(c.env.DB).clearOwnerLineUserId(DEFAULT_TENANT_ID, 'web');
  return c.html(page(await readStatus(c), [{
    label: '持ち主の登録をやめる', ok: true,
    detail: cleared
      ? '次にトークへ話しかけた人が、新しい持ち主になります'
      : 'もともと登録されていませんでした',
  }], '引き継ぐ相手に、LINE で話しかけてもらってください。'));
});

/**
 * 投稿の設定を保存する。
 *
 * ★ここも書き込みなので、実行と同じ入場口（ワンタイムコード）を通す。
 *   上限を外す操作は、note のアカウント停止に直結しうる。
 *   「見られてもいい画面」ではあっても、「誰でも変えていい設定」ではない。
 *
 * ★1回の送信で両方まとめて保存する。
 *   コードは1回きりなので、項目ごとに分けると毎回取り直しになる。
 */
setupRouter.post('/setup/settings', async (c) => {
  const status = await readStatus(c);

  const form = await c.req.formData().catch(() => null);
  const code = (form?.get('code') as string | null) ?? null;
  const permission = await mayRun(c.env.KV, code, status.requiresCode);

  if (!permission.allowed) {
    const msg = permission.reason === 'code_required'
      ? 'コードが必要です。LINE で「セットアップ」と送ると届きます。'
      : 'コードが違うか、期限が切れています。LINE で取り直してください。';
    return c.html(page(status, [], msg), 403);
  }

  // ★読めない値のときは、その項目を変えない。
  //   0 に丸めると「無制限・間隔なし」＝いちばん危ない側に倒れてしまう
  const daily = parseDailyLimit(form?.get('daily') as string | null);
  const interval = parseIntervalSec(form?.get('interval') as string | null);

  if (daily === null && interval === null) {
    return c.html(page(status, [{
      label: '投稿の設定', ok: false, detail: '入力を受け取れませんでした。もう一度お試しください。',
    }]), 400);
  }

  try {
    await new Db(c.env.DB).updateTenantSettings(DEFAULT_TENANT_ID, {
      ...(daily !== null ? { daily_post_limit: daily } : {}),
      ...(interval !== null ? { min_interval_sec: interval } : {}),
    }, 'web');
  } catch (e) {
    log.warn('投稿の設定を保存できませんでした', String(e));
    return c.html(page(status, [{
      label: '投稿の設定', ok: false,
      detail: 'まだ準備が終わっていないようです。先に「セットアップを実行する」をお試しください。',
    }]), 500);
  }

  const after = await readStatus(c);
  const unlimited = after.rate?.daily === 0;
  return c.html(page(after, [{
    label: '投稿の設定', ok: true,
    detail: `${limitLabel(after.rate?.daily ?? 0)} ／ ${intervalLabel(after.rate?.interval ?? 0)}`,
  }], unlimited
    ? '保存しました。上限なしにした場合、どれくらい投稿するかはご自身の判断になります。'
    : '保存しました。'));
});
