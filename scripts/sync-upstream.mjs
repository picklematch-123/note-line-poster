/**
 * 自動更新の実行本体。顧客リポジトリの GitHub Actions が毎日1回これを呼ぶ。
 *
 *   node scripts/sync-upstream.mjs
 *
 * 流れ:
 *   1. `.sync-pin` があれば何もしない（止められている）
 *   2. `.upstream.json`（取り込み元）と `.upstream-manifest.json`（前回の版）を読む
 *   3. 取り込み元の stable を `git clone --depth 1`（公開リポジトリなので認証不要）
 *   4. 3者比較・マイグレーション不変・束縛の集合・wrangler.json のマージを検査
 *   5. **作業用の複製**に新しい版を当て、`npm ci` → テスト → 型チェック
 *   6. すべて通ったときだけ、リポジトリに同じ変更を当てて commit → push
 *      （push すると Cloudflare の Workers Builds が自動で作り直す）
 *
 * ★1つでも落ちたら、リポジトリには**何も書かない**。理由を GitHub Issue に残して終わる。
 * ★鍵（GITHUB_TOKEN）の扱い: ワークフローは checkout で鍵を `.git/config` に残さない（persist-credentials: false）。
 *   起動したらすぐ環境変数から抜き、子プロセス（npm ci・テスト・git）には渡さない。
 *   使うのは push の1回だけで、そのときも環境変数 GIT_CONFIG_*（http.extraheader）で渡す
 *   ＝コマンドの引数・`.git/config`・ログのどこにも残らない。
 * ★判断は scripts/sync-lib.mjs に置いてある（ここは「実行」だけ）。
 *
 * 終了コード: 更新した・変更なし・止められている・取り込み元を取れなかった → 0／検査で止めた → 1
 *   （1 だと Actions が赤くなり、GitHub がリポジトリの持ち主に知らせる）
 * ★取り込み元を取れなかった（通信の失敗など）は次回に回すだけ。Issue も作らない。
 *   GitHub 側の一時的な不調で、顧客に毎回知らせが飛ぶのを避けるため。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_FILE, UPSTREAM_FILE, PIN_FILE, WRANGLER_FILE,
  parseManifest, parseUpstreamConfig, hashTree, hashPaths, planSync, checkMigrations,
  mergeWrangler, serializeManifest, buildIssue, issueMarker, isAutoUpdateIssue, SymlinkError, assertNoSymlink,
  NAME_AGNOSTIC_FILE, mergePackageJson, isMain,
} from './sync-lib.mjs';

/** 失敗（検査で止めた）を表す。kind は sync-lib の FAILURE_KINDS のキー */
class SyncStop extends Error {
  constructor(kind, details = [], version) {
    super(kind);
    this.kind = kind;
    this.details = details;
    this.version = version;
  }
}

/** 既定のコマンド実行（テストでは差し替える） */
export function defaultExec(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0 && !r.error, output: r.error ? String(r.error) : output };
}

/**
 * 同期を1回行う。
 *
 * @param {object} deps
 * @param {string} deps.cwd       顧客リポジトリの直下
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {(cmd: string, args: string[], opts: {cwd?: string}) => {ok: boolean, output: string} | Promise<{ok: boolean, output: string}>} [deps.exec]
 * @param {typeof fetch} [deps.fetch]
 * @param {(msg: string) => void} [deps.log]
 * @param {string} [deps.tmpRoot] 一時フォルダを作る場所
 * @returns {Promise<{status: 'pinned'|'no-change'|'updated'|'fetch-failed'|'failed', code: 0|1, kind?: string, version?: string, actions?: object[]}>}
 */
export async function runSync(deps) {
  const cwd = resolve(deps.cwd);
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? ((m) => console.log(m));
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  // ★push と Issue の1回ずつにだけ使う鍵。子プロセスに渡す環境変数からは抜く
  const token = env.GITHUB_TOKEN;
  const childEnv = { ...withoutSecrets(process.env), GIT_TERMINAL_PROMPT: '0' };
  const temps = [];
  const mkTemp = (label) => {
    const d = mkdtempSync(join(tmpRoot, `nlp-sync-${label}-`));
    temps.push(d);
    return d;
  };

  try {
    // ── 1. 止められているか ──
    if (existsSync(join(cwd, PIN_FILE))) {
      log(`自動更新は止められています（${PIN_FILE} があります）。何もしません。`);
      return { status: 'pinned', code: 0 };
    }

    // ── 2. 設定と前回の版 ──
    const cfgText = readIf(join(cwd, UPSTREAM_FILE));
    const cfg = cfgText === null ? null : parseUpstreamConfig(cfgText);
    if (!cfg) throw new SyncStop('init-required', [`${UPSTREAM_FILE} が無いか、形が違います`]);

    const manText = readIf(join(cwd, MANIFEST_FILE));
    const base = manText === null ? null : parseManifest(manText);
    if (!base) throw new SyncStop('init-required', [`${MANIFEST_FILE} が無いか、形が違います（提供元による初期化が必要です）`]);

    // ── 3. 取り込み元を取る ──
    const upDir = join(mkTemp('upstream'), 'repo');
    const clone = await exec('git', ['clone', '--depth', '1', '--branch', cfg.branch, `https://github.com/${cfg.repo}.git`, upDir], { cwd, env: childEnv });
    if (!clone.ok) {
      log(`取り込み元（${cfg.repo} の ${cfg.branch}）を取得できませんでした。次回にもう一度試します。`);
      // GitHub Actions の画面に黄色の注意として出す（失敗にはしない）
      // ★日付を入れる（連続で取れていないかを、Actions の一覧で見分けられるように）
      log(`::warning::自動更新: ${todayJst()} 取り込み元を取得できませんでした（次回に再試行）`);
      return { status: 'fetch-failed', code: 0 };
    }

    const upManText = readIf(join(upDir, MANIFEST_FILE));
    const upMan = upManText === null ? null : parseManifest(upManText);
    if (!upMan) throw new SyncStop('upstream', [`取り込み元に ${MANIFEST_FILE} がありません`]);
    const version = upMan.version;

    // ★上流のハッシュは、取り込み元のマニフェストを信じずに**自分で数え直す**
    let upstream;
    let local;
    try {
      upstream = hashTree(upDir);
      local = hashPaths(cwd, [...new Set([...Object.keys(base.files), ...Object.keys(upstream), MANIFEST_FILE, WRANGLER_FILE])]
        .filter((p) => p !== MANIFEST_FILE && p !== WRANGLER_FILE));
      // 書き込む先（マニフェスト・wrangler.json）もリンクでないこと
      assertNoSymlink(cwd, MANIFEST_FILE);
      assertNoSymlink(cwd, WRANGLER_FILE);
    } catch (e) {
      if (e instanceof SymlinkError) throw new SyncStop('symlink', [e.message], version);
      throw e;
    }

    // ── 4. 検査（手の跡・マイグレーション・束縛） ──
    const plan = planSync({ base: base.files, local, upstream });
    if (plan.conflicts.length) {
      throw new SyncStop('conflict', plan.conflicts.map((c) => `${c.path}：${c.reason}`), version);
    }

    const mig = checkMigrations(base.files, upstream);
    if (mig.length) throw new SyncStop('migration', mig.map((m) => `${m.path}：${m.reason}`), version);

    // 書き込み・削除する先の途中にリンクがないか（顧客の側）
    for (const a of plan.actions) {
      try { assertNoSymlink(cwd, a.path); } catch (e) {
        if (e instanceof SymlinkError) throw new SyncStop('symlink', [e.message], version);
        throw e;
      }
    }

    let wranglerOut = null;
    const upWrangler = readJson(join(upDir, WRANGLER_FILE));
    const myWrangler = readJson(join(cwd, WRANGLER_FILE));
    if (!upWrangler.ok) throw new SyncStop('upstream', [`取り込み元の ${WRANGLER_FILE} を読めません`], version);
    if (!myWrangler.ok) throw new SyncStop('wrangler', [`${WRANGLER_FILE} が無いか、JSON として読めません`], version);
    const merged = mergeWrangler(myWrangler.value, upWrangler.value);
    if (!merged.ok) throw new SyncStop('bindings', [merged.reason], version);
    if (merged.changed) wranglerOut = JSON.stringify(merged.merged, null, 2) + '\n';

    if (plan.actions.length === 0 && wranglerOut === null) {
      log(`変更はありません（取り込み元の版: ${version}）。`);
      await resolveIssues({ version, env: { ...env, GITHUB_TOKEN: token }, fetchImpl: deps.fetch ?? globalThis.fetch, log });
      return { status: 'no-change', code: 0, version };
    }

    // ── 5. 作業用の複製に当てて、インストール・テスト・型チェック ──
    const stage = join(mkTemp('stage'), 'repo');
    copyRepo(cwd, stage);
    applyChanges(stage, upDir, plan.actions, wranglerOut);
    for (const [cmd, args, label] of [
      ['npm', ['ci', '--no-audit', '--no-fund'], 'npm ci'],
      ['npx', ['vitest', 'run'], 'テスト（vitest）'],
      ['npx', ['tsc', '--noEmit'], '型チェック（tsc）'],
    ]) {
      log(`検査: ${label} …`);
      // ★検査のコマンド（依存パッケージのインストール・テスト）には GITHUB_TOKEN を渡さない。
      //   書き込み権限のある鍵を、外から取ってきたパッケージの手の届く所に置かないため
      const r = await exec(cmd, args, { cwd: stage, env: childEnv });
      if (!r.ok) {
        // ★出力はログ（Actions の画面）にだけ出す。Issue には貼らない
        log(tail(r.output, 80));
        throw new SyncStop('checks', [`${label} が通りませんでした（詳しくは実行の記録をご覧ください）`], version);
      }
    }

    // ── 6. 本物に当てて commit → push ──
    // ★失敗したら元に戻せるよう、触るファイルの中身と、いまの HEAD を先に控えておく
    //   （HEAD~1 に頼らない。浅い clone＝depth 1 では親コミットが無いため）
    const touched = [...plan.actions.map((a) => a.path), MANIFEST_FILE, ...(wranglerOut ? [WRANGLER_FILE] : [])];
    const snapshot = touched.map((p) => [p, existsSync(join(cwd, p)) ? readFileSync(join(cwd, p)) : null]);
    const git = async (args, extraEnv = {}) => exec('git', args, { cwd, env: { ...childEnv, ...extraEnv } });
    const head = await git(['rev-parse', 'HEAD']);
    const headBefore = head.ok ? String(head.output).trim().split('\n').pop() : '';
    if (!/^[0-9a-f]{40}$/.test(headBefore)) {
      throw new SyncStop('push', ['いまのコミットを確かめられませんでした（何も変更していません）'], version);
    }
    try {
      applyChanges(cwd, upDir, plan.actions, wranglerOut);
      writeFileSync(join(cwd, MANIFEST_FILE), serializeManifest({ version, files: upstream }));

      const add = await git(['add', '-A', '--', ...touched]);
      const commit = add.ok ? await git([
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `chore: 自動更新 ${version}`,
      ]) : null;
      // ★鍵はここで初めて使う（環境変数で渡す。引数にも .git/config にも書かない）
      const push = commit?.ok ? await git(['push', 'origin', 'HEAD'], pushAuthEnv(token, childEnv)) : null;
      if (!push?.ok) {
        log(redact(tail(String((push ?? commit ?? add).output ?? ''), 40), token));
        throw new SyncStop('push', ['変更の保存（commit / push）に失敗しました。リポジトリの保護設定や権限をご確認ください'], version);
      }
    } catch (e) {
      // ★本物に当てた変更を元に戻す（「失敗したら何も変えない」を守る）
      await git(['reset', '-q', '--soft', headBefore]);
      await git(['reset', '-q', '--', ...touched]);
      restoreSnapshot(cwd, snapshot);
      throw e;
    }

    log(`更新しました: ${version}（${summarize(plan.actions)}${wranglerOut ? '・wrangler.json' : ''}）`);
    await resolveIssues({ version, env: { ...env, GITHUB_TOKEN: token }, fetchImpl: deps.fetch ?? globalThis.fetch, log });
    return { status: 'updated', code: 0, version, actions: plan.actions };
  } catch (e) {
    if (!(e instanceof SyncStop)) throw e;
    log(`自動更新を止めました: ${e.kind}`);
    for (const d of e.details) log(`  - ${d}`);
    await reportFailure({ kind: e.kind, details: e.details, version: e.version, env: { ...env, GITHUB_TOKEN: token }, fetchImpl: deps.fetch ?? globalThis.fetch, log });
    return { status: 'failed', code: 1, kind: e.kind, version: e.version };
  } finally {
    for (const d of temps) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 片付けに失敗しても結果は変わらない */ }
    }
  }
}

/**
 * 失敗を GitHub Issue に残す。
 * ★同じ種類で開いている Issue があれば、新しく作らずコメントで追記する（毎日 Issue が増えないように）
 * ★Issue を作れなくても、同期の結果（失敗＝何も変えていない）は変わらない。ログに残して終わる
 */
/** GitHub API を呼ぶための情報。GitHub の外（鍵やリポジトリ名が無い）なら null */
function githubContext(env, fetchImpl) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo || typeof fetchImpl !== 'function') return null;
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  return {
    runUrl,
    api: `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'note-line-poster-auto-update',
    },
  };
}

/**
 * 同期が成功したとき（更新した・変更なし）に、自動更新が立てた Issue を「解消しました」とコメントして閉じる。
 * ★閉じるのは目印（<!-- auto-update:… -->）を持つものだけ。顧客が自分で作った Issue は触らない
 * ★見るのは開いている最初の100件（重複判定と同じ範囲）
 * ★閉じられなくても（権限・通信）、同期の成功は変えない。警告をログに出して終わる
 * ★止められている日（.sync-pin）・取り込み元が取れなかった日は呼ばない（解消していないため）
 */
export async function resolveIssues({ version, env, fetchImpl, log = () => {} }) {
  const gh = githubContext(env, fetchImpl);
  if (!gh) return { action: 'skipped', closed: [] };
  const closed = [];
  try {
    const listRes = await fetchImpl(`${gh.api}/issues?state=open&per_page=100`, { headers: gh.headers });
    if (!listRes.ok) throw new Error(`Issue 一覧の取得に失敗（${listRes.status}）`);
    const issues = await listRes.json();
    const targets = Array.isArray(issues) ? issues.filter(isAutoUpdateIssue) : [];
    const body = [
      `自動更新が解消しました（取り込んだ版：${version}）。この Issue を閉じます。`,
      gh.runUrl ? `\n実行の記録：${gh.runUrl}` : '',
    ].join('');
    for (const issue of targets) {
      const c = await fetchImpl(`${gh.api}/issues/${issue.number}/comments`, { method: 'POST', headers: gh.headers, body: JSON.stringify({ body }) });
      if (!c.ok) throw new Error(`Issue #${issue.number} へのコメントに失敗（${c.status}）`);
      const res = await fetchImpl(`${gh.api}/issues/${issue.number}`, {
        method: 'PATCH', headers: gh.headers, body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      });
      if (!res.ok) throw new Error(`Issue #${issue.number} を閉じられませんでした（${res.status}）`);
      closed.push(issue.number);
      log(`解消した Issue #${issue.number} を閉じました`);
    }
    return { action: closed.length ? 'closed' : 'none', closed };
  } catch (e) {
    log(`::warning::自動更新: 解消した Issue を閉じられませんでした（${String(e?.message ?? e)}）。同期そのものは成功しています`);
    return { action: 'error', closed };
  }
}

export async function reportFailure({ kind, details, version, env, fetchImpl, log = () => {} }) {
  const gh = githubContext(env, fetchImpl);
  if (!gh) {
    log('（GitHub の外で動いているため、Issue は作りません）');
    return { action: 'skipped' };
  }
  const { runUrl, api, headers } = gh;
  const { title, body } = buildIssue({ kind, details, version, runUrl });
  try {
    const listRes = await fetchImpl(`${api}/issues?state=open&per_page=100`, { headers });
    if (!listRes.ok) throw new Error(`Issue 一覧の取得に失敗（${listRes.status}）`);
    const issues = await listRes.json();
    const existing = Array.isArray(issues)
      ? issues.find((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(issueMarker(kind)))
      : undefined;
    if (existing) {
      const res = await fetchImpl(`${api}/issues/${existing.number}/comments`, {
        method: 'POST', headers, body: JSON.stringify({ body: `もう一度試しましたが、同じ理由で止まりました。\n\n${body}` }),
      });
      if (!res.ok) throw new Error(`コメントの追記に失敗（${res.status}）`);
      log(`既存の Issue #${existing.number} に追記しました`);
      return { action: 'commented', number: existing.number };
    }
    const res = await fetchImpl(`${api}/issues`, { method: 'POST', headers, body: JSON.stringify({ title, body }) });
    if (!res.ok) throw new Error(`Issue の作成に失敗（${res.status}）`);
    const created = await res.json().catch(() => ({}));
    log(`Issue を作りました${created?.number ? ` #${created.number}` : ''}`);
    return { action: 'created', number: created?.number };
  } catch (e) {
    log(`Issue を残せませんでした: ${String(e?.message ?? e)}`);
    return { action: 'error' };
  }
}

// ── 小道具 ──────────────────────────────────────────────

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

/** リポジトリを作業用に複製する（.git と node_modules は持っていかない） */
function copyRepo(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === '.git' || name === 'node_modules') continue;
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

/** 計画どおりにファイルを足す・置き換える・消す */
function applyChanges(dir, upDir, actions, wranglerOut) {
  for (const a of actions) {
    const target = join(dir, a.path);
    if (a.type === 'delete') {
      if (existsSync(target)) unlinkSync(target);
    } else if (a.path === NAME_AGNOSTIC_FILE) {
      // ★package.json は顧客の name を残して書く（配備ボタンが顧客の名前に書き換えているため）
      const mine = existsSync(target) ? readFileSync(target, 'utf8') : null;
      writeFileSync(target, mergePackageJson(mine, readFileSync(join(upDir, a.path), 'utf8')));
    } else {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(upDir, a.path), target);
    }
  }
  if (wranglerOut !== null) writeFileSync(join(dir, WRANGLER_FILE), wranglerOut);
}

/** 控えておいた中身に戻す（無かったファイルは消す） */
function restoreSnapshot(dir, snapshot) {
  for (const [p, content] of snapshot) {
    const target = join(dir, p);
    if (content === null) {
      if (existsSync(target)) unlinkSync(target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}

/**
 * push のときだけ渡す環境変数。git の設定を環境変数（GIT_CONFIG_COUNT/KEY/VALUE）で与えるので、
 * コマンドの引数（ps で見える）にも `.git/config` にも残らない。鍵が無ければ何も足さない
 */
export function pushAuthEnv(token, baseEnv = {}) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  // ★すでに GIT_CONFIG_* が使われている環境では、その後ろに足す（既存の設定を消さない）
  const n = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? '0', 10);
  const i = Number.isInteger(n) && n > 0 ? n : 0;
  return {
    GIT_CONFIG_COUNT: String(i + 1),
    [`GIT_CONFIG_KEY_${i}`]: 'http.https://github.com/.extraheader',
    [`GIT_CONFIG_VALUE_${i}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/** ログに出す前に、鍵（とその base64）を伏せる */
function redact(text, token) {
  if (!token) return text;
  const b = Buffer.from(`x-access-token:${token}`).toString('base64');
  return String(text).split(token).join('***').split(b).join('***');
}

/** 今日の日付（日本時間・YYYY-MM-DD） */
function todayJst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** 環境変数から、GitHub の鍵を抜いた複製 */
export function withoutSecrets(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(k)) delete out[k];
  }
  return out;
}

function summarize(actions) {
  const n = (t) => actions.filter((a) => a.type === t).length;
  return `追加 ${n('add')}・更新 ${n('update')}・削除 ${n('delete')}`;
}

function tail(text, lines) {
  return String(text ?? '').split('\n').slice(-lines).join('\n');
}

async function main() {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // ★鍵は起動直後に環境変数から抜く（以後、どの子プロセスにも引き継がれない）
  const env = { ...process.env };
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) delete process.env[k];
  const result = await runSync({ cwd, env });
  process.exitCode = result.code;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    // 想定外の例外（バグ）は、握りつぶさず赤くする
    console.error(e);
    process.exitCode = 1;
  });
}
