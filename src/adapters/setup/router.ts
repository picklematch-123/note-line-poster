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
 *
 * ★2026-10-26「画像のルール」節を追加（設計書 docs/design-image-rules-2026-10-26.md 3-3）。
 *   保存・参考画像の追加・削除は、ほかの書き込みと同じ入場口（mayRun）を通す。
 *   この画面は誰でも開けるので、登録済みのルール本文と参考画像そのものは出さない（文字数・名前・サイズだけ）。
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
import { KvImageStore } from '../../ports/storage/images';
import {
  loadImageRulesSummary, saveImageRules, addImageRef, deleteImageRef, checkRefUpload, listImageRefs,
  validateImageSettingsBatch, applyImageSettingsBatch, BatchCountChanged, BatchWriteFailed,
  RULE_BODY_MAX, REF_MAX_BYTES, REF_MAX_COUNT, REF_NAME_MAX, DEFAULT_INSPECT_RETRIES, INSPECT_RETRY_OPTIONS, REF_REJECT_NOTE,
  type ImageRulesSummary, type BatchUpload,
} from '../../core/image/rules';
import { MAX_GENERATIONS_PER_ARTICLE } from '../../core/image/thumbnail';

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
  /** 画像のルールの要約（★本文・画像は入れない。文字数・名前・サイズだけ） */
  imageRules: ImageRulesSummary;
  /** 画像を作れるキーがあるか（無ければルールは使われない旨を出す） */
  hasImageKey: boolean;
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

  // 表がまだ無ければ「未登録」として読む（core 側で受け止める）
  const imageRules = await loadImageRulesSummary(new Db(c.env.DB), DEFAULT_TENANT_ID);

  return {
    imageRules,
    hasImageKey: Boolean(c.env.OPENAI_API_KEY?.startsWith('sk-')),
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
/**
 * コードの入力欄。
 *
 * ★**入手方法を必ず一緒に出すこと。**
 *   「LINE で受け取ったコード」とだけ書いていた時期があり、
 *   **何を送ればコードが来るのか分からず設定できない**という詰まり方をした
 *   （2026-09-12 運用側の判断）。欄だけ置いて説明を書かない、を繰り返さないために
 *   1か所にまとめてある。
 */
function codeField(id: string): string {
  return `<label for="${id}">確認コード</label>
 <p class="d" style="margin-left:0">LINE で <b>「セットアップ」</b> と送ると届きます。
 <b>10分間・1回かぎり</b>なので、使ったら次はまた送ってください。</p>
 <input id="${id}" name="code" placeholder="ABCD-2345" autocomplete="off" required>`;
}

function rateSection(status: Status): string {
  if (!status.rate) {
    return `<h2>投稿の設定</h2>
<div class="note">セットアップが終わると、ここで「1日の本数」と「投稿の間隔」を決められます。</div>`;
  }

  return `<h2>投稿の設定</h2>
${status.requiresCode ? `<div class="note">
 <b>LINE から変えるのがいちばん簡単です。</b><br>
 LINE で <b>「投稿設定」</b> と送ると、ボタンを押すだけで変えられます（<b>コードは要りません</b>）。<br>
 この画面から変えるときだけ、下の確認コードが必要になります。
</div>` : ''}
<div class="note">${esc(RATE_RISK_NOTE).replace(/\n/g, '<br>')}</div>
<p class="lead">迷ったときは <b>${esc(limitLabel(SUGGESTED_DAILY_LIMIT))}</b>・
<b>${esc(intervalLabel(SUGGESTED_INTERVAL_SEC))}</b> あたりから始めて、
様子を見ながら上げてください（これも note の基準ではなく、こちらの目安です）。</p>
<form method="post" action="/setup/settings">
 <label for="daily">1日に投稿できる本数</label>
 <select id="daily" name="daily">${options(DAILY_LIMIT_OPTIONS, status.rate.daily, limitLabel)}</select>
 <label for="interval" style="margin-top:1rem">前の投稿からあける時間</label>
 <select id="interval" name="interval">${options(INTERVAL_OPTIONS, status.rate.interval, intervalLabel)}</select>
 ${status.requiresCode ? `<div style="margin-top:1rem">${codeField('code3')}</div>` : ''}
 <button type="submit">この内容で保存する</button>
</form>
`;
}

/** 「画像のルール」節。★登録済みの本文・参考画像そのものは出さない */
function imageRulesSection(status: Status): string {
  const r = status.imageRules;
  const code = (id: string) => status.requiresCode ? `<div style="margin-top:1rem">${codeField(id)}</div>` : '';
  const inspectSel = r.thumbnail.registered ? r.thumbnail.inspectRetries : DEFAULT_INSPECT_RETRIES;
  const inspectLabel = (n: number) => n === 0 ? '作り直さない' : `${n}回まで作り直す`;
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}KB`;
  // ★消すのはチェック欄（まとめて保存のフォームの中）。1枚ごとにコードを使わせない
  const refRows = r.refs.map((ref) => `<li>${esc(ref.name)}（${kb(ref.sizeBytes)}）
 <label style="margin-top:.3rem"><input type="checkbox" name="delete_ref" value="${esc(ref.id)}" style="width:auto"> この参考画像を消す</label></li>`).join('');

  // ★セットアップ前（コード無しで通る状態）は、画像のルールの書き込みを受け付けない。フォームも出さない
  if (!status.requiresCode) {
    return `<h2>画像のルール</h2>
<div class="note">${esc(NEED_SETUP_FIRST)}</div>`;
  }

  return `<h2>画像のルール</h2>
<div class="note">
 サムネイルと文中の画像を AI が作るときのルールです。<b>何も登録しなければ、今までどおりに作ります。</b><br>
 この画面は誰でも開けるため、登録した内容そのものは表示しません（文字数だけ出します）。書き直すときは、全文を入れ直してください。
</div>
${status.hasImageKey ? '' : '<div class="note">OpenAI の API キーが未登録のため、いまは画像を作りません（登録すると使われます）。</div>'}
<table>
 <tr><td>サムネ用のルール</td><td>${r.thumbnail.registered && r.thumbnail.chars ? `登録済み（${r.thumbnail.chars}字）` : '未登録'}</td></tr>
 <tr><td>サムネのタイトル</td><td>${r.thumbnail.titleMode === 'title' ? '記事タイトルを入れる' : '入れない'}</td></tr>
 <tr><td>確認と作り直し</td><td>${r.thumbnail.registered ? esc(inspectLabel(r.thumbnail.inspectRetries)) : '確認しない（今までどおり）'}</td></tr>
 <tr><td>文中の画像用のルール</td><td>${r.inline.registered && r.inline.chars ? `登録済み（${r.inline.chars}字）` : '未登録'}</td></tr>
 <tr><td>参考画像</td><td>${r.refs.length} / ${REF_MAX_COUNT} 枚</td></tr>
 <tr><td>参考画像の使い方</td><td>${r.refRandom ? '画像ごとにランダムに選ぶ' : '全部使う（今までどおり）'}</td></tr>
</table>
<form method="post" action="/setup/image-rules/all" enctype="multipart/form-data">
 <div class="note">この欄は<b>まとめて1回で保存</b>します（確認コードは1つで足ります）。変えない欄は空のままで構いません。</div>
 <label for="thumb_body" style="margin-top:1rem">サムネ用のルール（${RULE_BODY_MAX}字まで）</label>
 <textarea id="thumb_body" name="thumb_body" maxlength="${RULE_BODY_MAX}" rows="6" style="width:100%;box-sizing:border-box"
  placeholder="空のまま保存すると、いまの内容を残します"></textarea>
 <label style="margin-top:.4rem"><input type="checkbox" name="thumb_clear" value="1" style="width:auto"> サムネ用のルールを消す</label>
 <label for="thumb_title_mode" style="margin-top:1rem">サムネに記事タイトルを入れる</label>
 <select id="thumb_title_mode" name="thumb_title_mode">
  <option value="none"${r.thumbnail.titleMode === 'none' ? ' selected' : ''}>入れない（今までどおり）</option>
  <option value="title"${r.thumbnail.titleMode === 'title' ? ' selected' : ''}>入れる（タイトルを一字一句そのまま）</option>
 </select>
 <label for="thumb_inspect" style="margin-top:1rem">作ったサムネを AI が確認し、気になる点があったときの作り直し</label>
 <select id="thumb_inspect" name="thumb_inspect">${INSPECT_RETRY_OPTIONS.map((n) =>
   `<option value="${n}"${n === inspectSel ? ' selected' : ''}>${esc(inspectLabel(n))}</option>`).join('')}</select>
 <p class="d" style="margin-left:0">「作り直さない」の場合: タイトルを入れないときは AI の確認そのものを行いません（今までどおり1枚作るだけ）。
 タイトルを入れるときは1回だけ確認し、タイトルが違っていたらサムネなしで進めます。<br>
 サムネ1枚 約5〜6円・確認1回 約1円の目安（ご自身の OpenAI アカウントにかかります）。
 1回の作成で最大 約17〜20円。作り直しを含めても1記事 最大${MAX_GENERATIONS_PER_ARTICLE}枚（約35〜40円）までです。作り直した分も、1日の上限に数えます。</p>
 <label for="inline_body" style="margin-top:1rem">文中の画像用のルール（${RULE_BODY_MAX}字まで）</label>
 <textarea id="inline_body" name="inline_body" maxlength="${RULE_BODY_MAX}" rows="5" style="width:100%;box-sizing:border-box"
  placeholder="空のまま保存すると、いまの内容を残します"></textarea>
 <label style="margin-top:.4rem"><input type="checkbox" name="inline_clear" value="1" style="width:auto"> 文中の画像用のルールを消す</label>

 <h2>参考画像（見た目や雰囲気をそろえたい画像）</h2>
 <div class="note">登録すると、サムネと文中の画像の両方で、見た目や雰囲気をそろえる参考に使います。人物・キャラクター、商品、お店の雰囲気、過去のサムネの見本など、なんでも登録できます。<br>
 <b>ご自身や自社に権利がある画像だけを登録してください（他人の顔写真・有名人・他社の商品やロゴ・アニメなどのキャラクターは不可）。</b>画像の中のロゴや文字は再現しません。
 PNG・JPEG・WebP、1枚 ${REF_MAX_BYTES / 1024 / 1024}MB まで・合わせて ${REF_MAX_COUNT} 枚まで。画像そのものはこの画面に表示しません。</div>
 ${r.refs.length ? `<ul>${refRows}</ul>` : '<p class="lead">まだ登録されていません。</p>'}
 <label for="ref_random" style="margin-top:1rem">参考画像の使い方</label>
 <select id="ref_random" name="ref_random">
  <option value="0"${r.refRandom ? '' : ' selected'}>登録した参考画像を全部使う（今までどおり）</option>
  <option value="1"${r.refRandom ? ' selected' : ''}>画像ごとにランダムに選ぶ（1枚か2枚）</option>
 </select>
 <p class="d" style="margin-left:0">ランダムにすると、サムネ・文中の画像の1枚ごとに、登録した参考画像から1枚または2枚を選んで使います（例: 登場人物を毎回変えたい、見本を使い分けたい）。</p>
 ${[1, 2, 3].map((n) => `<label for="ref_name_${n}" style="margin-top:1rem">追加する画像 ${n} の名前（何の画像か。例: 「店主」「看板メニュー」「サムネの見本」・${REF_NAME_MAX}字まで）</label>
 <input id="ref_name_${n}" name="ref_name_${n}" maxlength="${REF_NAME_MAX}" autocomplete="off">
 <input id="ref_file_${n}" name="ref_file_${n}" type="file" accept="image/png,image/jpeg,image/webp" style="margin-top:.4rem">`).join('')}
 ${code('code_all')}
 <button type="submit">画像のルールと参考画像をまとめて保存する</button>
</form>
`;
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
 ${codeField('code')}
 <button type="submit">実行する</button>
</form>` : `
<div class="note">押すと、次のことをまとめて行います。<br>
 ・暗号化の鍵を作る　・LINE の受け口を設定する　・メニューを作る</div>
<form method="post" action="/setup/run"><button type="submit">セットアップを実行する</button></form>`}

${rateSection(status)}

${imageRulesSection(status)}

<h2>持ち主を変える</h2>
<div class="note">
 「最初にトークへ話しかけた人」が持ち主になります。<b>間違った人が持ち主になってしまったとき</b>や、
 <b>担当者を引き継ぐとき</b>は、ここで登録をやめてください。<br>
 やめたあと、<b>次に話しかけた人</b>が新しい持ち主になります。
</div>
<form method="post" action="/setup/reset-owner">
 ${status.requiresCode ? codeField('code2') : ''}
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


// ── 画像のルール（2026-10-26）─────────────────────────────
/** 断ったときの文言（ほかの書き込みと同じ） */
function deniedMessage(reason: 'code_required' | 'code_invalid'): string {
  return reason === 'code_required'
    ? 'コードが必要です。LINE で「セットアップ」と送ると届きます。'
    : 'コードが違うか、期限が切れています。LINE で取り直してください。';
}

/**
 * ★画像のルールの書き込みは、初回（コード無しで通る状態）でも断る（2026-10-26 源蔵レビュー必須2）。
 *   セットアップ前は誰でもコード無しで書けてしまう。素材やルールを差し込まれないよう、
 *   セットアップを済ませて（＝LINE でコードを受け取れる状態にして）からにする
 */
export const NEED_SETUP_FIRST = '先にセットアップを済ませてください（上の「セットアップを実行する」）。画像のルールと参考画像は、そのあと LINE で受け取るコードを使って登録します。';

type Permission = Awaited<ReturnType<typeof mayRun>>;
function imageWriteDenied(p: Permission): string | null {
  if (!p.allowed) return deniedMessage(p.reason);
  if (p.reason === 'first_run') return NEED_SETUP_FIRST;
  return null;
}

/** 画像の書き込み経路ごとの、送信の大きさの上限（バイト） */
export const BODY_LIMITS = {
  rules: 256 * 1024,                                   // ルール本文2つ（6000字×2をURLエンコードしても収まる）
  refs: REF_MAX_BYTES + 64 * 1024,                     // 参考画像1枚
  refsDelete: 16 * 1024,
  all: REF_MAX_COUNT * REF_MAX_BYTES + 256 * 1024,     // まとめて保存（3枚＋文字）
} as const;

/**
 * ★本文を読む前に、送信の大きさの申告（Content-Length）を確かめる（2026-10-27 源蔵レビュー必須1）。
 *   申告が無い（chunked）・数字でない・0以下 → 411、上限超え → 413。
 *   formData() は本文を全部メモリに読むので、確かめずに読むと、認証より前に大きな送信を受け止めてしまう
 */
export function checkBodySize(header: string | undefined, max: number): { status: 411 | 413; detail: string } | null {
  const raw = (header ?? '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    return { status: 411, detail: '送信の大きさが分かりませんでした。ブラウザの画面から、もう一度お試しください。' };
  }
  if (Number(raw) > max) return { status: 413, detail: REF_REJECT_NOTE.too_large };
  return null;
}

/** 本文の長さだけ先に見る（コードを使う前。上限超えでコードを無駄にさせない） */
function tooLong(v: unknown): boolean {
  return typeof v === 'string' && v.replace(/\r\n?/g, '\n').trim().length > RULE_BODY_MAX;
}

/**
 * 画像のルールを保存する（サムネ用・文中画像用をまとめて。コードは1回きりのため）。
 * ★空欄は「変えない」。この画面は登録済みの本文を出さないので、空欄で上書きして消さない（消すのはチェック欄）
 */
setupRouter.post('/setup/image-rules', async (c) => {
  const status = await readStatus(c);
  const size = checkBodySize(c.req.header('content-length'), BODY_LIMITS.rules);
  if (size) return c.html(page(status, [{ label: '画像のルール', ok: false, detail: size.detail }]), size.status);
  const form = await c.req.formData().catch(() => null);
  // ★コード（1回きり）を使う前に、文字数を検査する（参考画像と同じ順番）。ここでは何も書かない
  if (tooLong(form?.get('thumb_body')) || tooLong(form?.get('inline_body'))) {
    return c.html(page(status, [{ label: '画像のルール', ok: false, detail: `${RULE_BODY_MAX}字を超えています。短くしてください。` }]), 400);
  }
  const permission = await mayRun(c.env.KV, (form?.get('code') as string | null) ?? null, status.requiresCode);
  const deny = imageWriteDenied(permission);
  if (deny) {
    log.warn('画像のルールの保存を断りました', permission.reason);
    return c.html(page(status, [], deny), 403);
  }

  const db = new Db(c.env.DB);
  const steps: Step[] = [];
  try {
    const thumb = await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', {
      body: form?.get('thumb_body') ?? undefined,
      clearBody: form?.get('thumb_clear') === '1',
      titleMode: form?.get('thumb_title_mode') ?? undefined,
      inspectRetries: form?.get('thumb_inspect') ?? undefined,
      by: 'web',
    });
    const inline = await saveImageRules(db, DEFAULT_TENANT_ID, 'inline', {
      body: form?.get('inline_body') ?? undefined,
      clearBody: form?.get('inline_clear') === '1',
      by: 'web',
    });
    const label = (r: typeof thumb, name: string): Step => r.ok
      ? { label: name, ok: true, detail: r.saved ? '保存しました' : '登録なしのまま（今までどおり）' }
      : { label: name, ok: false, detail: r.reason === 'too_long' ? `${RULE_BODY_MAX}字を超えています。短くしてください。` : '選べない値でした。もう一度お試しください。' };
    steps.push(label(thumb, 'サムネ用のルール'), label(inline, '文中の画像用のルール'));
  } catch (e) {
    log.warn('画像のルールを保存できませんでした', String(e).slice(0, 120));
    return c.html(page(status, [{
      label: '画像のルール', ok: false, detail: 'まだ準備が終わっていないようです。先に「セットアップを実行する」をお試しください。',
    }]), 500);
  }
  const allOk = steps.every((x) => x.ok);
  return c.html(page(await readStatus(c), steps, allOk ? '保存しました。次に作る画像から使われます。' : '一部を保存できませんでした。'), allOk ? 200 : 400);
});

/** 参考画像を1枚足す（multipart）。★大きすぎる送信は、中身を読む前に断る */
setupRouter.post('/setup/image-refs', async (c) => {
  const status = await readStatus(c);
  const size = checkBodySize(c.req.header('content-length'), BODY_LIMITS.refs);
  if (size) return c.html(page(status, [{ label: '参考画像', ok: false, detail: size.detail }]), size.status);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file') as unknown;
  const isFile = (v: unknown): v is Blob => typeof v === 'object' && v !== null && typeof (v as Blob).arrayBuffer === 'function';
  if (!isFile(file)) {
    return c.html(page(status, [{ label: '参考画像', ok: false, detail: REF_REJECT_NOTE.empty }]), 400);
  }
  if (file.size > REF_MAX_BYTES) {
    return c.html(page(status, [{ label: '参考画像', ok: false, detail: REF_REJECT_NOTE.too_large }]), 413);
  }
  const bytes = await file.arrayBuffer();
  // ★コード（1回きり）を使う前に、中身を検査する（形式違いでコードを無駄にさせない）。ここでは何も書かない
  const pre = checkRefUpload(bytes, (await listImageRefs(new Db(c.env.DB), DEFAULT_TENANT_ID)).length);
  if (!pre.ok) {
    return c.html(page(status, [{ label: '参考画像', ok: false, detail: REF_REJECT_NOTE[pre.reason] }]), 400);
  }

  const permission = await mayRun(c.env.KV, (form?.get('code') as string | null) ?? null, status.requiresCode);
  const deny = imageWriteDenied(permission);
  if (deny) {
    log.warn('参考画像の追加を断りました', permission.reason);
    return c.html(page(status, [], deny), 403);
  }

  try {
    const r = await addImageRef(new Db(c.env.DB), new KvImageStore(c.env.KV), DEFAULT_TENANT_ID, {
      name: form?.get('name'), bytes, by: 'web',
    });
    if (!r.ok) return c.html(page(status, [{ label: '参考画像', ok: false, detail: REF_REJECT_NOTE[r.reason] }]), 400);
  } catch (e) {
    log.warn('参考画像を保存できませんでした', String(e).slice(0, 120));
    return c.html(page(status, [{ label: '参考画像', ok: false, detail: '保存できませんでした。少し待ってからやり直してください。' }]), 500);
  }
  return c.html(page(await readStatus(c), [{ label: '参考画像', ok: true, detail: '追加しました' }], '次に作る画像から使われます。'));
});

/** 参考画像を1枚消す */
setupRouter.post('/setup/image-refs/delete', async (c) => {
  const status = await readStatus(c);
  const size = checkBodySize(c.req.header('content-length'), BODY_LIMITS.refsDelete);
  if (size) return c.html(page(status, [{ label: '参考画像を消す', ok: false, detail: size.detail }]), size.status);
  const form = await c.req.formData().catch(() => null);
  const permission = await mayRun(c.env.KV, (form?.get('code') as string | null) ?? null, status.requiresCode);
  const deny = imageWriteDenied(permission);
  if (deny) {
    log.warn('参考画像の削除を断りました', permission.reason);
    return c.html(page(status, [], deny), 403);
  }
  const id = String(form?.get('id') ?? '');
  const ok = id ? await deleteImageRef(new Db(c.env.DB), new KvImageStore(c.env.KV), DEFAULT_TENANT_ID, id, 'web').catch(() => false) : false;
  return c.html(page(await readStatus(c), [{
    label: '参考画像を消す', ok, detail: ok ? '消しました' : '見つかりませんでした（すでに消えているかもしれません）',
  }]), ok ? 200 : 404);
});

/**
 * 画像のルール・参考画像・参考画像の使い方を、**1回のコードでまとめて**保存する（multipart。2026-10-27）。
 * ★遠隔で使う顧客に「セットアップ」を何度も送ってもらわないため。
 * ★全部を検査してから書く。1つでもだめなら、何も保存せず、コードも使わない。
 * ★初回（コード無しで通る状態）は断る・コード無し／不正は 403（ほかの画像の書き込みと同じ）
 */
setupRouter.post('/setup/image-rules/all', async (c) => {
  const status = await readStatus(c);
  // ★大きさの申告が無い・壊れている・大きすぎる送信は、中身を読む前に断る（3枚 × 上限 ＋ 文字の分）
  const size = checkBodySize(c.req.header('content-length'), BODY_LIMITS.all);
  if (size) return c.html(page(status, [{ label: '画像のルール', ok: false, detail: size.detail }]), size.status);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.html(page(status, [{ label: '画像のルール', ok: false, detail: '入力を受け取れませんでした。もう一度お試しください。' }]), 400);

  const isFile = (v: unknown): v is File => typeof v === 'object' && v !== null && typeof (v as Blob).arrayBuffer === 'function';
  const uploads: BatchUpload[] = [];
  for (let n = 1; n <= REF_MAX_COUNT; n++) {
    const f = form.get(`ref_file_${n}`) as unknown;
    // ファイルを選ばなかった欄は、ブラウザが「名前なし・0バイト」で送ってくる。それは無視する
    if (!isFile(f) || (f.size === 0 && !f.name)) continue;
    uploads.push({ name: form.get(`ref_name_${n}`), bytes: await f.arrayBuffer() });
  }
  const str = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : undefined; };
  const db = new Db(c.env.DB);
  const current = await listImageRefs(db, DEFAULT_TENANT_ID);
  const v = validateImageSettingsBatch({
    thumbBody: str('thumb_body'), thumbClear: str('thumb_clear') === '1',
    thumbTitleMode: str('thumb_title_mode'), thumbInspect: str('thumb_inspect'),
    inlineBody: str('inline_body'), inlineClear: str('inline_clear') === '1',
    refRandom: str('ref_random'),
    deleteIds: form.getAll('delete_ref').filter((x): x is string => typeof x === 'string'),
    uploads,
  }, current.map((r) => r.id));
  // ★ここまで何も書いていない。だめならコードを使わずに返す
  if (!v.ok) {
    return c.html(page(status, v.errors.map((detail) => ({ label: '画像のルール', ok: false, detail })),
      '保存していません（確認コードはまだ使えます）。直してからもう一度お試しください。'), 400);
  }

  const permission = await mayRun(c.env.KV, str('code') ?? null, status.requiresCode);
  const deny = imageWriteDenied(permission);
  if (deny) {
    log.warn('画像のルールのまとめ保存を断りました', permission.reason);
    return c.html(page(status, [], deny), 403);
  }

  try {
    const r = await applyImageSettingsBatch(db, new KvImageStore(c.env.KV), DEFAULT_TENANT_ID, v.batch, 'web');
    const after = await readStatus(c);
    const steps: Step[] = [
      { label: 'サムネ用のルール', ok: true, detail: r.thumb.ok && r.thumb.saved ? '保存しました' : '登録なしのまま（今までどおり）' },
      { label: '文中の画像用のルール', ok: true, detail: r.inline.ok && r.inline.saved ? '保存しました' : '登録なしのまま（今までどおり）' },
      { label: '参考画像', ok: r.deleteFailed === 0,
        detail: `追加 ${r.added} 枚・削除 ${r.deleted} 枚（いま ${after.imageRules.refs.length} 枚）${r.deleteFailed ? `。${r.deleteFailed} 枚は消せませんでした` : ''}` },
      { label: '参考画像の使い方', ok: true, detail: after.imageRules.refRandom ? '画像ごとにランダムに選ぶ' : '全部使う（今までどおり）' },
    ];
    // ★削除だけ失敗した場合も、ほかは保存済み。事実どおり「保存しました（N枚は消せませんでした）」と言う
    return c.html(page(after, steps, r.deleteFailed
      ? `保存しました（${r.deleteFailed} 枚は消せませんでした。消すときは、もう一度チェックして保存してください）。`
      : '保存しました。次に作る画像から使われます。'));
  } catch (e) {
    if (e instanceof BatchCountChanged) {
      return c.html(page(await readStatus(c), [{
        label: '参考画像', ok: false, detail: `${REF_REJECT_NOTE.too_many}（別の保存と重なったようです。何も保存していません）`,
      }]), 409);
    }
    if (e instanceof BatchWriteFailed) {
      log.warn('画像のルールをまとめて保存できませんでした', String(e.cause).slice(0, 120));
      return c.html(page(await readStatus(c), [{
        label: '画像のルール', ok: false,
        detail: e.rollbackFailed.length
          ? `保存の途中で失敗し、次の項目は元に戻せませんでした: ${e.rollbackFailed.join('・')}。いまの状態は上の表をご確認ください。`
          : '保存の途中で失敗したため、何も保存していません（途中まで書いた分は元に戻しました）。少し待ってからやり直してください。',
      }]), 500);
    }
    throw e;
  }
});
