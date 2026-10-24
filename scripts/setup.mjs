/**
 * セットアップを1コマンドにまとめる。
 *
 *   node scripts/setup.mjs [--dry-run] [--url https://...]
 *
 * ★方針: 機械にできることは全部やる。人にしかできないことだけを最後に一覧で出す。
 *   「どこまで終わっていて、次に何をすればいいか」が毎回はっきりするようにしてある。
 *
 * 自動でやること:
 *   1. .dev.vars の中身を点検（足りない値と、その取り方を出す）
 *   2. 暗号化マスター鍵が無ければ作る
 *   3. Cloudflare のシークレットに反映
 *   4. マイグレーション適用 → デプロイ
 *   5. LINE の Webhook 設定・疎通テスト・リッチメニュー
 *   6. 死活確認
 *
 * 人にしかできないこと（最後に一覧で出す）:
 *   LINE公式アカウントの開設 / Messaging API の有効化 / トークンの発行 /
 *   応答メッセージのオフ / OpenAI の API キーの発行（前払いクレジット）/ note へのログイン
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { VARS, isHealthyCheck } from './setup-vars.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS = resolve(ROOT, '.dev.vars');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const urlArg = args.indexOf('--url');
// ★デプロイの出力から実際の URL を拾って入れる（Worker 名は顧客ごとに違う）。
//   ここに特定の URL を既定値として書かないこと。
//   拾えなかったときに他人の Worker へ LINE を向けてしまう（実際に起きた）。
let workerUrl = (urlArg >= 0 && args[urlArg + 1]) || '';

// ── 表示 ─────────────────────────────────────────────
const step = (n, label) => console.log(`\n━━ ${n}. ${label} ━━`);
const ok = (m) => console.log(`  ✓ ${m}`);
const skip = (m) => console.log(`  – ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const fail = (m) => console.log(`  ✗ ${m}`);

// ── .dev.vars ────────────────────────────────────────
// 必要な値の一覧と形の検査は setup-vars.mjs にある（テストから読めるように切り出した）

function readDevVars() {
  const out = {};
  if (!existsSync(DEV_VARS)) return out;
  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function setDevVar(key, value) {
  let text = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  } else {
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${key}=${value}\n`;
  }
  writeFileSync(DEV_VARS, text, { mode: 0o600 });
}

// ── wrangler ─────────────────────────────────────────
function wrangler(argv, { input } = {}) {
  return execFileSync('npx', ['wrangler', ...argv], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── 実行 ─────────────────────────────────────────────
function main() {
  console.log('note-line-poster セットアップ');
  console.log(`  Worker: ${workerUrl}`);
  if (DRY) console.log('  ※ dry-run（何も変更しません）');

  // 1. 設定値の点検 ------------------------------------------------
  step(1, '設定値を点検');
  if (!existsSync(DEV_VARS)) {
    warn('.dev.vars がありません。ひな形からコピーします。');
    if (!DRY) writeFileSync(DEV_VARS, readFileSync(resolve(ROOT, '.dev.vars.example'), 'utf8'), { mode: 0o600 });
  }

  let vars = readDevVars();
  const missing = [];

  const badFormat = [];
  for (const v of VARS) {
    if (vars[v.key]) {
      // ★値が入っていても、形が違えば意味がない。ここで気づかせる
      const problem = v.validate?.(vars[v.key]);
      if (problem) { fail(`${v.key} の値の形が違います`); badFormat.push([v.key, problem]); }
      else ok(`${v.key}`);
      continue;
    }
    if (v.generate) {
      const value = randomBytes(32).toString('base64');
      if (!DRY) { setDevVar(v.key, value); vars[v.key] = value; }
      ok(`${v.key} を生成しました`);
      continue;
    }
    if (v.required) { fail(`${v.key} が未設定`); missing.push(v); }
    else skip(`${v.key}（任意・未設定）`);
  }

  if (badFormat.length > 0) {
    console.log('\n次の値の形を直してから、もう一度実行してください:\n');
    for (const [key, problem] of badFormat) console.log(`  ${key}\n    → ${problem}\n`);
    process.exit(1);
  }

  if (missing.length > 0) {
    console.log('\n次の値を .dev.vars に入れてから、もう一度実行してください:\n');
    for (const v of missing) console.log(`  ${v.key}\n    → ${v.where}\n`);
    console.log('  開き方:  open -e .dev.vars');
    process.exit(1);
  }

  // ★どちらで文章を書くかを、ここで一度はっきり見せる（勝手に切り替わったと思わせない）
  const provider = (vars.LLM_PROVIDER || '').trim().toLowerCase();
  if (provider === 'anthropic' || (!provider && vars.ANTHROPIC_API_KEY)) {
    warn('文章は Claude で書きます（Claude のキーが入っているため）。OpenAI に切り替えるときは LLM_PROVIDER=openai を入れてください');
  } else {
    ok('文章は OpenAI で書きます');
  }

  // 2. シークレットの反映 ------------------------------------------
  step(2, 'Cloudflare にシークレットを反映');
  if (DRY) {
    skip('[dry-run] wrangler secret put をまとめて実行します');
  } else {
    // ★1本ずつ put すると遅いので bulk で入れる。値は標準入力経由で渡す
    const payload = {};
    for (const v of VARS) if (vars[v.key]) payload[v.key] = vars[v.key];
    try {
      wrangler(['secret', 'bulk'], { input: JSON.stringify(payload) });
      ok(`${Object.keys(payload).length} 件を反映しました`);
    } catch (e) {
      fail('反映に失敗しました。wrangler にログインしているか確認してください。');
      console.log(String(e.stderr ?? e.message).split('\n').slice(0, 6).join('\n'));
      process.exit(1);
    }
  }

  // 3. デプロイ ----------------------------------------------------
  step(3, 'マイグレーション適用 → デプロイ');
  if (DRY) {
    skip('[dry-run] npm run deploy を実行します');
  } else {
    try {
      // ★データベース「名」ではなく binding（DB）で指定する。
      //   名前は顧客ごとに変わるが、binding は wrangler.jsonc で固定されている
      const out = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
      ok(/No migrations to apply/.test(out) ? 'マイグレーションは最新でした' : 'マイグレーションを適用しました');
    } catch (e) {
      // ★ここで止める。適用せずにデプロイすると、顧客が触った瞬間に落ちる
      fail('マイグレーションに失敗しました。デプロイは中止します。');
      console.log(String(e.stderr ?? e.message).split('\n').slice(0, 10).join('\n'));
      process.exit(1);
    }
    try {
      const out = wrangler(['deploy']);
      ok('デプロイしました');
      // ★実際に払い出された URL を使う。
      //   Worker 名を変えると URL も変わるので、決め打ちにすると
      //   Webhook を古い URL に向けてしまう
      const found = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out);
      if (found && found[0] !== workerUrl) {
        workerUrl = found[0];
        ok(`URL を確認しました: ${workerUrl}`);
      }
      if (!workerUrl) {
        // ★推測で進めない。LINE を間違った Worker に向けるくらいなら止める
        fail('デプロイ後の URL を読み取れませんでした。');
        console.log('  Cloudflare の画面で Worker の URL を確認し、');
        console.log('  npm run setup -- --url https://〇〇.workers.dev で実行し直してください。');
        process.exit(1);
      }
    } catch (e) {
      const msg = String(e.stderr ?? e.message);
      fail('デプロイに失敗しました。');
      // ★新しい Cloudflare アカウントで必ず1回だけ起きる。
      //   英語のまま出すと何をすればいいのか分からないので、ここで案内する。
      if (/workers\.dev subdomain/i.test(msg)) {
        const url = /https:\/\/dash\.cloudflare\.com\/\S+/.exec(msg);
        console.log('');
        console.log('  このアカウントでは、まだ workers.dev のアドレスを登録していません。');
        console.log('  ブラウザで Cloudflare のダッシュボードを開き、好きな名前を1つ決めて登録してください（初回だけ）。');
        console.log('    左メニュー「コンピュート」→「Workers とページ」→「サブドメイン」の 変更');
        // ★エラーが出す URL は 404 になることがある（ダッシュボードの構成が変わるため）。
        //   参考として出すだけにして、必ずメニューの道順も併記する。
        if (url) console.log(`    参考リンク: ${url[0]}`);
        console.log('  登録したら、もう一度 npm run setup を実行してください。');
        console.log('');
      } else {
        console.log(msg.split('\n').slice(0, 10).join('\n'));
      }
      process.exit(1);
    }
  }

  // 4. LINE --------------------------------------------------------
  step(4, 'LINE の設定（Webhook・リッチメニュー）');
  try {
    const out = execFileSync('node', [resolve(ROOT, 'scripts/setup-line.mjs'), '--url', workerUrl,
      ...(DRY ? ['--dry-run'] : [])], { cwd: ROOT, encoding: 'utf8' });
    console.log(out.split('\n').filter((l) => l.trim()).map((l) => `  ${l}`).join('\n'));
  } catch (e) {
    warn('LINE の設定でつまずきました。');
    console.log(String(e.stdout ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
  }

  // 5. 死活確認 ----------------------------------------------------
  step(5, '動作確認');
  if (DRY) {
    skip('[dry-run] /health を確認します');
    printManual();
  } else {
    checkHealth();
  }
}

async function checkHealth() {
  // ★アドレスを登録した直後は、まだ届かないことがある。数回待ってから判定する。
  //   /health は未連携のとき 500 を返すが、それは「壊れている」ではないので
  //   本文を読んで区別する。ここを取り違えると、正しく出来ているのに
  //   「接続できませんでした」と出て顧客を不安にさせる（実際に起きた）。
  let body = null;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${workerUrl}/health`);
      body = await res.json();
      break;
    } catch {
      if (i < 4) {
        skip(`まだ応答がありません。10秒待って試します（${i + 1}/5）`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  if (!body) {
    warn('Worker に接続できませんでした。');
    warn('アドレスを登録した直後は数分かかることがあります。少し待って npm run setup をやり直してください。');
  } else {
    for (const [k, v] of Object.entries(body.checks ?? {})) {
      isHealthyCheck(k, v) ? ok(`${k}: ${v}`) : warn(`${k}: ${v}`);
    }
    // note 未連携だけが残っているのは、この時点では正常
    // ★llm（openai / anthropic）と thumbnail（enabled / disabled）は ok 以外の値で正常を表す。
    //   v === 'ok' だけで判定すると、正しく出来ているのに「足りないものがある」と出る
    const checks = body.checks ?? {};
    const onlyNote = !body.ok
      && String(checks.note_session ?? '').match(/^(none|agent\/not_connected)$/)
      && Object.entries(checks).every(([k, v]) => k === 'note_session' || isHealthyCheck(k, v));
    if (onlyNote) {
      ok('システムは動いています。あとは note と連携するだけです（下の3番）');
    } else if (!body.ok) {
      warn('まだ足りないものがあります（下の「残りの作業」を確認してください）');
    }
  }
  printManual();
}

// ── 人にしかできないこと ─────────────────────────────
function printManual() {
  console.log(`
━━ 残りの作業（ここだけは人の手が要ります）━━

  1. LINE Official Account Manager → 設定 → 応答設定
     「応答メッセージ」を オフ
     ※ ここに API がないため自動化できません。オンのままだと
       定型文と AI の返信が二重に届きます。

  2. LINE のトークに何か1通送る
     最初に送った人が「このアカウントの持ち主」として自動登録されます。
     （公開を承認できるのはこの人だけになります）

  3. note と連携する
     LINE で「note連携」と送る → 出たコードを、Chrome 拡張に貼る。
     拡張は全員共通の1つです（npm run ext:package で dist/note-connect.zip ができます）。
     Chrome に読み込んだら「▼ 接続先の設定」に次の URL を貼ってください:

       ${workerUrl || 'https://〇〇.workers.dev'}

     手順書: docs/onboarding-note-extension.md

  4. OpenAI の残高を確かめる
     platform.openai.com の Billing で、前払いのクレジット（最低5ドル）が入っていること。
     ★自動チャージ（Auto recharge）はオフのままを推奨します（使いすぎの歯止めになります）。

  すべて終わったら、LINE で「記事を作成する」を押して1本試してください。
`);
}

main();
