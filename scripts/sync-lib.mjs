/**
 * 自動更新（各環境が提供元の stable を取り込む）の「判断」の部品。
 *
 * ★ここには**判断だけ**を置く（ファイルを書かない・通信しない・コマンドを叩かない）。
 *   実行は scripts/sync-upstream.mjs、配布物の組み立ては scripts/build-template.mjs が、
 *   どちらも**この同じ関数**を呼ぶ。判定を2か所に書くと、いつか食い違って
 *   「組み立てたマニフェストと、同期が見るファイルの範囲が違う」事故になるため。
 *
 * ★方針は「迷ったら止める」。自動更新は、事故が全員に同時に広がる。
 *   取り込めるか分からないものは取り込まず、人（提供元）に回す。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * そのスクリプトが直接実行されたか（`node scripts/xxx.mjs`）。テストから import されたときは false。
 * ★実行したパスの実体（シンボリックリンクを解いたもの）で比べる。
 *   macOS の /tmp → /private/tmp のように、指定したパスと実体が違うと、文字列の比較では一致しないため
 */
export function isMain(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return importMetaUrl === pathToFileURL(argv1).href;
  }
}

/** 前回同期した版のファイルのハッシュ一覧（顧客リポジトリの直下） */
export const MANIFEST_FILE = '.upstream-manifest.json';
/** どこから取り込むか（顧客リポジトリの直下） */
export const UPSTREAM_FILE = '.upstream.json';
/** これがあると同期しない（顧客・提供元が止めたいとき） */
export const PIN_FILE = '.sync-pin';
/** 専用のマージで扱う設定ファイル（顧客の D1/KV の ID が入っている） */
export const WRANGLER_FILE = 'wrangler.json';

/**
 * 同期の対象外（パスの先頭一致・完全一致）。
 * ・.git / node_modules … 言うまでもなく触らない
 * ・.github … GITHUB_TOKEN ではワークフローを書き換えられない。顧客が貼った1行を守る
 * ・wrangler.json … 顧客の ID が入っている。mergeWrangler で専用に扱う
 * ・.gitignore … 顧客が足した除外を消さない
 * ・.upstream.json / マニフェスト / .sync-pin … 同期そのものの設定
 * ・拡張機能の zip … 組み立てのたびに中身が変わり、毎回「更新」になるため（設計書 3-1）
 */
const EXCLUDED_DIRS = ['.git', '.github', 'node_modules'];
const EXCLUDED_FILES = ['.gitignore', UPSTREAM_FILE, MANIFEST_FILE, PIN_FILE, WRANGLER_FILE, 'extension-package/note-connect.zip'];

/** そのパス（リポジトリ直下からの相対・区切りは /）を同期で上書き・削除してよいか */
export function isSyncTarget(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  const p = relPath.replace(/\\/g, '/');
  // ★`..` や絶対パスは対象にしない（リポジトリの外を書き換えない）
  if (p.startsWith('/') || p.split('/').includes('..')) return false;
  const first = p.split('/')[0];
  if (EXCLUDED_DIRS.includes(first)) return false;
  if (EXCLUDED_FILES.includes(p)) return false;
  // macOS が勝手に作るゴミは比べない
  if (/(^|\/)\.DS_Store$/.test(p)) return false;
  return true;
}

/** ファイルの中身の sha256（16進） */
export function hashFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** 文字列・Buffer の sha256（テスト用にも使う） */
export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * ★シンボリックリンクは扱わない（見つけたら例外）。
 *   リンクを辿って書き込むと、リポジトリの外や .github（ワークフロー）を書き換えられてしまうため。
 */
export class SymlinkError extends Error {
  constructor(relPath) {
    super(`シンボリックリンクがあります: ${relPath}`);
    this.path = relPath;
  }
}

/**
 * root から rel までの途中（rel 自身を含む）に、シンボリックリンクがあればそのパスを返す。無ければ null。
 * ★存在しない途中のフォルダは、そこで打ち切る（これから作る場所なので、リンクではない）
 */
export function findSymlinkInPath(rootDir, relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/');
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    let st;
    try { st = lstatSync(join(rootDir, cur)); } catch { return null; }
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}

/** 書き込み・削除の前に呼ぶ。途中にシンボリックリンクがあれば例外 */
export function assertNoSymlink(rootDir, relPath) {
  const hit = findSymlinkInPath(rootDir, relPath);
  if (hit) throw new SymlinkError(hit);
}

/** フォルダの中の、同期の対象になるファイルの相対パス一覧（並びは固定） */
export function listSyncFiles(rootDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        // node_modules 等の対象外フォルダがリンクなのは構わない（中に入らない）
        if (!prefix && EXCLUDED_DIRS.includes(name)) continue;
        throw new SymlinkError(rel);
      }
      if (st.isDirectory()) {
        if (!prefix && EXCLUDED_DIRS.includes(name)) continue;
        walk(abs, rel);
      } else if (st.isFile() && isSyncTarget(rel)) {
        out.push(rel);
      }
    }
  };
  walk(rootDir, '');
  return out.sort();
}

/**
 * ★package.json は「name 以外」で比べる。
 *   配備ボタンが、顧客の付けたプロジェクト名で package.json の name を書き換えるため（2026-10-26 実測）。
 *   name まで比べると、既定以外の名前を付けた顧客は初日から「手の跡」で同期が止まる。
 */
export const NAME_AGNOSTIC_FILE = 'package.json';

/**
 * 同期で比べるハッシュ（マニフェストの生成も3者比較も、必ずこれを通す＝判定は1か所）。
 * package.json は name を除いてキーを並べ替えた JSON で数える。読めない JSON はそのままの中身で数える
 */
export function hashSyncFile(rootDir, relPath) {
  const abs = join(rootDir, relPath);
  if (relPath === NAME_AGNOSTIC_FILE) {
    try {
      const pkg = JSON.parse(readFileSync(abs, 'utf8'));
      if (isPlainObject(pkg)) {
        const { name: _name, ...rest } = pkg;
        return hashContent(JSON.stringify(canonical(rest)));
      }
    } catch { /* 読めなければ下で、そのままの中身で数える */ }
  }
  return hashFile(abs);
}

/**
 * 上流の package.json に、顧客の name を残して書く中身を作る。
 * 顧客の package.json が読めない・name が無いときは、上流の中身そのまま
 */
export function mergePackageJson(customerText, upstreamText) {
  let name;
  try { const c = JSON.parse(customerText ?? ''); if (isPlainObject(c) && typeof c.name === 'string') name = c.name; } catch { /* 無視 */ }
  if (name === undefined) return upstreamText;
  const up = JSON.parse(upstreamText);
  return JSON.stringify({ ...up, name }, null, 2) + '\n';
}

/** フォルダの同期対象ファイルの { パス: ハッシュ } */
export function hashTree(rootDir) {
  const files = {};
  for (const rel of listSyncFiles(rootDir)) files[rel] = hashSyncFile(rootDir, rel);
  return files;
}

/** 指定したパスだけのハッシュ（無いファイルは入れない） */
export function hashPaths(rootDir, paths) {
  const files = {};
  for (const rel of paths) {
    if (!isSyncTarget(rel)) continue;
    assertNoSymlink(rootDir, rel);
    const abs = join(rootDir, rel);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isFile()) files[rel] = hashSyncFile(rootDir, rel);
  }
  return files;
}

/** 版の文字列を書き込むファイル（中身のハッシュからは外す。版を刻むと中身が変わるため） */
export const VERSION_FILE = 'src/version.ts';

/**
 * ★配布物の中身の全体ハッシュ（版の文字列に入れる）。
 *   範囲と数え方はマニフェストと同じ（hashTree＝同期の対象・package.json は name 除外）。
 *   ただし src/version.ts は外す（版を刻む前後で値が変わらないように）。
 *   パスを並べ替えてから数えるので、ファイルを作った順番には依らない。
 */
export function contentHashOf(files) {
  const lines = Object.keys(files).filter((p) => p !== VERSION_FILE).sort().map((p) => `${p}\0${files[p]}\n`);
  return hashContent(lines.join(''));
}

export function treeContentHash(rootDir) {
  return contentHashOf(hashTree(rootDir));
}

/**
 * マニフェストを作る（配布物の組み立てと、同期の成功時の書き直しの両方で使う）。
 * ★キーは並べ替えて書く。差分が「中身の変化」だけになるようにするため
 */
export function buildManifest(rootDir, version) {
  return { version: String(version), files: hashTree(rootDir) };
}

export function serializeManifest(manifest) {
  const files = {};
  for (const k of Object.keys(manifest.files).sort()) files[k] = manifest.files[k];
  return JSON.stringify({ version: manifest.version, files }, null, 2) + '\n';
}

/** マニフェストとして読めるか。読めなければ null（＝初期化が必要） */
export function parseManifest(text) {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || typeof m.version !== 'string') return null;
    if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) return null;
    for (const [k, v] of Object.entries(m.files)) {
      if (typeof k !== 'string' || typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return null;
    }
    return m;
  } catch {
    return null;
  }
}

/**
 * .upstream.json を読む。形が違えば null。
 * ★値はコマンドの引数になるので、使える文字を絞る（`-` で始まる値は弾く）
 */
export function parseUpstreamConfig(text) {
  try {
    const c = JSON.parse(text);
    if (!c || typeof c.repo !== 'string' || typeof c.branch !== 'string') return null;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo) || c.repo.startsWith('-')) return null;
    if (!/^[A-Za-z0-9_.\/-]+$/.test(c.branch) || c.branch.startsWith('-') || c.branch.includes('..')) return null;
    return { repo: c.repo, branch: c.branch };
  } catch {
    return null;
  }
}

/**
 * ★3者比較（前回の版 base／顧客の現物 local／上流の新しい版 upstream）。
 *
 *   上流にだけある        → 追加（顧客側に同名のファイルがあり、中身が違えば衝突）
 *   両方にある            → 顧客の現物が前回と一致なら上流で更新。
 *                           不一致（顧客が手で直した）なら衝突
 *   上流から消えた        → 顧客の現物が前回と一致なら削除。不一致なら衝突
 *
 * ★顧客の手の跡は上書きしない。衝突が1つでもあれば、呼び出し側が全体を止める。
 * 顧客が自分で足しただけのファイル（base にも upstream にも無い）は見ない・触らない。
 *
 * @param {{base: Record<string,string>, local: Record<string,string>, upstream: Record<string,string>}} input
 * @returns {{actions: {type: 'add'|'update'|'delete', path: string}[], conflicts: {path: string, reason: string}[]}}
 */
export function planSync({ base, local, upstream }) {
  const actions = [];
  const conflicts = [];
  const paths = [...new Set([...Object.keys(base), ...Object.keys(upstream)])].filter(isSyncTarget).sort();

  for (const p of paths) {
    const b = base[p];
    const l = local[p];
    const u = upstream[p];

    if (u !== undefined) {
      if (b === undefined) {
        if (l === undefined) actions.push({ type: 'add', path: p });
        else if (l !== u) conflicts.push({ path: p, reason: '同じ名前のファイルを、すでにお持ちです（上流で新しく増えたファイル）' });
        // l === u … すでに同じ中身。何もしない
      } else if (l === b) {
        if (u !== b) actions.push({ type: 'update', path: p });
      } else if (l === u) {
        // 顧客の現物が、すでに新しい版と同じ。何もしない
      } else if (l === undefined) {
        conflicts.push({ path: p, reason: '提供元のファイルが削除されています' });
      } else {
        conflicts.push({ path: p, reason: '提供元のファイルが書き換えられています' });
      }
    } else if (b !== undefined) {
      if (l === b) actions.push({ type: 'delete', path: p });
      else if (l !== undefined) conflicts.push({ path: p, reason: '書き換えられたファイルが、上流では削除されています' });
      // l === undefined … すでに無い。何もしない
    }
  }
  return { actions, conflicts };
}

/** マイグレーションのファイルか */
export function isMigration(relPath) {
  return /^migrations\/[^/]+\.sql$/.test(relPath);
}

/**
 * ★既存のマイグレーションは1バイトも変えない（追加のみ）。
 *   D1 は「適用済み」を名前で覚えている。中身を変えても流し直されず、
 *   環境ごとに表の形がずれる。消すと、新しく作る環境で表が足りなくなる。
 *
 * @param {Record<string,string>} before 前の版の { パス: ハッシュ }
 * @param {Record<string,string>} after  新しい版の { パス: ハッシュ }
 * @returns {{path: string, reason: string}[]} 問題（空なら OK）
 */
export function checkMigrations(before, after) {
  const problems = [];
  for (const [p, h] of Object.entries(before)) {
    if (!isMigration(p)) continue;
    if (after[p] === undefined) problems.push({ path: p, reason: 'マイグレーションが削除されています' });
    else if (after[p] !== h) problems.push({ path: p, reason: '既存のマイグレーションが書き換えられています' });
  }
  // ★新しいマイグレーションは、既存の最大番号より**後ろ**に限る。
  //   途中の番号に差し込むと、環境によって流れる順番が変わる（作った時期で表の形がずれる）
  const maxBefore = Math.max(-1, ...Object.keys(before).filter(isMigration).map(migrationNumber).filter((n) => n !== null));
  for (const p of Object.keys(after)) {
    if (!isMigration(p) || before[p] !== undefined) continue;
    const n = migrationNumber(p);
    if (n === null) problems.push({ path: p, reason: '新しいマイグレーションの名前が番号で始まっていません' });
    else if (n <= maxBefore) problems.push({ path: p, reason: `新しいマイグレーションの番号が、既存の最大（${maxBefore}）より後ろではありません` });
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path));
}

/** migrations/0012_xxx.sql → 12。番号で始まらなければ null */
export function migrationNumber(relPath) {
  const m = /^migrations\/(\d+)/.exec(relPath);
  return m ? Number(m[1]) : null;
}

// ── wrangler.json ──────────────────────────────────────────────

/**
 * 束縛（Worker から使う資源）を表す項目と、その中で**顧客固有の値**の欄。
 * 束縛の項目は、項目ごと（binding 名ごと）に「上流の設定＋顧客の ID」で組み立てる。
 * ★ここに無い束縛の種類は、顧客のものをそのまま残す（知らないものは触らない）
 */
const ARRAY_BINDINGS = {
  d1_databases: ['database_id', 'database_name', 'preview_database_id'],
  kv_namespaces: ['id', 'preview_id'],
  workflows: ['name'],
  r2_buckets: ['bucket_name', 'preview_bucket_name', 'jurisdiction'],
};
/** 中身を丸ごと顧客のまま残す束縛（ID の形が多様なため） */
const OPAQUE_BINDINGS = [
  'services', 'queues', 'durable_objects', 'vectorize', 'hyperdrive', 'analytics_engine_datasets',
  'ai', 'browser', 'send_email', 'mtls_certificates', 'dispatch_namespaces', 'images', 'version_metadata',
];
/** 顧客の環境に固有の、束縛以外の項目（顧客のものを残す） */
const CUSTOMER_KEYS = ['name', 'account_id', 'routes', 'route', 'workers_dev', 'preview_urls'];

/**
 * 束縛の集合（「種類:binding 名」の並べ替え済み一覧）。
 * ★これが顧客と上流で違う版は自動では取り込まない（D1 や KV を新しく作る作業が要るため）
 */
export function bindingSignatures(cfg) {
  const sig = [];
  const fromArray = (kind, arr) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) sig.push(`${kind}:${e && typeof e === 'object' ? (e.binding ?? e.name ?? '?') : String(e)}`);
  };
  for (const kind of Object.keys(ARRAY_BINDINGS)) fromArray(kind, cfg?.[kind]);
  for (const kind of OPAQUE_BINDINGS) {
    const v = cfg?.[kind];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) fromArray(kind, v);
    else if (kind === 'durable_objects') fromArray(kind, v.bindings);
    else if (kind === 'queues') {
      fromArray('queues.producers', v.producers);
      fromArray('queues.consumers', (v.consumers ?? []).map((c) => ({ binding: c?.queue })));
    } else if (typeof v === 'object') sig.push(`${kind}:${v.binding ?? '?'}`);
  }
  return sig.sort();
}

/**
 * ★束縛の集合のほかに、**顧客と上流で違ってはいけない**構造。違えば止める（理由の一覧を返す）。
 *   ・D1 の migrations_dir … 違うと、流すマイグレーションの置き場所が変わる
 *   ・Workflow の class_name / name … 上流の値がそのまま通ると、動いている Workflow の実体と食い違う
 */
export function wranglerStructureProblems(a, b) {
  const problems = [];
  const byBinding = (arr) => new Map((Array.isArray(arr) ? arr : []).map((e) => [e?.binding, e]));
  const d1a = byBinding(a?.d1_databases);
  for (const [binding, eb] of byBinding(b?.d1_databases)) {
    const ea = d1a.get(binding);
    if (ea && (ea.migrations_dir ?? 'migrations') !== (eb.migrations_dir ?? 'migrations')) {
      problems.push(`D1「${binding}」の migrations_dir が違います（${ea.migrations_dir ?? '既定'} → ${eb.migrations_dir ?? '既定'}）`);
    }
  }
  const wfa = byBinding(a?.workflows);
  for (const [binding, eb] of byBinding(b?.workflows)) {
    const ea = wfa.get(binding);
    if (!ea) continue;
    for (const f of ['class_name', 'name']) {
      if (ea[f] !== eb[f]) problems.push(`Workflow「${binding}」の ${f} が違います（${ea[f]} → ${eb[f]}）`);
    }
  }
  return problems;
}

/** 束縛の集合が同じか。違えば { onlyA, onlyB } を返す */
export function compareBindings(a, b) {
  const sa = bindingSignatures(a);
  const sb = bindingSignatures(b);
  const onlyA = sa.filter((s) => !sb.includes(s));
  const onlyB = sb.filter((s) => !sa.includes(s));
  // 同じ束縛が2つ書かれている（数の違い）も「違う」とみなす
  const same = onlyA.length === 0 && onlyB.length === 0 && sa.length === sb.length;
  return { same, onlyA, onlyB };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * ★wrangler.json の専用マージ。
 *   顧客のファイルを土台に、
 *   ・束縛（binding 名・種類）と顧客固有の値（database_id・database_name・KV の id・
 *     Worker の name・Workflow の name など）は**顧客のもの**
 *   ・cron・compatibility_date/flags・observability・その他の非 ID 項目は**上流のもの**
 *   ・vars は「上流の値に、顧客の値を上書き」（顧客が入れた値は消さない）
 *   ・顧客にだけある項目は残す
 *
 * @returns {{ok: true, merged: object, changed: boolean} | {ok: false, reason: string}}
 */
export function mergeWrangler(customer, upstream) {
  if (!isPlainObject(customer) || !isPlainObject(upstream)) {
    return { ok: false, reason: 'wrangler.json の形が想定と違います' };
  }
  const cmp = compareBindings(customer, upstream);
  if (!cmp.same) {
    const parts = [];
    if (cmp.onlyB.length) parts.push(`新しい版で増えた束縛: ${cmp.onlyB.join(', ')}`);
    if (cmp.onlyA.length) parts.push(`新しい版に無い束縛: ${cmp.onlyA.join(', ')}`);
    if (!parts.length) parts.push('同じ束縛が重複しています');
    return { ok: false, reason: `束縛（データベース等のつなぎ先）の組み合わせが変わる版です。個別の対応が必要です（${parts.join('／')}）` };
  }
  const structural = wranglerStructureProblems(customer, upstream);
  if (structural.length) {
    return { ok: false, reason: `つなぎ先の設定が変わる版です。個別の対応が必要です（${structural.join('／')}）` };
  }

  const merged = { ...customer };
  for (const [key, uv] of Object.entries(upstream)) {
    if (CUSTOMER_KEYS.includes(key) || OPAQUE_BINDINGS.includes(key)) {
      if (!(key in customer)) merged[key] = uv;     // 顧客に無いときだけ上流のものを入れる
      continue;
    }
    if (key in ARRAY_BINDINGS) {
      const idFields = ARRAY_BINDINGS[key];
      const mine = Array.isArray(customer[key]) ? customer[key] : [];
      merged[key] = (Array.isArray(uv) ? uv : []).map((ue) => {
        const ce = mine.find((x) => x?.binding === ue?.binding);
        const out = { ...ue };
        for (const f of idFields) {
          if (ce && f in ce) out[f] = ce[f];
          else if (ce) delete out[f];              // 顧客に無い ID 欄（上流のダミー値）は持ち込まない
        }
        return out;
      });
      continue;
    }
    if (key === 'vars' && isPlainObject(uv)) {
      merged.vars = { ...uv, ...(isPlainObject(customer.vars) ? customer.vars : {}) };
      continue;
    }
    merged[key] = uv;
  }
  const changed = JSON.stringify(canonical(merged)) !== JSON.stringify(canonical(customer));
  return { ok: true, merged, changed };
}

/** 比較用に、オブジェクトのキーを並べ替えた複製を作る（配列の順番はそのまま） */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

// ── 失敗の知らせ（GitHub Issue） ───────────────────────────────

/** 失敗の種類。Issue の重複判定に使う（同じ種類なら新しく作らずコメントで追記） */
export const FAILURE_KINDS = {
  'init-required': '自動更新の初期設定がありません',
  conflict: '手で直されたファイルがあります',
  migration: 'マイグレーションが書き換えられた版です',
  bindings: 'データベース等のつなぎ先が変わる版です',
  wrangler: 'wrangler.json を読めません',
  symlink: 'シンボリックリンクが見つかりました（安全のため扱いません）',
  checks: '新しい版の検査（インストール・テスト・型チェック）に失敗しました',
  upstream: '取り込み元の中身を読めません',
  push: '更新を保存（push）できませんでした',
};

/** Issue の本文に埋め込む目印（同じ種類の Issue を探すため） */
export function issueMarker(kind) {
  return `<!-- auto-update:${kind} -->`;
}

/**
 * 自動更新が立てた Issue か（本文に、どれかの種類の目印があるか）。
 * ★顧客が自分で作った Issue を閉じないため、知っている種類の目印だけを見る
 */
export function isAutoUpdateIssue(issue) {
  if (!issue || issue.pull_request || typeof issue.body !== 'string') return false;
  return Object.keys(FAILURE_KINDS).some((k) => issue.body.includes(issueMarker(k)));
}

/**
 * Issue のタイトルと本文を作る。
 * ★秘密を出さない（鍵・トークンはそもそも扱わない。コマンドの出力も貼らない＝ログへのリンクだけ）
 */
export function buildIssue({ kind, details = [], version, runUrl }) {
  const title = `自動更新が止まっています：${FAILURE_KINDS[kind] ?? kind}`;
  const lines = [
    issueMarker(kind),
    '## 自動更新が止まっています',
    '',
    `**原因**：${FAILURE_KINDS[kind] ?? kind}`,
    version ? `**取り込もうとした版**：${version}` : '',
    '',
    '**いまの状態**：このリポジトリのファイルは**何も変更していません**。システムはこれまでどおり動いています。',
    '',
  ];
  if (details.length) {
    lines.push('**詳しく**：');
    for (const d of details.slice(0, 30)) lines.push(`- ${d}`);
    if (details.length > 30) lines.push(`- ほか ${details.length - 30} 件`);
    lines.push('');
  }
  lines.push(
    '**次にやること**：提供元（このシステムを渡した担当者）にご連絡ください。この Issue の URL を伝えていただくのが早いです。',
    '',
    '- 自動更新は毎日1回、もう一度試します。原因が解消されるまで、同じ理由ではこの Issue に追記します。解消したら自動で閉じます',
    '- 止めておきたいときは、リポジトリの直下に `.sync-pin` という名前のファイル（中身は空で可）を作ってください',
  );
  if (runUrl) lines.push('', `実行の記録：${runUrl}`);
  return { title, body: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') };
}
