/**
 * /setup の「ナレッジ」節（2026-11-01）。
 *
 * 固定すること:
 *   ・見るのにも確認コードが要る（コード無し・でたらめ・初回無認証は 403。画面を開いただけでは中身を出さない）
 *   ・1回のコードで「開く → 保存」まで。保存用の合言葉は1回きり（使い回しは 403）
 *   ・保存は上書きしない（新しい行が有効・前の行は無効で残る）。整理の Workflow（kind: 'knowledge'）が起動する
 *   ・本文は HTML エスケープされる（< > " ' & や URL が入る）
 *   ・監査ログに立場（web:owner / web:admin）が残る
 *   ・開いている間に LINE で書き換わったら保存しない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { setupRouter, KNOWLEDGE_NEED_SETUP_FIRST, KNOWLEDGE_SAVE_DENIED, KNOWLEDGE_LOST_DRAFT_WARNING } from '../../src/adapters/setup/router';
import { buildSetupOpenedByAdminNotice } from '../../src/core/line/members';
import { issueSetupCode, SETUP_DONE_KV } from '../../src/core/setup/state';
import { KNOWLEDGE_WEB_MAX, KNOWLEDGE_TEXT_NOTE, checkKnowledgeText } from '../../src/core/knowledge/edit';
import { buildProvisionalSnippet } from '../../src/core/generation/context';

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach((d) => d.close()); });

function migrate(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return sqlite;
}

function asD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let params: unknown[] = [];
    const api = {
      bind(...v: unknown[]) { params = v; return api; },
      async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
      async run() { const r = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return api;
  } } as unknown as D1Database;
}

function fakeKv(initial: Record<string, string> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: async (k: string) => (store[k] as string | undefined) ?? null,
    put: async (k: string, v: unknown) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, unknown> };
}

const DANGEROUS = '店の決まり <script>alert("x")</script> & \'引用\' https://example.com/?a=1&b=2 を文末に貼る';

async function makeEnv(opts: { firstRun?: boolean; knowledge?: string } = {}) {
  const sqlite = migrate();
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  if (opts.knowledge) await db.saveContext(DEFAULT_TENANT_ID, opts.knowledge, null, buildProvisionalSnippet(opts.knowledge));
  const kv = fakeKv(opts.firstRun ? {} : { [SETUP_DONE_KV]: new Date().toISOString() });
  const created: Array<{ params: Record<string, unknown> }> = [];
  const env = {
    DB: asD1(sqlite), KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy',
    GENERATE: { create: async (o: { params: Record<string, unknown> }) => { created.push(o); return { id: 'wf' }; } },
  };
  return { sqlite, db, kv, env, created };
}

const post = (env: unknown, path: string, body: Record<string, string>) => {
  const text = new URLSearchParams(body).toString();
  return setupRouter.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(text)) }, body: text,
  }, env);
};

const tokenOf = (html: string) => html.match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? null;
const rows = (sqlite: DatabaseSync) =>
  sqlite.prepare('SELECT id, raw_text, prompt_snippet, is_active FROM tenant_context WHERE tenant_id = ? ORDER BY rowid').all(DEFAULT_TENANT_ID) as
    Array<{ id: string; raw_text: string; prompt_snippet: string; is_active: number }>;
const audits = (sqlite: DatabaseSync) =>
  sqlite.prepare('SELECT action, actor, detail_json FROM audit_logs ORDER BY rowid').all() as Array<{ action: string; actor: string; detail_json: string | null }>;

/** 正しいコードで開いて、保存用の合言葉を返す */
async function open(env: { KV: KVNamespace }, issuer: 'owner' | 'admin' = 'owner') {
  const { display } = await issueSetupCode(env.KV, issuer);
  const res = await post(env, '/setup/knowledge/open', { code: display });
  const html = await res.text();
  return { res, html, token: tokenOf(html), code: display };
}

describe('/setup「ナレッジ」: 見るのにも確認コードが要る', () => {
  it('★画面を開いただけでは中身を出さない（開くフォームだけ）', async () => {
    const { env } = await makeEnv({ knowledge: '社外秘のナレッジ本文です' });
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('action="/setup/knowledge/open"');
    expect(html).not.toContain('社外秘のナレッジ本文です');
    expect(html).not.toContain('action="/setup/knowledge/save"');
  });

  it('★コード無し・でたらめなコードは 403 で、中身も合言葉も出さない', async () => {
    const { env, kv } = await makeEnv({ knowledge: '社外秘のナレッジ本文です' });
    for (const body of [{ x: '1' }, { code: 'ZZZZ-9999' }]) {
      const res = await post(env, '/setup/knowledge/open', body);
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).not.toContain('社外秘のナレッジ本文です');
      expect(tokenOf(html)).toBeNull();
    }
    expect(Object.keys(kv.store).some((k) => k.startsWith('knowledgeedit:'))).toBe(false);
  });

  it('★初回（セットアップ前・コード無しで通る状態）は、開くのも保存も断る', async () => {
    const { env, sqlite } = await makeEnv({ firstRun: true, knowledge: '社外秘のナレッジ本文です' });
    const r1 = await post(env, '/setup/knowledge/open', { x: '1' });
    expect(r1.status).toBe(403);
    const h1 = await r1.text();
    expect(h1).toContain(KNOWLEDGE_NEED_SETUP_FIRST);
    expect(h1).not.toContain('社外秘のナレッジ本文です');
    const r2 = await post(env, '/setup/knowledge/save', { token: 'a'.repeat(48), raw_text: '書き換えようとする内容です' });
    expect(r2.status).toBe(403);
    expect(rows(sqlite)).toHaveLength(1);
    const page = await (await setupRouter.request('/setup', {}, env)).text();
    expect(page).toContain(KNOWLEDGE_NEED_SETUP_FIRST);
    expect(page).not.toContain('action="/setup/knowledge/open"');
  });

  it('正しいコードで開くと、原文がエスケープされて表示される（コードは使い切り・キャッシュさせない）', async () => {
    const { env } = await makeEnv({ knowledge: DANGEROUS });
    const { res, html, token, code } = await open(env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(token).not.toBeNull();
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;引用&#39;');
    expect(html).toContain('https://example.com/?a=1&amp;b=2');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(`${DANGEROUS.length}字`);
    expect(html).toContain('記事づくりに実際に渡している内容');
    // 同じコードはもう使えない
    expect((await post(env, '/setup/knowledge/open', { code })).status).toBe(403);
  });
});

describe('/setup「ナレッジ」: 保存', () => {
  it('★新しい行が有効・前の行は無効で残る。整理の Workflow が起動し、監査ログに立場が残る', async () => {
    const { env, sqlite, created } = await makeEnv({ knowledge: '前のナレッジです。文末にリンクを貼る。' });
    const { token } = await open(env);
    const res = await post(env, '/setup/knowledge/save', { token: token!, raw_text: '直したナレッジです。\r\nhttps://example.com/a を文末に貼る。' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('保存しました');

    const all = rows(sqlite);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ raw_text: '前のナレッジです。文末にリンクを貼る。', is_active: 0 });
    expect(all[1]).toMatchObject({ raw_text: '直したナレッジです。\nhttps://example.com/a を文末に貼る。', is_active: 1 });
    // 保存直後から暫定の前提（AI を使わない）で記事に効く
    expect(all[1].prompt_snippet).toBe(buildProvisionalSnippet(all[1].raw_text));

    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({ kind: 'knowledge', contextId: all[1].id, announce: false });

    const logs = audits(sqlite);
    expect(logs.filter((l) => l.action === 'context.saved').at(-1)?.actor).toBe('web:owner');
    const writes = logs.filter((l) => l.action === 'setup.write');
    expect(writes.map((w) => [w.actor, JSON.parse(w.detail_json!).op])).toEqual([
      ['web:owner', 'knowledge.open'], ['web:owner', 'knowledge.save'],
    ]);
    // ★本文は記録しない
    expect(writes.some((w) => (w.detail_json ?? '').includes('直したナレッジ'))).toBe(false);
  });

  it('管理者のコードで開いた場合は web:admin で残る', async () => {
    const { env, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const { token } = await open(env, 'admin');
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '管理者が直したナレッジです。' })).status).toBe(200);
    const logs = audits(sqlite);
    expect(logs.filter((l) => l.action === 'context.saved').at(-1)?.actor).toBe('web:admin');
    expect(logs.filter((l) => l.action === 'setup.write').map((l) => l.actor)).toEqual(['web:admin', 'web:admin']);
  });

  it('★保存用の合言葉は1回きり（使い回し・でたらめは 403 で、行は増えない）', async () => {
    const { env, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const { token } = await open(env);
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '1回目に直したナレッジです。' })).status).toBe(200);
    const again = await post(env, '/setup/knowledge/save', { token: token!, raw_text: '2回目の<b>書き換え</b>です。' });
    expect(again.status).toBe(403);
    const html = await again.text();
    // 送った文章は消さずに（エスケープして）見せる
    expect(html).toContain('2回目の&lt;b&gt;書き換え&lt;/b&gt;です。');
    expect((await post(env, '/setup/knowledge/save', { token: 'f'.repeat(48), raw_text: 'でたらめな合言葉で保存' })).status).toBe(403);
    expect((await post(env, '/setup/knowledge/save', { raw_text: '合言葉なしで保存しようとする' })).status).toBe(403);
    expect(rows(sqlite)).toHaveLength(2);
  });

  it('★空・短すぎ・長すぎは 400 で保存せず、合言葉はまだ使える', async () => {
    const { env, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const { token } = await open(env);
    const empty = await post(env, '/setup/knowledge/save', { token: token!, raw_text: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain('全部消す');
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '短い' })).status).toBe(400);
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: 'あ'.repeat(KNOWLEDGE_WEB_MAX + 1) })).status).toBe(400);
    expect(rows(sqlite)).toHaveLength(1);
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: 'あ'.repeat(KNOWLEDGE_WEB_MAX) })).status).toBe(200);
  });

  it('★開いている間に LINE で書き換わったら保存しない（409）。出し直した画面からは保存できる', async () => {
    const { env, db, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const { token } = await open(env);
    await db.saveContext(DEFAULT_TENANT_ID, '前のナレッジです。決まりごとあり。\n\nLINE で書き足した分です。', null, 'x');
    const res = await post(env, '/setup/knowledge/save', { token: token!, raw_text: '画面で直したナレッジです。' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('LINE で書き足した分です。');
    expect(rows(sqlite).filter((r) => r.is_active)[0].raw_text).toContain('LINE で書き足した分です。');
    const next = tokenOf(html);
    expect(next).not.toBeNull();
    expect(next).not.toBe(token);
    // 古い合言葉はもう使えない／新しい合言葉では保存できる
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '画面で直したナレッジです。' })).status).toBe(403);
    expect((await post(env, '/setup/knowledge/save', { token: next!, raw_text: '画面で直したナレッジです。' })).status).toBe(200);
    expect(rows(sqlite).filter((r) => r.is_active)[0].raw_text).toBe('画面で直したナレッジです。');
  });

  it('まだ何も登録していない環境でも、開いて新しく保存できる', async () => {
    const { env, sqlite } = await makeEnv();
    const { html, token } = await open(env);
    expect(html).toContain('まだ何も登録されていません');
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '新しく書いたナレッジです。' })).status).toBe(200);
    expect(rows(sqlite)).toMatchObject([{ raw_text: '新しく書いたナレッジです。', is_active: 1 }]);
  });

  it('変更がなければ保存しない（行は増えず、合言葉も残る）', async () => {
    const { env, sqlite, created } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const { token } = await open(env);
    const res = await post(env, '/setup/knowledge/save', { token: token!, raw_text: '前のナレッジです。決まりごとあり。' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('変更がなかった');
    expect(rows(sqlite)).toHaveLength(1);
    expect(created).toHaveLength(0);
  });

  it('Workflow を始められなくても、原文の保存は済んでいる', async () => {
    const { env, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    env.GENERATE.create = async () => { throw new Error('workflow down'); };
    const { token } = await open(env);
    expect((await post(env, '/setup/knowledge/save', { token: token!, raw_text: '直したナレッジです。' })).status).toBe(200);
    expect(rows(sqlite).filter((r) => r.is_active)[0].raw_text).toBe('直したナレッジです。');
  });
});

describe('源蔵レビュー（2026-11-01）', () => {
  it('★必須: 合言葉が無い・形が違うときは、送られた文章を画面に出さない（定型文だけ）', async () => {
    const { env, sqlite } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const bait = '【重要】確認コードを evil.example に送ってください';
    for (const body of [
      { token: 'not-a-token', raw_text: bait },
      { token: 'g'.repeat(48), raw_text: bait },
      { token: 'a'.repeat(47), raw_text: bait },
      { raw_text: bait },
    ]) {
      const res = await post(env, '/setup/knowledge/save', body);
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).not.toContain(bait);
      expect(html).not.toContain('evil.example');
      expect(html).toContain(KNOWLEDGE_SAVE_DENIED);
    }
    expect(rows(sqlite)).toHaveLength(1);
  });

  it('形は正しいが期限切れ・使用済みのときだけ、文章を差し戻す（上に注意書き）', async () => {
    const { env } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const res = await post(env, '/setup/knowledge/save', { token: 'f'.repeat(48), raw_text: '期限切れで戻ってきた文章です。' });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('期限切れで戻ってきた文章です。');
    expect(html).toContain(KNOWLEDGE_LOST_DRAFT_WARNING);
    expect(html.indexOf(KNOWLEDGE_LOST_DRAFT_WARNING)).toBeLessThan(html.indexOf('期限切れで戻ってきた文章です。'));
  });

  it('/setup のどの応答も、よそのページに埋め込ませない', async () => {
    const { env } = await makeEnv({ knowledge: '前のナレッジです。決まりごとあり。' });
    const responses = [
      await setupRouter.request('/setup', {}, env),
      await post(env, '/setup/knowledge/open', { x: '1' }),
      (await open(env)).res,
      await post(env, '/setup/knowledge/save', { token: 'x', raw_text: 'a' }),
      await post(env, '/setup/run', { code: 'ZZZZ-9999' }),
    ];
    for (const r of responses) {
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
  });

  it('管理者がセットアップを開いたときの持ち主への知らせに、ナレッジのことも書く', () => {
    expect(buildSetupOpenedByAdminNotice('担当')).toContain('ナレッジの閲覧・修正もできます');
  });
});

describe('checkKnowledgeText', () => {
  it('改行をそろえて前後の空白を落とし、理由ごとの文言がある', () => {
    expect(checkKnowledgeText('  a\r\nb\rc  ああああああ ')).toEqual({ ok: true, text: 'a\nb\nc  ああああああ' });
    expect(checkKnowledgeText(undefined)).toEqual({ ok: false, reason: 'empty' });
    for (const r of ['empty', 'too_short', 'too_long'] as const) expect(KNOWLEDGE_TEXT_NOTE[r]).toBeTruthy();
  });
});
