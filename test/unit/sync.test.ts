/**
 * 自動更新（各環境が提供元の stable を取り込む）の判断と実行を固定する。
 *
 * ★自動更新は、事故が全員に同時に広がる。ここで守っているのは:
 *   ・顧客の手の跡（手で直したファイル）を上書きしない（衝突なら全体を止める）
 *   ・既存のマイグレーションは1バイトも変えない／束縛（D1・KV・Workflow）の組み合わせが変わる版は取り込まない
 *   ・wrangler.json の顧客の ID を守る
 *   ・検査が1つでも落ちたら、リポジトリに**何も書かない**
 *
 * ★ネットワーク・実プロセスは使わない（git clone / npm / push は差し替え、ファイルは一時フォルダ）。
 * ★このテストは配布物にも入り、各環境の同期の検査（vitest）でも走る。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isSyncTarget, planSync, checkMigrations, mergeWrangler, compareBindings, bindingSignatures,
  hashContent, hashTree, buildManifest, serializeManifest, parseManifest, parseUpstreamConfig,
  listSyncFiles, buildIssue, issueMarker, SymlinkError, hashSyncFile, mergePackageJson, migrationNumber,
} from '../../scripts/sync-lib.mjs';
import { runSync, reportFailure, withoutSecrets, pushAuthEnv } from '../../scripts/sync-upstream.mjs';
import { VERSION } from '../../src/version';

const h = (s: string) => hashContent(s);

// ── 3者比較 ─────────────────────────────────────────────────
describe('planSync（前回の版／顧客の現物／上流の新しい版）', () => {
  it('上流にだけある → 追加', () => {
    const r = planSync({ base: {}, local: {}, upstream: { 'src/new.ts': h('n') } });
    expect(r.actions).toEqual([{ type: 'add', path: 'src/new.ts' }]);
    expect(r.conflicts).toEqual([]);
  });

  it('両方にあり、顧客の現物が前回と同じ → 上流で更新', () => {
    const r = planSync({ base: { 'a.ts': h('1') }, local: { 'a.ts': h('1') }, upstream: { 'a.ts': h('2') } });
    expect(r.actions).toEqual([{ type: 'update', path: 'a.ts' }]);
  });

  it('★顧客が手で直したファイル → 衝突（上書きしない）', () => {
    const r = planSync({ base: { 'a.ts': h('1') }, local: { 'a.ts': h('mine') }, upstream: { 'a.ts': h('2') } });
    expect(r.actions).toEqual([]);
    expect(r.conflicts.map((c) => c.path)).toEqual(['a.ts']);
  });

  it('★上流で中身が変わっていなくても、顧客が直していれば衝突（手の跡を見つける）', () => {
    const r = planSync({ base: { 'a.ts': h('1') }, local: { 'a.ts': h('mine') }, upstream: { 'a.ts': h('1') } });
    expect(r.conflicts).toHaveLength(1);
  });

  it('顧客が消したファイル → 衝突', () => {
    const r = planSync({ base: { 'a.ts': h('1') }, local: {}, upstream: { 'a.ts': h('1') } });
    expect(r.conflicts.map((c) => c.path)).toEqual(['a.ts']);
  });

  it('上流から消えた・顧客の現物は前回のまま → 削除', () => {
    const r = planSync({ base: { 'old.ts': h('1') }, local: { 'old.ts': h('1') }, upstream: {} });
    expect(r.actions).toEqual([{ type: 'delete', path: 'old.ts' }]);
  });

  it('★上流から消えた・顧客が直していた → 衝突（削除しない）', () => {
    const r = planSync({ base: { 'old.ts': h('1') }, local: { 'old.ts': h('mine') }, upstream: {} });
    expect(r.actions).toEqual([]);
    expect(r.conflicts.map((c) => c.path)).toEqual(['old.ts']);
  });

  it('上流で新しく増えた名前のファイルを、顧客がすでに別の中身で持っている → 衝突', () => {
    const r = planSync({ base: {}, local: { 'x.ts': h('mine') }, upstream: { 'x.ts': h('up') } });
    expect(r.conflicts).toHaveLength(1);
  });

  it('変更なし → 何もしない（同じ中身・すでに消えている・顧客がすでに新しい版と同じ）', () => {
    const r = planSync({
      base: { 'a.ts': h('1'), 'gone.ts': h('g'), 'b.ts': h('1') },
      local: { 'a.ts': h('1'), 'b.ts': h('2') },
      upstream: { 'a.ts': h('1'), 'b.ts': h('2') },
    });
    expect(r.actions).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('顧客が自分で足しただけのファイル（前回にも上流にも無い）は見ない・触らない', () => {
    const r = planSync({ base: {}, local: { 'my-notes.md': h('x') }, upstream: {} });
    expect(r).toEqual({ actions: [], conflicts: [] });
  });

  it('★対象外のパス（wrangler.json・.github・.gitignore 等）は、上流にあっても計画に入らない', () => {
    const r = planSync({
      base: {},
      local: {},
      upstream: { 'wrangler.json': h('w'), '.github/workflows/x.yml': h('y'), '.gitignore': h('g'), '.upstream.json': h('u') },
    });
    expect(r.actions).toEqual([]);
  });
});

describe('isSyncTarget（同期で上書き・削除してよい範囲）', () => {
  it('★対象外: .git / .github / node_modules / wrangler.json / .gitignore / 設定 / マニフェスト / .sync-pin', () => {
    for (const p of ['.git/config', '.github/workflows/auto-update.yml', 'node_modules/x/index.js', 'wrangler.json',
      '.gitignore', '.upstream.json', '.upstream-manifest.json', '.sync-pin', 'extension-package/note-connect.zip',
      '../outside.txt', '/etc/passwd', 'a/.DS_Store']) {
      expect(isSyncTarget(p), p).toBe(false);
    }
  });
  it('普通のファイルは対象', () => {
    for (const p of ['src/index.ts', 'migrations/0001_init.sql', 'package.json', 'docs/setup-guide.html', 'scripts/sync-upstream.mjs']) {
      expect(isSyncTarget(p), p).toBe(true);
    }
  });
});

// ── マイグレーション ─────────────────────────────────────────
describe('checkMigrations（既存のマイグレーションは追加のみ）', () => {
  const before = { 'migrations/0001_init.sql': h('a'), 'migrations/0002_x.sql': h('b'), 'src/a.ts': h('s') };
  it('追加だけなら OK（マイグレーション以外の変更は見ない）', () => {
    expect(checkMigrations(before, { ...before, 'migrations/0003_new.sql': h('c'), 'src/a.ts': h('changed') })).toEqual([]);
  });
  it('★既存の書き換えは NG', () => {
    const r = checkMigrations(before, { ...before, 'migrations/0002_x.sql': h('B') });
    expect(r.map((p) => p.path)).toEqual(['migrations/0002_x.sql']);
  });
  it('★新しいマイグレーションは既存の最大番号より後ろに限る（途中の番号の差し込みは NG）', () => {
    const b = { 'migrations/0001_a.sql': h('a'), 'migrations/0003_c.sql': h('c') };
    expect(checkMigrations(b, { ...b, 'migrations/0004_d.sql': h('d') })).toEqual([]);
    expect(checkMigrations(b, { ...b, 'migrations/0002_b.sql': h('b') }).map((p) => p.path)).toEqual(['migrations/0002_b.sql']);
    expect(checkMigrations(b, { ...b, 'migrations/0003_dup.sql': h('x') }).map((p) => p.path)).toEqual(['migrations/0003_dup.sql']);
    expect(checkMigrations(b, { ...b, 'migrations/new.sql': h('x') }).map((p) => p.path)).toEqual(['migrations/new.sql']);
    // 既存が無い（最初の版）なら、どの番号でもよい
    expect(checkMigrations({}, { 'migrations/0001_a.sql': h('a') })).toEqual([]);
    expect(migrationNumber('migrations/0012_x.sql')).toBe(12);
  });

  it('★削除は NG', () => {
    const { 'migrations/0001_init.sql': _gone, ...rest } = before;
    expect(checkMigrations(before, rest).map((p) => p.path)).toEqual(['migrations/0001_init.sql']);
  });
});

// ── wrangler.json ───────────────────────────────────────────
describe('mergeWrangler（顧客の ID は守り、非 ID 項目は上流に合わせる）', () => {
  const upstream = {
    name: 'note-line-poster',
    main: 'src/index.ts',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true },
    d1_databases: [{ binding: 'DB', database_name: 'note-line-poster', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
    kv_namespaces: [{ binding: 'KV', id: '0'.repeat(32) }],
    workflows: [{ binding: 'GENERATE', name: 'generate-article', class_name: 'GenerateArticleWorkflow' }],
    triggers: { crons: ['0 0 * * *', '*/10 * * * *'] },
  };
  const customer = {
    name: 'my-poster',
    main: 'src/index.ts',
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true },
    d1_databases: [{ binding: 'DB', database_name: 'my-db', database_id: '11111111-2222-3333-4444-555555555555', migrations_dir: 'migrations' }],
    kv_namespaces: [{ binding: 'KV', id: 'a'.repeat(32) }],
    workflows: [{ binding: 'GENERATE', name: 'generate-article', class_name: 'GenerateArticleWorkflow' }],
    triggers: { crons: ['0 0 * * *', '*/15 * * * *'] },
    vars: { SOMETHING: 'mine' },
  };

  it('★顧客の ID・名前は保持、cron・互換日付は上流に', () => {
    const r = mergeWrangler(customer, upstream);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.merged as typeof customer;
    expect(m.name).toBe('my-poster');
    expect(m.d1_databases[0].database_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(m.d1_databases[0].database_name).toBe('my-db');
    expect(m.kv_namespaces[0].id).toBe('a'.repeat(32));
    expect(m.workflows[0].name).toBe('generate-article');
    expect(m.workflows[0].class_name).toBe('GenerateArticleWorkflow');
    expect(m.compatibility_date).toBe('2026-10-01');
    expect(m.triggers.crons).toEqual(['0 0 * * *', '*/10 * * * *']);
    expect(m.vars).toEqual({ SOMETHING: 'mine' });      // 顧客にだけある項目は残す
    expect(r.changed).toBe(true);
  });

  it('★束縛の集合が違う版（D1 が1つ増える）は止める', () => {
    const up = { ...upstream, d1_databases: [...upstream.d1_databases, { binding: 'DB2', database_name: 'x', database_id: '0' }] };
    const r = mergeWrangler(customer, up);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/d1_databases:DB2/);
  });

  it('★束縛の名前が変わる版・種類が変わる版も止める', () => {
    expect(mergeWrangler(customer, { ...upstream, kv_namespaces: [{ binding: 'CACHE', id: '0' }] }).ok).toBe(false);
    expect(mergeWrangler(customer, { ...upstream, kv_namespaces: [], r2_buckets: [{ binding: 'KV', bucket_name: 'b' }] }).ok).toBe(false);
  });

  it('★Workflow の class_name / name、D1 の migrations_dir が違う版は止める（上流の値をそのまま通さない）', () => {
    const wf = (f: string, v: string) => ({ ...upstream, workflows: [{ ...upstream.workflows[0], [f]: v }] });
    for (const [up, word] of [[wf('class_name', 'NewWorkflow'), 'class_name'], [wf('name', 'renamed'), 'name'],
      [{ ...upstream, d1_databases: [{ ...upstream.d1_databases[0], migrations_dir: 'db/migrations' }] }, 'migrations_dir']] as const) {
      const r = mergeWrangler(customer, up);
      expect(r.ok, word).toBe(false);
      if (!r.ok) expect(r.reason).toContain(word);
    }
  });

  it('束縛の並び順が違うだけなら止めない（ID は binding 名で対応づける）', () => {
    const c2 = { ...customer, d1_databases: [{ binding: 'B', database_id: 'idB', database_name: 'nB' }, { binding: 'A', database_id: 'idA', database_name: 'nA' }] };
    const u2 = { ...upstream, d1_databases: [{ binding: 'A', database_id: '0', database_name: 'x' }, { binding: 'B', database_id: '0', database_name: 'y' }] };
    const r = mergeWrangler(c2, u2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d1 = (r.merged as { d1_databases: { binding: string; database_id: string }[] }).d1_databases;
    expect(d1.find((d) => d.binding === 'A')?.database_id).toBe('idA');
    expect(d1.find((d) => d.binding === 'B')?.database_id).toBe('idB');
  });

  it('上流で増えた非 ID の項目（新キー）は取り込む', () => {
    const r = mergeWrangler(customer, { ...upstream, limits: { cpu_ms: 50000 } });
    expect(r.ok && (r.merged as Record<string, unknown>).limits).toEqual({ cpu_ms: 50000 });
  });

  it('vars は上流の値に顧客の値を重ねる（顧客の値を消さない）', () => {
    const r = mergeWrangler(customer, { ...upstream, vars: { NEW_FLAG: '1', SOMETHING: 'upstream' } });
    expect(r.ok && (r.merged as { vars: unknown }).vars).toEqual({ NEW_FLAG: '1', SOMETHING: 'mine' });
  });

  it('中身が同じなら changed=false（無駄なコミットを作らない）', () => {
    const same = { ...customer, compatibility_date: upstream.compatibility_date, triggers: upstream.triggers };
    const r = mergeWrangler(same, upstream);
    expect(r.ok && r.changed).toBe(false);
  });

  it('束縛の集合は並べ替えて比べる', () => {
    expect(bindingSignatures(customer)).toEqual(['d1_databases:DB', 'kv_namespaces:KV', 'workflows:GENERATE']);
    expect(compareBindings(customer, upstream).same).toBe(true);
  });
});

describe('設定ファイルの読み取り', () => {
  it('マニフェストの形が違えば null（＝初期化が必要）', () => {
    expect(parseManifest('{}')).toBeNull();
    expect(parseManifest('not json')).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 'v', files: { a: 'short' } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 'v', files: { a: h('x') } }))).not.toBeNull();
  });
  it('★.upstream.json はコマンドの引数になるので、使える文字を絞る', () => {
    expect(parseUpstreamConfig(JSON.stringify({ repo: 'owner/name', branch: 'stable' }))).toEqual({ repo: 'owner/name', branch: 'stable' });
    for (const bad of [{ repo: 'owner/name; rm -rf /', branch: 'stable' }, { repo: 'owner/name', branch: '--upload-pack=x' },
      { repo: 'noslash', branch: 'stable' }, { repo: 'o/n', branch: 'a/../b' }]) {
      expect(parseUpstreamConfig(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('package.json は name 以外で比べる（配備ボタンが name を書き換えるため）', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'nlp-pkg-'));
  it('★マニフェストのハッシュは name に依らない（キーの順番にも依らない）', () => {
    const a = dir(); const b = dir();
    try {
      writeFileSync(join(a, 'package.json'), JSON.stringify({ name: 'note-line-poster', version: '1', dependencies: { x: '1' } }));
      writeFileSync(join(b, 'package.json'), JSON.stringify({ dependencies: { x: '1' }, version: '1', name: 'my-poster-2' }, null, 2));
      expect(hashSyncFile(a, 'package.json')).toBe(hashSyncFile(b, 'package.json'));
      expect(buildManifest(a, 'v').files['package.json']).toBe(buildManifest(b, 'v').files['package.json']);
      writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'my-poster-2', version: '2', dependencies: { x: '1' } }));
      expect(hashSyncFile(a, 'package.json')).not.toBe(hashSyncFile(b, 'package.json'));
    } finally {
      rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
    }
  });
  it('ほかのファイルは中身そのままで比べる（name の除外は package.json だけ）', () => {
    const a = dir();
    try {
      writeFileSync(join(a, 'x.json'), '{"name":"a"}');
      expect(hashSyncFile(a, 'x.json')).toBe(hashContent('{"name":"a"}'));
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
  it('上流の package.json に顧客の name を残す。顧客に name が無ければ上流そのまま', () => {
    const up = JSON.stringify({ name: 'note-line-poster', version: '2' }, null, 2) + '\n';
    expect(JSON.parse(mergePackageJson(JSON.stringify({ name: 'mine' }), up))).toEqual({ name: 'mine', version: '2' });
    expect(mergePackageJson(null, up)).toBe(up);
    expect(mergePackageJson('not json', up)).toBe(up);
  });
});

describe('シンボリックリンクは扱わない', () => {
  it('listSyncFiles はリンクを見つけたら例外（node_modules 等の対象外フォルダのリンクは構わない）', () => {
    const d = mkdtempSync(join(tmpdir(), 'nlp-link-'));
    try {
      writeTree(d, { 'src/a.ts': 'a' });
      symlinkSync(join(d, 'src'), join(d, 'node_modules'));
      expect(listSyncFiles(d)).toEqual(['src/a.ts']);
      symlinkSync(join(d, 'src/a.ts'), join(d, 'src/b.ts'));
      expect(() => listSyncFiles(d)).toThrow(SymlinkError);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── Issue ───────────────────────────────────────────────────
describe('失敗の知らせ（GitHub Issue）', () => {
  const env = { GITHUB_TOKEN: 'dummy-token', GITHUB_REPOSITORY: 'someone/my-repo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42' };

  it('Issue の本文は日本語で、原因・何も変えていないこと・次の一手・目印を含む。トークンは含まない', () => {
    const { title, body } = buildIssue({ kind: 'conflict', details: ['src/a.ts：書き換えられています'], version: '20261026-abc1234', runUrl: 'https://github.com/someone/my-repo/actions/runs/42' });
    expect(title).toMatch(/自動更新が止まっています/);
    expect(body).toContain(issueMarker('conflict'));
    expect(body).toMatch(/何も変更していません/);
    expect(body).toMatch(/提供元/);
    expect(body).toMatch(/\.sync-pin/);
    expect(body).toContain('src/a.ts');
    expect(body).not.toContain('dummy-token');
  });

  it('同じ理由の Issue が無ければ、新しく作る', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method) return new Response(JSON.stringify([{ number: 3, body: issueMarker('checks') }]), { status: 200 });
      return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    };
    const r = await reportFailure({ kind: 'conflict', details: ['x'], version: 'v', env, fetchImpl: fetchMock as typeof fetch });
    expect(r).toEqual({ action: 'created', number: 7 });
    expect(calls[0].url).toBe('https://api.github.com/repos/someone/my-repo/issues?state=open&per_page=100');
    expect(calls[1].url).toBe('https://api.github.com/repos/someone/my-repo/issues');
    expect(calls[1].init?.method).toBe('POST');
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer dummy-token');
    const sent = JSON.parse(String(calls[1].init?.body));
    expect(sent.body).toContain(issueMarker('conflict'));
    expect(sent.body).toContain('https://github.com/someone/my-repo/actions/runs/42');
  });

  it('★同じ理由の Issue が開いていれば、新しく作らずコメントで追記する（プルリクエストは無視）', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method) {
        return new Response(JSON.stringify([
          { number: 2, body: issueMarker('conflict'), pull_request: {} },
          { number: 5, body: `前置き\n${issueMarker('conflict')}` },
        ]), { status: 200 });
      }
      return new Response('{}', { status: 201 });
    };
    const r = await reportFailure({ kind: 'conflict', details: [], version: 'v', env, fetchImpl: fetchMock as typeof fetch });
    expect(r).toEqual({ action: 'commented', number: 5 });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://api.github.com/repos/someone/my-repo/issues/5/comments');
  });

  it('GitHub の外（トークン無し）では Issue を作らない／API が失敗しても例外にしない', async () => {
    expect(await reportFailure({ kind: 'conflict', details: [], env: {}, fetchImpl: (async () => { throw new Error('呼ばれてはいけない'); }) as typeof fetch }))
      .toEqual({ action: 'skipped' });
    expect(await reportFailure({ kind: 'conflict', details: [], env, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch }))
      .toEqual({ action: 'error' });
  });
});

// ── 実行本体（一時フォルダで実ファイルを使う） ─────────────────────
type Files = Record<string, string>;

function writeTree(dir: string, files: Files) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

function readTree(dir: string, prefix = ''): Files {
  const out: Files = {};
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out[rel] = `-> link`;
    else if (st.isDirectory()) Object.assign(out, readTree(abs, rel));
    else out[rel] = readFileSync(abs, 'utf8');
  }
  return out;
}

const UP_WRANGLER = JSON.stringify({
  name: 'note-line-poster', main: 'src/index.ts', compatibility_date: '2026-10-01',
  d1_databases: [{ binding: 'DB', database_name: 'note-line-poster', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'KV', id: '0'.repeat(32) }],
  triggers: { crons: ['0 0 * * *'] },
}, null, 2) + '\n';

const MY_WRANGLER = JSON.stringify({
  name: 'my-poster', main: 'src/index.ts', compatibility_date: '2026-08-01',
  d1_databases: [{ binding: 'DB', database_name: 'my-db', database_id: '11111111-2222-3333-4444-555555555555', migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'KV', id: 'a'.repeat(32) }],
  triggers: { crons: ['0 0 * * *'] },
}, null, 2) + '\n';

const HEAD_SHA = 'c0ffee'.padEnd(40, '0');

const OLD_FILES: Files = {
  'src/a.ts': 'export const a = 1;\n',
  'src/old.ts': 'export const old = 1;\n',
  'migrations/0001_init.sql': 'CREATE TABLE t (id TEXT);\n',
};

describe('runSync（実行本体）', () => {
  let work: string;
  let repo: string;
  let up: string;
  let calls: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }[];
  let opts: { failClone?: boolean; failCheck?: string; failPush?: boolean };
  const logs: string[] = [];

  /** 上流（stable）の中身を作る。マニフェストは build-template と同じ関数で作る */
  function makeUpstream(files: Files, wrangler = UP_WRANGLER, version = '20261027-bbbbbbb') {
    writeTree(up, { ...files, 'wrangler.json': wrangler, '.upstream.json': '{"repo":"owner/tpl","branch":"stable"}\n' });
    writeFileSync(join(up, '.upstream-manifest.json'), serializeManifest(buildManifest(up, version)));
  }

  /** 顧客のリポジトリ（前回の版 OLD_FILES を取り込み済み）を作る */
  function makeRepo(extra: Files = {}) {
    writeTree(repo, { ...OLD_FILES, 'wrangler.json': MY_WRANGLER, '.upstream.json': '{"repo":"owner/tpl","branch":"stable"}\n',
      '.github/workflows/auto-update.yml': '{"name":"auto-update"}\n' });
    const base = { version: '20261020-aaaaaaa', files: Object.fromEntries(Object.entries(OLD_FILES).map(([p, c]) => [p, h(c)])) };
    writeFileSync(join(repo, '.upstream-manifest.json'), serializeManifest(base));
    writeTree(repo, extra);
  }

  const exec = (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    if (cmd === 'git' && args[0] === 'clone') {
      if (opts.failClone) return { ok: false, output: 'fatal: unable to access' };
      cpSync(up, args[args.length - 1], { recursive: true });
      return { ok: true, output: '' };
    }
    if (cmd === 'npm' || cmd === 'npx') {
      const name = cmd === 'npm' ? 'ci' : args[0];
      return { ok: opts.failCheck !== name, output: `${name} の出力` };
    }
    if (cmd === 'git' && args.includes('push')) return { ok: !opts.failPush, output: opts.failPush ? 'rejected' : '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { ok: true, output: `${HEAD_SHA}\n` };
    return { ok: true, output: '' };
  };

  const fetchCalls: string[] = [];
  const fetchBodies: string[] = [];
  let openIssues: unknown[] = [];
  let failClose = false;
  const fetchMock = (async (url: string, init?: RequestInit) => {
    fetchCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.body) fetchBodies.push(String(init.body));
    if (!init?.method) return new Response(JSON.stringify(openIssues), { status: 200 });
    if (init.method === 'PATCH') return new Response('{}', { status: failClose ? 403 : 200 });
    return new Response('{"number":1}', { status: 201 });
  }) as typeof fetch;

  const run = () => runSync({
    cwd: repo, exec, fetch: fetchMock, tmpRoot: work, log: (m: string) => logs.push(m),
    env: { GITHUB_TOKEN: 'dummy-token', GITHUB_REPOSITORY: 'someone/my-repo' },
  });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'nlp-sync-test-'));
    repo = join(work, 'repo');
    up = join(work, 'up');
    mkdirSync(repo);
    mkdirSync(up);
    calls = [];
    opts = {};
    logs.length = 0;
    openIssues = [];
    failClose = false;
    fetchBodies.length = 0;
    fetchCalls.length = 0;
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const NEW_FILES: Files = {
    'src/a.ts': 'export const a = 2;\n',                       // 更新
    'src/new.ts': 'export const n = 1;\n',                     // 追加（src/old.ts は削除）
    'migrations/0001_init.sql': OLD_FILES['migrations/0001_init.sql'],
    'migrations/0002_add.sql': 'ALTER TABLE t ADD COLUMN x TEXT;\n',
  };

  it('★成功: 検査を作業用の複製で行い、通ったら本物に当てて commit → push。ID は守る', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    const r = await run();
    expect(r.status).toBe('updated');
    expect(r.code).toBe(0);

    const after = readTree(repo);
    expect(after['src/a.ts']).toBe('export const a = 2;\n');
    expect(after['src/new.ts']).toBeDefined();
    expect(after['src/old.ts']).toBeUndefined();
    expect(after['migrations/0002_add.sql']).toBeDefined();
    expect(after['.github/workflows/auto-update.yml']).toBe('{"name":"auto-update"}\n');   // 触らない
    const w = JSON.parse(after['wrangler.json']);
    expect(w.d1_databases[0].database_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(w.compatibility_date).toBe('2026-10-01');
    const m = parseManifest(after['.upstream-manifest.json'])!;
    expect(m.version).toBe('20261027-bbbbbbb');
    expect(m.files).toEqual(hashTree(up));

    // 検査（npm ci → vitest → tsc）は本物ではなく作業用の複製で行う
    const checks = calls.filter((c) => c.cmd === 'npm' || c.cmd === 'npx');
    expect(checks.map((c) => [c.cmd, c.args[0]])).toEqual([['npm', 'ci'], ['npx', 'vitest'], ['npx', 'tsc']]);
    for (const c of checks) {
      expect(c.cwd).not.toBe(repo);
      expect(c.env, '検査のコマンドに環境変数を明示して渡す').toBeDefined();
      expect(c.env).not.toHaveProperty('GITHUB_TOKEN');
    }
    const gitCmds = calls.filter((c) => c.cmd === 'git').map((c) => c.args.find((a) => ['clone', 'add', 'commit', 'push'].includes(a)));
    expect(gitCmds).toEqual(['clone', undefined, 'add', 'commit', 'push']);   // undefined = rev-parse（巻き戻し先を控える）
    // ★鍵は push のときだけ、環境変数（GIT_CONFIG_*）で渡す。引数には出さない
    const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:dummy-token').toString('base64')}`;
    const push = calls.find((c) => c.args.includes('push'))!;
    const last = Number(push.env?.GIT_CONFIG_COUNT) - 1;
    expect(push.env?.[`GIT_CONFIG_KEY_${last}`]).toBe('http.https://github.com/.extraheader');
    expect(push.env?.[`GIT_CONFIG_VALUE_${last}`]).toBe(header);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('dummy-token');
      expect(c.env).not.toHaveProperty('GITHUB_TOKEN');
      if (c !== push) expect(Object.values(c.env ?? {})).not.toContain(header);
    }
    expect(calls.find((c) => c.args.includes('commit'))!.args).toContain('chore: 自動更新 20261027-bbbbbbb');
    // 取り込みは公開リポジトリの stable を depth 1 で
    expect(calls[0].args).toEqual(expect.arrayContaining(['--depth', '1', '--branch', 'stable', 'https://github.com/owner/tpl.git']));
    expect(fetchCalls).toEqual(['GET https://api.github.com/repos/someone/my-repo/issues?state=open&per_page=100']);   // 成功時は Issue を作らない（解消済みの Issue を探すだけ）
    // 一時フォルダは片付ける
    expect(readdirSync(work).sort()).toEqual(['repo', 'up']);
  });

  it('★衝突（顧客が手で直した）: 何も書かず、Issue を作り、終了コード 1', async () => {
    makeUpstream(NEW_FILES);
    makeRepo({ 'src/a.ts': 'export const a = 999; // 自分で直した\n' });
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'conflict' });
    expect(readTree(repo)).toEqual(before);
    expect(calls.some((c) => c.args.includes('commit') || c.args.includes('push'))).toBe(false);
    expect(calls.some((c) => c.cmd === 'npm')).toBe(false);    // 検査より前に止まる
    expect(fetchCalls).toEqual(['GET https://api.github.com/repos/someone/my-repo/issues?state=open&per_page=100',
      'POST https://api.github.com/repos/someone/my-repo/issues']);
  });

  it('★既存のマイグレーションが書き換えられた版: 何も書かずに止める', async () => {
    makeUpstream({ ...NEW_FILES, 'migrations/0001_init.sql': 'CREATE TABLE t (id TEXT, y TEXT);\n' });
    makeRepo();
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'migration' });
    expect(readTree(repo)).toEqual(before);
  });

  it('★マイグレーションが削除された版: 何も書かずに止める', async () => {
    const { 'migrations/0001_init.sql': _x, ...rest } = NEW_FILES;
    makeUpstream(rest);
    makeRepo();
    const before = readTree(repo);
    expect(await run()).toMatchObject({ status: 'failed', kind: 'migration' });
    expect(readTree(repo)).toEqual(before);
  });

  it('★束縛の集合が変わる版: 何も書かずに止める', async () => {
    const w = JSON.parse(UP_WRANGLER);
    w.r2_buckets = [{ binding: 'IMAGES', bucket_name: 'x' }];
    makeUpstream(NEW_FILES, JSON.stringify(w));
    makeRepo();
    const before = readTree(repo);
    expect(await run()).toMatchObject({ status: 'failed', kind: 'bindings' });
    expect(readTree(repo)).toEqual(before);
  });

  it('★テスト（vitest）が落ちる版: 本物には何も書かない', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    opts.failCheck = 'vitest';
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'checks' });
    expect(readTree(repo)).toEqual(before);
    expect(calls.some((c) => c.args.includes('commit'))).toBe(false);
    expect(calls.some((c) => c.cmd === 'npx' && c.args[0] === 'tsc')).toBe(false);   // 1つ落ちたら先へ進まない
  });

  it('npm ci・型チェックが落ちても同じ（何も書かない）', async () => {
    for (const fail of ['ci', 'tsc']) {
      rmSync(repo, { recursive: true, force: true }); mkdirSync(repo);
      rmSync(up, { recursive: true, force: true }); mkdirSync(up);
      makeUpstream(NEW_FILES);
      makeRepo();
      opts.failCheck = fail;
      const before = readTree(repo);
      expect(await run(), fail).toMatchObject({ status: 'failed', kind: 'checks' });
      expect(readTree(repo), fail).toEqual(before);
    }
  });

  it('★push に失敗: 本物に当てた変更を元に戻す', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    opts.failPush = true;
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'push' });
    expect(readTree(repo)).toEqual(before);
    // ★HEAD~1 ではなく、控えておいた HEAD に戻す（浅い clone でも動く）
    expect(calls.some((c) => c.args.join(' ') === `reset -q --soft ${HEAD_SHA}`)).toBe(true);
  });

  it('★.sync-pin があれば何もしない（取得もしない・終了コード 0）', async () => {
    makeUpstream(NEW_FILES);
    makeRepo({ '.sync-pin': '' });
    const before = readTree(repo);
    const r = await run();
    expect(r).toEqual({ status: 'pinned', code: 0 });
    expect(calls).toEqual([]);
    expect(readTree(repo)).toEqual(before);
    expect(logs.join('\n')).toMatch(/止められています/);
  });

  it('★マニフェストが無い: 「初期化が必要」で止める（取得もしない）', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    rmSync(join(repo, '.upstream-manifest.json'));
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'init-required' });
    expect(calls).toEqual([]);
    expect(readTree(repo)).toEqual(before);
  });

  it('取り込み元を取れない（通信の失敗など）: 次回に回すだけ。Issue は作らず終了コード 0', async () => {
    makeRepo();
    opts.failClone = true;
    const before = readTree(repo);
    const r = await run();
    expect(r).toEqual({ status: 'fetch-failed', code: 0 });
    expect(fetchCalls).toEqual([]);
    expect(readTree(repo)).toEqual(before);
  });

  const AUTO_ISSUE = { number: 11, body: `${issueMarker('conflict')}\n## 自動更新が止まっています` };
  const MY_ISSUE = { number: 12, body: 'メニューの色を変えたい（顧客が自分で作った Issue）' };
  const MY_ISSUE_MENTIONING = { number: 13, body: 'auto-update が止まった件の相談です' };
  const PR = { number: 14, body: issueMarker('conflict'), pull_request: {} };

  it('★同期に成功したら（更新した）、自動更新が立てた Issue だけを「解消しました」とコメントして閉じる', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    openIssues = [AUTO_ISSUE, MY_ISSUE, MY_ISSUE_MENTIONING, PR];
    const r = await runSync({
      cwd: repo, exec, fetch: fetchMock, tmpRoot: work, log: (m: string) => logs.push(m),
      env: { GITHUB_TOKEN: 'dummy-token', GITHUB_REPOSITORY: 'someone/my-repo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '99' },
    });
    expect(r.status).toBe('updated');
    expect(fetchCalls).toEqual([
      'GET https://api.github.com/repos/someone/my-repo/issues?state=open&per_page=100',
      'POST https://api.github.com/repos/someone/my-repo/issues/11/comments',
      'PATCH https://api.github.com/repos/someone/my-repo/issues/11',
    ]);
    const comment = JSON.parse(fetchBodies[0]).body as string;
    expect(comment).toMatch(/解消しました/);
    expect(comment).toContain('20261027-bbbbbbb');
    expect(comment).toContain('https://github.com/someone/my-repo/actions/runs/99');
    // ★コメントにも送信内容にも秘密が出ない
    for (const b of fetchBodies) expect(b).not.toContain('dummy-token');
    expect(JSON.parse(fetchBodies[1])).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('同期に成功したら（変更なし）も閉じる', async () => {
    makeUpstream(OLD_FILES, MY_WRANGLER.replace('"my-poster"', '"note-line-poster"'));
    makeRepo();
    openIssues = [AUTO_ISSUE, MY_ISSUE];
    expect((await run()).status).toBe('no-change');
    expect(fetchCalls.filter((c) => c.startsWith('PATCH'))).toEqual(['PATCH https://api.github.com/repos/someone/my-repo/issues/11']);
  });

  it('★閉じるのに失敗しても（権限など）、同期は成功のまま。警告をログに出す', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    openIssues = [AUTO_ISSUE];
    failClose = true;
    const r = await run();
    expect(r).toMatchObject({ status: 'updated', code: 0 });
    expect(logs.join('\n')).toMatch(/::warning::.*閉じられませんでした/);
  });

  it('★止められている日（.sync-pin）・取り込み元を取れなかった日は閉じない（解消していないため）', async () => {
    makeUpstream(NEW_FILES);
    makeRepo({ '.sync-pin': '' });
    openIssues = [AUTO_ISSUE];
    expect((await run()).status).toBe('pinned');
    expect(fetchCalls).toEqual([]);

    rmSync(join(repo, '.sync-pin'));
    opts.failClone = true;
    expect((await run()).status).toBe('fetch-failed');
    expect(fetchCalls).toEqual([]);
  });

  it('★失敗した日は閉じない（新しく立てる／追記するだけ）', async () => {
    makeUpstream(NEW_FILES);
    makeRepo({ 'src/a.ts': '// 自分で直した\n' });
    openIssues = [AUTO_ISSUE];
    expect((await run()).status).toBe('failed');
    expect(fetchCalls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('変更が無ければ何もしない（コミットを作らない・検査も走らせない）', async () => {
    makeUpstream(OLD_FILES, MY_WRANGLER.replace('"my-poster"', '"note-line-poster"'));
    makeRepo();
    // 上流の wrangler の非 ID 項目は顧客と同じ（name は顧客のものが残る）
    const before = readTree(repo);
    const r = await run();
    expect(r.status).toBe('no-change');
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.args[0])).toEqual(['clone']);
    expect(readTree(repo)).toEqual(before);
  });

  it('★拡張機能の zip は同期しない（上流で変わっても衝突にも更新にもならず、マニフェストにも入らない）', async () => {
    makeUpstream({ ...OLD_FILES, 'extension-package/note-connect.zip': 'zip-v2' }, MY_WRANGLER.replace('"my-poster"', '"note-line-poster"'));
    makeRepo({ 'extension-package/note-connect.zip': 'zip-v1' });
    expect(Object.keys(parseManifest(readFileSync(join(up, '.upstream-manifest.json'), 'utf8'))!.files)).not.toContain('extension-package/note-connect.zip');
    const before = readTree(repo);
    const r = await run();
    expect(r.status).toBe('no-change');
    expect(readTree(repo)).toEqual(before);
    expect(fetchCalls).toEqual(['GET https://api.github.com/repos/someone/my-repo/issues?state=open&per_page=100']);
  });

  it('★package.json: 顧客の name だけ違う（配備ボタンが書き換える）→ 衝突にならず同期でき、name は保持', async () => {
    const pkg = (name: string, deps: Record<string, string>) => JSON.stringify({ name, version: '0.0.0', dependencies: deps }, null, 2) + '\n';
    makeUpstream({ ...NEW_FILES, 'package.json': pkg('note-line-poster', { hono: '^4.14.0' }) });
    makeRepo({ 'package.json': pkg('note-line-poster-2', { hono: '^4.13.0' }) });
    // 前回の版の package.json（name は既定）をマニフェストに入れておく
    const man = parseManifest(readFileSync(join(repo, '.upstream-manifest.json'), 'utf8'))!;
    const tmp = mkdtempSync(join(work, 'pkg-'));
    writeFileSync(join(tmp, 'package.json'), pkg('note-line-poster', { hono: '^4.13.0' }));
    man.files['package.json'] = hashSyncFile(tmp, 'package.json');
    writeFileSync(join(repo, '.upstream-manifest.json'), serializeManifest(man));

    const r = await run();
    expect(r.status).toBe('updated');
    expect(r.actions).toContainEqual({ type: 'update', path: 'package.json' });
    const after = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    expect(after.name).toBe('note-line-poster-2');                 // 顧客の名前を保持
    expect(after.dependencies.hono).toBe('^4.14.0');               // 上流の依存は入る
  });

  it('★package.json: name 以外を顧客が直していたら、従来どおり衝突', async () => {
    const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '0.0.0', ...extra }, null, 2) + '\n';
    makeUpstream({ ...NEW_FILES, 'package.json': pkg('note-line-poster', { private: true }) });
    makeRepo({ 'package.json': pkg('my-name', { scripts: { mine: 'echo' } }) });
    const man = parseManifest(readFileSync(join(repo, '.upstream-manifest.json'), 'utf8'))!;
    const tmp = mkdtempSync(join(work, 'pkg-'));
    writeFileSync(join(tmp, 'package.json'), pkg('note-line-poster'));
    man.files['package.json'] = hashSyncFile(tmp, 'package.json');
    writeFileSync(join(repo, '.upstream-manifest.json'), serializeManifest(man));
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', kind: 'conflict' });
    expect(readTree(repo)).toEqual(before);
  });

  it('★シンボリックリンク（顧客側）: 書き込み先の途中にリンクがあれば、何も書かずに止める', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    // src を .github へのリンクにすり替える（src/new.ts を書くと .github に書かれてしまう）
    rmSync(join(repo, 'src'), { recursive: true });
    symlinkSync(join(repo, '.github'), join(repo, 'src'));
    const before = readTree(repo);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', code: 1, kind: 'symlink' });
    expect(readTree(repo)).toEqual(before);
    expect(readdirSync(join(repo, '.github'))).toEqual(['workflows']);
  });

  it('★シンボリックリンク（上流側）: 取り込み元にリンクがあれば止める', async () => {
    makeUpstream(NEW_FILES);
    symlinkSync('/etc/hosts', join(up, 'src/evil.ts'));
    makeRepo();
    const before = readTree(repo);
    expect(await run()).toMatchObject({ status: 'failed', kind: 'symlink' });
    expect(readTree(repo)).toEqual(before);
  });

  it('★シンボリックリンク: wrangler.json やマニフェストがリンクでも止める（リンク先を書き換えない）', async () => {
    makeUpstream(NEW_FILES);
    makeRepo();
    const outside = join(work, 'outside.json');
    writeFileSync(outside, readFileSync(join(repo, 'wrangler.json')));
    rmSync(join(repo, 'wrangler.json'));
    symlinkSync(outside, join(repo, 'wrangler.json'));
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', kind: 'symlink' });
    expect(readFileSync(outside, 'utf8')).toBe(MY_WRANGLER);
  });

  it('顧客が自分で足しただけのファイルは残す', async () => {
    makeUpstream(NEW_FILES);
    makeRepo({ 'notes/my-memo.md': 'メモ\n' });
    expect((await run()).status).toBe('updated');
    expect(existsSync(join(repo, 'notes/my-memo.md'))).toBe(true);
  });
});

// ── 配布物の部品 ─────────────────────────────────────────────
describe('自動更新の配布物の部品', () => {
  it('★ワークフロー（1行）の正本は有効な JSON で、毎日1回＋手動・権限・多重実行防止・同期スクリプトの呼び出しを持つ', () => {
    const text = readFileSync(new URL('../../docs/auto-update-workflow.json', import.meta.url), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);           // 貼り付けで崩れないよう1行
    const wf = JSON.parse(text);
    expect(wf.on.schedule).toHaveLength(1);
    const [min, hour] = wf.on.schedule[0].cron.split(' ');
    expect(Number(hour)).toBe(18);                              // UTC 18時台＝日本時間 午前3時台
    expect(Number(min)).toBeGreaterThanOrEqual(0);
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.permissions).toEqual({ contents: 'write', issues: 'write' });
    expect(wf.concurrency.group).toBeTruthy();
    const steps = Object.values(wf.jobs as Record<string, { steps: { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }[] }>)[0].steps;
    expect(steps[0].uses).toMatch(/^actions\/checkout@/);
    // ★鍵を .git/config に残さない（push は sync-upstream.mjs が、その時だけ鍵を使う）
    expect((steps[0] as { with?: Record<string, unknown> }).with?.['persist-credentials']).toBe(false);
    expect(steps[1].uses).toMatch(/^actions\/setup-node@/);
    expect(steps[1].with?.['node-version']).toBe('22');
    expect(steps[2].run).toBe('node scripts/sync-upstream.mjs');
    expect(steps[2].env?.GITHUB_TOKEN).toMatch(/GITHUB_TOKEN|github\.token/);
  });

  it('★手順書の貼り付け用の文字列は、正本と一字一句同じ', () => {
    const line = readFileSync(new URL('../../docs/auto-update-workflow.json', import.meta.url), 'utf8').trim();
    const guide = readFileSync(new URL('../../docs/setup-guide.html', import.meta.url), 'utf8');
    expect(guide).toContain(`<code>${line}</code>`);
    expect(guide).toContain('.github/workflows/auto-update.yml');
  });

  it('版は 大元では dev、配布物では YYYYMMDD-<sha> の形', () => {
    expect(VERSION).toMatch(/^(dev|\d{8}-[0-9a-z]+(-dirty)?(-[0-9a-f]{8})?)$/);
  });

  it('★/health が version を返す（既存の ok / checks は残す）', () => {
    const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{ VERSION \} from '\.\/version'/);
    expect(src).toMatch(/c\.json\(\{ ok, version: VERSION, checks \}, ok \? 200 : 500\)/);
  });

  it('★push 用の設定は、既存の GIT_CONFIG_* の後ろに足す（消さない）。鍵が無ければ何も足さない', () => {
    expect(pushAuthEnv(undefined, {})).toEqual({});
    const a = pushAuthEnv('t', {});
    expect(a.GIT_CONFIG_COUNT).toBe('1');
    expect(a.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    const b = pushAuthEnv('t', { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_KEY_1: 'y' });
    expect(b).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${Buffer.from('x-access-token:t').toString('base64')}` });
  });

  it('★検査のコマンドに渡す環境変数から、GitHub の鍵を抜く', () => {
    const out = withoutSecrets({ GITHUB_TOKEN: 'x', GH_TOKEN: 'y', ACTIONS_RUNTIME_TOKEN: 'z', PATH: '/bin', CI: 'true' });
    expect(out).toEqual({ PATH: '/bin', CI: 'true' });
  });

  it('listSyncFiles は対象外のフォルダに入らない', () => {
    const d = mkdtempSync(join(tmpdir(), 'nlp-list-'));
    try {
      writeTree(d, { 'src/a.ts': 'a', '.git/HEAD': 'x', 'node_modules/p/i.js': 'x', '.github/w.yml': 'x', 'wrangler.json': '{}', 'README.md': 'r',
        'extension-package/note-connect.zip': 'z' });
      expect(listSyncFiles(d)).toEqual(['README.md', 'src/a.ts']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── 本物の git で（ネットワークは使わない：ローカルの bare リポジトリを remote にする） ──
describe('runSync を本物の git で（浅い clone・push・巻き戻し）', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  let work: string;
  let bare: string;
  let repo: string;
  let up: string;

  function setup() {
    work = mkdtempSync(join(tmpdir(), 'nlp-realgit-'));
    bare = join(work, 'remote.git');
    up = join(work, 'up');
    const seed = join(work, 'seed');
    git(work, 'init', '-q', '--bare', '-b', 'main', bare);
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeTree(seed, {
      ...OLD_FILES,
      'wrangler.json': MY_WRANGLER,
      '.upstream.json': '{"repo":"owner/tpl","branch":"stable"}\n',
      '.upstream-manifest.json': serializeManifest({ version: 'v1', files: Object.fromEntries(Object.entries(OLD_FILES).map(([p, c]) => [p, h(c)])) }),
    });
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
    writeTree(seed, { 'README.md': 'two\n' });
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'second');
    git(seed, 'push', '-q', bare, 'main');
    // ★浅い clone（Actions の checkout と同じ depth 1）
    git(work, 'clone', '-q', '--depth', '1', `file://${bare}`, 'repo');
    repo = join(work, 'repo');
    mkdirSync(up);
    writeTree(up, {
      'src/a.ts': 'export const a = 2;\n', 'src/new.ts': 'export const n = 1;\n',
      'migrations/0001_init.sql': OLD_FILES['migrations/0001_init.sql'], 'wrangler.json': UP_WRANGLER,
    });
    writeFileSync(join(up, '.upstream-manifest.json'), serializeManifest(buildManifest(up, 'v2')));
  }

  /** clone と検査（npm/npx）だけ差し替え、git の add / commit / push / reset は本物 */
  const execWith = (calls: string[]) => (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git' && args[0] === 'clone') { cpSync(up, args[args.length - 1], { recursive: true }); return { ok: true, output: '' }; }
    if (cmd !== 'git') return { ok: true, output: '' };
    const r = spawnSync(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, encoding: 'utf8' });
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  };

  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('★追加・更新・削除を当てて commit → push。資格情報は .git/config に残らない', async () => {
    setup();
    const calls: string[] = [];
    const r = await runSync({ cwd: repo, exec: execWith(calls), tmpRoot: work, log: () => {}, env: { GITHUB_TOKEN: 'dummy-secret-token' } });
    expect(r.status).toBe('updated');
    // remote（bare）に届いている
    const ls = git(bare, 'ls-tree', '-r', '--name-only', 'main');
    expect(ls.split('\n')).toEqual(expect.arrayContaining(['src/a.ts', 'src/new.ts', 'migrations/0001_init.sql', '.upstream-manifest.json']));
    expect(ls.split('\n')).not.toContain('src/old.ts');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: 自動更新 v2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // ★鍵がどこにも残っていない
    const cfg = readFileSync(join(repo, '.git/config'), 'utf8');
    expect(cfg).not.toContain('dummy-secret-token');
    expect(cfg).not.toContain(Buffer.from('x-access-token:dummy-secret-token').toString('base64'));
    expect(cfg).not.toMatch(/extraheader/i);
    for (const c of calls) expect(c).not.toContain('dummy-secret-token');
  });

  it('★push に失敗したら、浅い clone でも元の HEAD・ファイル・index に戻る', async () => {
    setup();
    // remote 側で受け取りを断る
    writeFileSync(join(bare, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const before = readTree(repo);
    delete before['.git'];
    const r = await runSync({ cwd: repo, exec: execWith([]), tmpRoot: work, log: () => {}, env: {} });
    expect(r).toMatchObject({ status: 'failed', kind: 'push' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const after = readTree(repo);
    for (const k of Object.keys(after)) if (k.startsWith('.git/')) delete after[k];
    for (const k of Object.keys(before)) if (k.startsWith('.git/')) delete before[k];
    expect(after).toEqual(before);
  });
});
