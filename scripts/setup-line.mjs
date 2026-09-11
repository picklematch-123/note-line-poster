/**
 * LINE 公式アカウントの設定を、コンソールを触らずに済ませる。
 *
 *   node scripts/setup-line.mjs [--url https://...] [--dry-run] [--skip-richmenu]
 *
 * やること:
 *   1. アクセストークンの確認（どのアカウントに繋がっているか表示する）
 *   2. Webhook URL の設定と疎通テスト
 *   3. リッチメニューの作成・画像アップロード・既定への設定
 *
 * ★何度実行しても同じ状態になる（古いリッチメニューは消してから作り直す）。
 * ★LINE Developers コンソールでしかできないこと（アカウント作成・トークン発行・
 *   応答メッセージのオフ）は docs/onboarding-line-oa.md に切り分けて書いてある。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

// ★既定値は置かない。--url か WORKER_URL で必ず渡す。
// 既定値を置くと、渡し忘れたときに他人の Worker へ Webhook を向けてしまう。
const DEFAULT_URL = '';
const RICHMENU_IMAGE = resolve(ROOT, 'assets/richmenu.png');
const RICHMENU_NAME = 'note-line-poster';

/**
 * リッチメニューの定義は assets/richmenu.json に置く。
 * ★配布する全員でまったく同じメニューにするため、定義はここに書かない。
 *   画像（assets/richmenu.png）・この JSON・src/adapters/line/commands.ts の
 *   3つが揃っていることは test/unit/richmenu.test.ts で担保している。
 */
const RICHMENU = JSON.parse(readFileSync(resolve(ROOT, 'assets/richmenu.json'), 'utf8'));
delete RICHMENU._comment;

// ── 引数と設定 ────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY = flag('dry-run');
const WORKER_URL = value('url', process.env.WORKER_URL || DEFAULT_URL).replace(/\/+$/, '');
if (!WORKER_URL) {
  console.error('Worker の URL が渡されていません。--url https://〇〇.workers.dev を付けて実行してください。');
  process.exit(1);
}

/** .dev.vars を環境変数のように読む（値はここでしか触らない）。 */
function loadEnv() {
  const path = resolve(ROOT, '.dev.vars');
  const out = { ...process.env };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !out[m[1]]) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
const TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN;

if (!TOKEN) {
  console.error('✗ LINE_CHANNEL_ACCESS_TOKEN がありません。');
  console.error('  .dev.vars に入れてください（取り方: docs/onboarding-line-oa.md 手順4）。');
  process.exit(1);
}

// ── LINE API ─────────────────────────────────────────
async function line(method, path, body, { base = API, contentType = 'application/json' } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body instanceof Uint8Array) {
    headers['Content-Type'] = contentType;
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 空応答のことがある */ }

  if (!res.ok) {
    const detail = json?.message ?? text.slice(0, 300);
    throw new Error(`LINE API ${method} ${path} → ${res.status} ${detail}`);
  }
  return json ?? {};
}

const step = (n, label) => console.log(`\n[${n}] ${label}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);

// ── 1. トークンの確認 ─────────────────────────────────
async function checkToken() {
  step(1, 'アクセストークンを確認');
  const bot = await line('GET', '/info');
  ok(`つながりました: ${bot.displayName}`);
  info(`Basic ID: ${bot.basicId}`);
  info(`応答モード: ${bot.chatMode === 'bot' ? 'Bot' : 'チャット'}（どちらでも動きます）`);
  // ★API から変えられない設定はここで見えるようにしておく。
  //   「定型文と AI の返信が二重に来る」はこの設定が原因なので、症状だけ先に伝える。
  info('定型文と AI の返信が二重に来る場合は、LINE Official Account Manager の');
  info('「応答設定 → 応答メッセージ」をオフにしてください（API では変えられません）。');
  return bot;
}

// ── 2. Webhook ───────────────────────────────────────
async function setupWebhook() {
  step(2, 'Webhook URL を設定');
  const endpoint = `${WORKER_URL}/line/webhook`;

  const current = await line('GET', '/channel/webhook/endpoint').catch(() => null);
  if (current?.endpoint === endpoint && current?.active) {
    ok(`設定済みでした: ${endpoint}`);
  } else if (DRY) {
    info(`[dry-run] ここで ${endpoint} に設定します`);
    return;
  } else {
    await line('PUT', '/channel/webhook/endpoint', { endpoint });
    ok(`設定しました: ${endpoint}`);
  }

  // 実際に LINE から Worker へ届くかを LINE 側から確かめる。
  // ★workers.dev のアドレスを登録した直後は、まだ世界中に行き渡っていない。
  //   1回で失敗と決めつけると、正しく出来ているのに「失敗」と表示されてしまう（実際に起きた）。
  let test;
  for (let i = 0; i < 5; i++) {
    test = await line('POST', '/channel/webhook/test', { endpoint }).catch((e) => ({ error: String(e) }));
    if (test.success === true || test.statusCode === 200) break;
    if (i < 4) {
      info(`まだ応答がありません。10秒待って試します（${i + 1}/5）`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  if (test.success === true || test.statusCode === 200) {
    ok('LINE から Worker への疎通を確認しました');
  } else {
    warn(`疎通テストに失敗しました: ${test.reason ?? test.detail ?? test.error ?? JSON.stringify(test)}`);
    warn('数分おいてから npm run setup をもう一度実行すると通ることがあります。');
  }
}

// ── 3. リッチメニュー ─────────────────────────────────
async function setupRichMenu() {
  step(3, 'リッチメニューを設定');

  if (!existsSync(RICHMENU_IMAGE)) {
    warn(`画像がありません: ${RICHMENU_IMAGE}`);
    warn('2500x843 / 1MB以下 の PNG を置いてから再実行してください。');
    return;
  }
  const image = new Uint8Array(readFileSync(RICHMENU_IMAGE));
  info(`画像: assets/richmenu.png（${(image.length / 1024).toFixed(0)} KB）`);
  if (image.length > 1024 * 1024) {
    warn('画像が 1MB を超えています。LINE に弾かれます。');
    return;
  }

  if (DRY) {
    info('[dry-run] ここで作成 → 画像アップロード → 既定に設定します');
    return;
  }

  // 作り直す前に、今の既定を控えておく（失敗しても元に戻せるように）
  const { richmenus = [] } = await line('GET', '/richmenu/list');
  const ours = richmenus.filter((m) => m.name === RICHMENU_NAME);

  const created = await line('POST', '/richmenu', RICHMENU);
  ok(`作成しました: ${created.richMenuId}`);

  await line('POST', `/richmenu/${created.richMenuId}/content`, image,
    { base: DATA_API, contentType: 'image/png' });
  ok('画像をアップロードしました');

  await line('POST', `/user/all/richmenu/${created.richMenuId}`);
  ok('全ユーザーの既定メニューにしました');

  // 新しいものが立ち上がってから、古いものを片付ける
  for (const old of ours) {
    await line('DELETE', `/richmenu/${old.richMenuId}`).catch(() => {});
    info(`古いメニューを削除: ${old.richMenuId}`);
  }

  console.log('');
  info('ボタンの割り当て:');
  for (const a of RICHMENU.areas) {
    info(`  x=${String(a.bounds.x).padStart(4)} 〜 ${String(a.bounds.x + a.bounds.width).padStart(4)} → 「${a.action.text}」`);
  }
}

// ── 実行 ─────────────────────────────────────────────
(async () => {
  console.log('LINE 公式アカウントの設定');
  console.log(`  Worker: ${WORKER_URL}`);
  if (DRY) console.log('  ※ dry-run（何も変更しません）');

  try {
    await checkToken();
    await setupWebhook();
    if (!flag('skip-richmenu')) await setupRichMenu();

    console.log('\n完了しました。');
    console.log('LINE のトークを開き直すと、下部にメニューが出ます。');
    console.log('（出ないときは一度トークを閉じて開き直してください）');
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    console.error('\nトークンが正しいか、docs/onboarding-line-oa.md の手順3・4を確認してください。');
    process.exit(1);
  }
})();
