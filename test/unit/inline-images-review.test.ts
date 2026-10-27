/**
 * 文中画像（P3）の源蔵レビュー（2026-10-24・条件付きGO）の指摘の再現と固定。
 *  必須1: 「作り直す」の二度押し・古いプレビューのボタンで二重に課金し、画像も壊れる
 *  必須2: 「AI画像2を消して」で消した絵が、書き直しのあとに黙って戻ってくる
 *  必須3: 「公開前に人が見る」が仕組みで守られていない
 *  前倒し4: 記事に無い物を描かない指示（V6 で業態由来の既定の禁止は外した）／前倒し5: 位置を動かしたら gen_heading も合わせる
 * node:sqlite へ全マイグレーションを流して動かす。OpenAI・LINE・note への通信はすべて偽物（本物は呼ばない）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID, type ArticleRow } from '../../src/ports/storage/db';
import { parse } from '../../src/core/article/placeholders';
import {
  ensureInlineImage, runInlineImageSteps, reuseGeneratedImages, countInlineForArticle, listGeneratedSlots, inlineViewOf,
  INLINE_PLAN_SYSTEM, FLAG_COUNT, type StepDo, type InlineDeps,
} from '../../src/core/image/inline';
import { PLAN_SYSTEM } from '../../src/core/image/thumbnail';
import {
  acquireImageLock, releaseImageLock, startLockedImageJob, regenStateCheck, imageLockKey,
  NOTE_INLINE_LOCKED, NOTE_STILL_GENERATING, NOTE_INLINE_BUSY_AUTO, type LockKv,
} from '../../src/core/image/lock';
import { needsAiImageReview, shouldAskAiImageReview } from '../../src/core/image/review';
import { generateArticle, reviseImagePosition, type ServiceDeps } from '../../src/core/article/service';
import { buildPreview } from '../../src/adapters/line/messages/preview';
import { AI_IMAGE_REVIEW_NOTE } from '../../src/adapters/line/messages/inline';
import { signLineBody } from '../../src/adapters/line/signature';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach((d) => d.close()); });

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

/** 偽の KV（値と、書き込みの期限を覚えるだけ） */
function memKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

function memStore() {
  const m = new Map<string, ArrayBuffer>();
  return {
    m,
    put: async (k: string, b: ArrayBuffer) => { m.set(k, b); },
    get: async (k: string) => (m.has(k) ? { bytes: m.get(k)!, contentType: 'image/png' } : null),
    delete: async (k: string) => { m.delete(k); },
  };
}

const PNG_B64 = Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64');
const IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const KEY = 'sk-openai-test';
const SECRET = 'line-secret';

const BODY = '冒頭の文です。\n\n## 見出し1\n一つ目の本文。\n\n[AI画像1]\n\n## 見出し2\n二つ目の本文。\n\n[AI画像2]\n\n## 見出し3\n三つ目。\n\n[AI画像3]';

async function setup(body = BODY, opts: { fresh?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const d1 = asD1(sqlite);
  const db = new Db(d1);
  await db.ensureTenant();
  const article = await db.createArticle(DEFAULT_TENANT_ID, '焼き鳥のネタ', 'staff1');
  await db.updateArticle(article.id, { title: '焼き鳥の話', body_md: body, ...(opts.fresh ? {} : { state: 'awaiting_approval' as ArticleRow['state'] }) });
  const images = memStore();
  const deps: InlineDeps = { db, images, llm: { provider: 'openai', openaiKey: KEY }, openaiKey: KEY };
  return { db, d1, sqlite, article, images, deps };
}

interface Net { images: number; texts: string[]; line: Array<{ url: string; body: { messages?: Array<{ text?: string; template?: unknown }>; to?: string } }> }
/** 偽の OpenAI・LINE。呼ばれた回数を数える */
function mockNet(opts: { image?: (n: number) => Response } = {}): Net {
  const net: Net = { images: 0, texts: [], line: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u === IMAGES_URL) {
      net.images++;
      return opts.image ? opts.image(net.images) : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }
    if (u === RESPONSES_URL) {
      const input = String((JSON.parse(String((init as RequestInit).body)) as { input: string }).input);
      net.texts.push(input);
      if (input.includes('挿絵を入れる場所')) {
        const slots = [...input.matchAll(/- slot (\d+):/g)].map((m) => Number(m[1]));
        return structured({ images: slots.map((slot) => ({ slot, prompt: `A calm flat illustration for section ${slot}, no text at all`, altText: `挿絵${slot}` })) });
      }
      return writer(input);
    }
    if (u.includes('api.line.me')) {
      net.line.push({ url: u, body: JSON.parse(String((init as RequestInit).body ?? '{}')) });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`想定外の通信: ${u}`);
  });
  return net;
}

function structured(obj: unknown) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200 });
}

/** 記事4ステップの偽物。見出しは headings() の名前（書き直しで見出しを変えられるように） */
let headingNames = ['見出し1', '見出し2', '見出し3', '見出し4'];
function writer(input: string) {
  if (input.includes('キーワード設計をしてください')) {
    return structured({ primaryKeyword: '焼き鳥', secondaryKeywords: ['炭火'], searchIntent: 'i', targetReader: 'r', competitorAngle: 'c' });
  }
  if (input.includes('記事の構成を作ってください')) {
    return structured({ workingTitle: 'w', leadIntent: 'l', sections: headingNames.map((h) => ({ heading: h, level: 2, intent: 'x', keywords: [], targetChars: 300, wantsImage: false })) });
  }
  if (input.includes('本文を書いてください')) {
    const n = Number(/\[画像1\] 〜 \[画像(\d+)\]/.exec(input)?.[1] ?? 0);
    const parts = ['焼き鳥の話です。'];
    headingNames.forEach((h, i) => {
      parts.push(`## ${h}`, `本文${i + 1}です。${'炭火で丁寧に焼きます。'.repeat(4)}`);
      if (i + 1 <= n) parts.push(`[画像${i + 1}]`);
    });
    return structured({ markdown: parts.join('\n\n') });
  }
  if (input.includes('仕上げてください')) {
    return structured({ titles: ['焼き鳥の話'], leadParagraph: 'l', metaDescription: 'm', hashtags: [], imageAlts: {}, revisedMarkdown: null });
  }
  throw new Error(`想定外の入力: ${input.slice(0, 40)}`);
}

function serviceDeps(db: Db, images = memStore()): ServiceDeps {
  return {
    db, llm: { provider: 'openai', openaiKey: KEY }, noteSession: { cookieHeader: '_note_session_v5=x', userAgent: 'ua', urlname: 'test' },
    ownerLineUserId: 'owner', staffLineUserIds: ['staff1'],
    images: images as unknown as ServiceDeps['images'],
  } as ServiceDeps;
}

const syncStep: StepDo = async (_n, _c, fn) => fn();

/** LINE の Webhook を実際に通す（署名つき）。返事は fetch の偽物に残る */
async function postWebhook(env: Record<string, unknown>, events: Array<{ userId: string; data?: string; text?: string }>) {
  const body = JSON.stringify({ events: events.map((e, i) => (e.data
    ? { type: 'postback', replyToken: `rt${i}`, source: { userId: e.userId }, postback: { data: e.data } }
    : { type: 'message', replyToken: `rt${i}`, source: { userId: e.userId }, message: { type: 'text', id: `m${i}`, text: e.text } })) });
  const { handleLineWebhook } = await import('../../src/adapters/line/webhook');
  const pending: Array<Promise<unknown>> = [];
  const res = await handleLineWebhook(new Request('https://x/webhook', {
    method: 'POST', body, headers: { 'x-line-signature': await signLineBody(body, SECRET) },
  }), env as never, { waitUntil: (p) => { pending.push(p); } });
  expect(res.status).toBe(200);
  await Promise.all(pending);
}

function lineEnv(d1: D1Database, kv: ReturnType<typeof memKv>, create = vi.fn(async () => ({ id: 'wf' }))) {
  return {
    DB: d1, KV: kv, LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner',
    LLM_PROVIDER: 'openai', OPENAI_API_KEY: KEY, GENERATE: { create },
  };
}

const replies = (net: Net) => net.line.filter((l) => l.url.includes('/reply')).map((l) => JSON.stringify(l.body));

// ── 必須1: 二度押し・同時実行 ─────────────────────────────────
describe('必須1: 「作り直す」は記事×種類ごとのロックで1本だけ', () => {
  it('★二度押し（同時に2つ）: Workflow は1本だけ・2つ目は「いま作成中」・予約は1回分しか増えない', async () => {
    const { db, d1, article, deps } = await setup();
    const net = mockNet();
    await runInlineImageSteps(syncStep, deps, article.id); // 最初の3枚
    expect(await countInlineForArticle(db, article.id)).toBe(3);
    const kv = memKv();
    const create = vi.fn(async () => ({ id: 'wf' }));
    await postWebhook(lineEnv(d1, kv, create), [
      { userId: 'owner', data: `action=inline_regen&id=${article.id}` },
      { userId: 'owner', data: `action=inline_regen&id=${article.id}` },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    const r = replies(net);
    expect(r.filter((x) => x.includes('作り直します'))).toHaveLength(1);
    expect(r.filter((x) => x.includes(NOTE_INLINE_LOCKED))).toHaveLength(1);
    // 起動された1本だけを動かす → 予約は3回分（6回にならない）
    const params = (create.mock.calls[0] as unknown as [{ params: { lockToken: string } }])[0].params;
    expect(kv.m.get(imageLockKey('inline', article.id))).toBe(params.lockToken);
    await runInlineImageSteps(syncStep, deps, article.id, { force: true });
    expect(await countInlineForArticle(db, article.id)).toBe(6);
    expect(net.images).toBe(6);
  });

  it('★preview_ready（自動生成の最中）の古いボタンは断る。予約も起動もしない', async () => {
    const { db, d1, article } = await setup();
    await db.updateArticle(article.id, { state: 'preview_ready' });
    const net = mockNet();
    const kv = memKv();
    const create = vi.fn(async () => ({ id: 'wf' }));
    await postWebhook(lineEnv(d1, kv, create), [
      { userId: 'owner', data: `action=inline_regen&id=${article.id}` },
      { userId: 'owner', data: `action=thumb_regen&id=${article.id}` },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(replies(net).filter((x) => x.includes(NOTE_STILL_GENERATING))).toHaveLength(2);
    expect(kv.m.size).toBe(0);
    expect(regenStateCheck('awaiting_approval')).toBe('ok');
    expect(regenStateCheck('preview_ready')).toBe('generating');
    expect(regenStateCheck('editing')).toBe('bad_state');
    expect(regenStateCheck(undefined)).toBe('bad_state');
  });

  it('サムネの作り直しも同じ仕組み（記事×種類で分ける。文中画像のロック中でもサムネは作り直せる）', async () => {
    const { d1, article } = await setup();
    mockNet();
    const kv = memKv();
    await kv.put(imageLockKey('inline', article.id), 'other');
    const create = vi.fn(async () => ({ id: 'wf' }));
    const env = lineEnv(d1, kv, create);
    await postWebhook(env, [{ userId: 'owner', data: `action=thumb_regen&id=${article.id}` }]);
    await postWebhook(env, [{ userId: 'owner', data: `action=thumb_regen&id=${article.id}` }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ params: { kind: string } }])[0].params.kind).toBe('thumbnail');
  });

  it('ロックの基本: 同じ token は取り直せる・別の token は取れない・持ち主でない token では外れない・起動に失敗したら外れる', async () => {
    const kv = memKv() as unknown as LockKv & { m: Map<string, string> };
    expect(await acquireImageLock(kv, 'inline', 'a', 't1')).toBe(true);
    expect(await acquireImageLock(kv, 'inline', 'a', 't1')).toBe(true);
    expect(await acquireImageLock(kv, 'inline', 'a', 't2')).toBe(false);
    await releaseImageLock(kv, 'inline', 'a', 't2');
    expect(kv.m.get(imageLockKey('inline', 'a'))).toBe('t1');
    await releaseImageLock(kv, 'inline', 'a', 't1');
    expect(kv.m.size).toBe(0);
    await expect(startLockedImageJob(kv, 'inline', 'a', 't3', async () => { throw new Error('起動失敗'); })).rejects.toThrow('起動失敗');
    expect(kv.m.size).toBe(0);
    // 書き込みに失敗する KV では「取れなかった」側に倒す
    const broken = { get: async () => null, put: async () => { throw new Error('429'); }, delete: async () => {} };
    expect(await acquireImageLock(broken, 'inline', 'a', 't')).toBe(false);
  });
});

describe('必須1: Workflow は終わる・失敗する・step が落ちる、のどれでもロックを外す', () => {
  async function runWorkflow(payload: Record<string, unknown>, opts: { image?: (n: number) => Response; stepThrows?: (name: string) => boolean; body?: string } = {}) {
    const ctx = await setup(opts.body);
    const net = mockNet({ image: opts.image });
    const kv = memKv();
    const { GenerateArticleWorkflow } = await import('../../src/workflows/generate-article');
    const env = { DB: ctx.d1, KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner', LLM_PROVIDER: 'openai', OPENAI_API_KEY: KEY };
    const wf = new (GenerateArticleWorkflow as unknown as new (c: unknown, e: unknown) => {
      run: (ev: unknown, step: unknown) => Promise<void>;
    })({}, env);
    const lockedDuring: Array<[string, boolean]> = [];
    const step = {
      sleep: async () => {},
      do: async (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
        lockedDuring.push([name, [...kv.m.keys()].some((k) => k.startsWith('imglock:'))]);
        if (opts.stepThrows?.(name)) throw new Error('WorkflowTimeoutError: step timed out');
        return fn();
      },
    };
    return { ...ctx, net, kv, lockedDuring, run: (p: Record<string, unknown>) => wf.run({ payload: { ...payload, ...p, articleId: ctx.article.id }, instanceId: 'i1' }, step) };
  }

  it('★文中画像の作り直し: 成功しても・画像が失敗しても・step が全部落ちても、ロックは外れる', async () => {
    {
      const w = await runWorkflow({ kind: 'inline_images', lineUserId: 'owner', lockToken: 'tok' });
      await w.kv.put(imageLockKey('inline', w.article.id), 'tok');
      await w.run({});
      expect(w.net.images).toBe(3);
      expect(w.kv.m.has(imageLockKey('inline', w.article.id))).toBe(false);
      expect(w.lockedDuring.filter(([n]) => n.includes('文中の画像を作る')).every(([, l]) => l)).toBe(true);
    }
    vi.restoreAllMocks();
    {
      const w = await runWorkflow({ kind: 'inline_images', lineUserId: 'owner', lockToken: 'tok' },
        { image: () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }) });
      await w.kv.put(imageLockKey('inline', w.article.id), 'tok');
      await w.run({});
      expect(w.kv.m.has(imageLockKey('inline', w.article.id))).toBe(false);
    }
    vi.restoreAllMocks();
    {
      const w = await runWorkflow({ kind: 'inline_images', lineUserId: 'owner', lockToken: 'tok' }, { stepThrows: () => true });
      await w.kv.put(imageLockKey('inline', w.article.id), 'tok');
      await expect(w.run({})).rejects.toThrow();
      expect(w.net.images).toBe(0);
      expect(w.kv.m.has(imageLockKey('inline', w.article.id))).toBe(false);
    }
  });

  it('★サムネの作り直しも、step が落ちてもロックは外れる。別の人が取り直したロックは消さない', async () => {
    const w = await runWorkflow({ kind: 'thumbnail', lineUserId: 'owner', lockToken: 'tok' }, { stepThrows: () => true });
    await w.kv.put(imageLockKey('thumb', w.article.id), 'tok');
    await expect(w.run({})).rejects.toThrow();
    expect(w.kv.m.has(imageLockKey('thumb', w.article.id))).toBe(false);
    vi.restoreAllMocks();
    const w2 = await runWorkflow({ kind: 'thumbnail', lineUserId: 'owner', lockToken: 'tok' }, { stepThrows: () => true });
    await w2.kv.put(imageLockKey('thumb', w2.article.id), 'someone-else');
    await expect(w2.run({})).rejects.toThrow();
    expect(w2.kv.m.get(imageLockKey('thumb', w2.article.id))).toBe('someone-else');
  });

  it('★記事生成の中の自動生成もロックを持つ（作っている間は印があり、終われば外れる）。作り直しの最中なら新しく作らない', async () => {
    headingNames = ['見出し1', '見出し2', '見出し3', '見出し4'];
    const w = await runWorkflow({ lineUserId: 'owner', debounceSec: 0 }, { body: '' });
    await w.db.setState(w.article.id, 'awaiting_approval', 'editing', 't');
    await w.db.setNumberFlag(FLAG_COUNT, 2, 't', 't');
    await w.db.setNumberFlag('thumb_auto', 0, 't', 't');
    await w.run({});
    expect(w.net.images).toBe(2);
    const during = w.lockedDuring.filter(([n]) => n.startsWith('文中の画像を作る'));
    expect(during.length).toBe(2);
    expect(during.every(([, l]) => l)).toBe(true);
    expect([...w.kv.m.keys()].some((k) => k.startsWith('imglock:'))).toBe(false);
    expect((await w.db.getArticle(w.article.id))!.state).toBe('awaiting_approval');
    vi.restoreAllMocks();

    // 作り直し（別の token）が走っている最中に、書き直しの自動生成が来た
    const w2 = await runWorkflow({ lineUserId: 'owner', debounceSec: 0 }, { body: '' });
    await w2.db.setState(w2.article.id, 'awaiting_approval', 'editing', 't');
    await w2.db.setNumberFlag(FLAG_COUNT, 2, 't', 't');
    await w2.db.setNumberFlag('thumb_auto', 0, 't', 't');
    await w2.kv.put(imageLockKey('inline', w2.article.id), 'regen-token');
    await w2.run({});
    expect(w2.net.images).toBe(0);
    expect(JSON.stringify(w2.net.line.map((l) => l.body))).toContain(NOTE_INLINE_BUSY_AUTO);
    expect(w2.kv.m.get(imageLockKey('inline', w2.article.id))).toBe('regen-token');
  });
});

describe('必須1: 同じ番号の行は1つだけ（不変条件）', () => {
  it('★同時に2本の作り直し（force）が走っても、同じ番号の行は1つだけ・前の画像の置き場も消える', async () => {
    const { db, article, images, deps } = await setup();
    mockNet();
    await runInlineImageSteps(syncStep, deps, article.id);
    const before = await db.listGeneratedImages(article.id);
    const item = (slot: number) => ({ slot, heading: `見出し${slot}`, prompt: 'p'.repeat(30), altText: `alt${slot}` });
    await Promise.all([
      ensureInlineImage(deps, article.id, item(1), { force: true }),
      ensureInlineImage(deps, article.id, item(1), { force: true }),
    ]);
    const after = await db.listGeneratedImages(article.id);
    expect(after.map((r) => r.gen_slot)).toEqual([1, 2, 3]);
    expect(after.find((r) => r.gen_slot === 1)!.id).not.toBe(before.find((r) => r.gen_slot === 1)!.id);
    // 置き場に残っている AI 画像は、行のある3枚だけ
    expect([...images.m.keys()].filter((k) => k.startsWith('gen_inline_')).sort()).toEqual(after.map((r) => r.r2_key).sort());
  });

  it('★重複行が残っていても、見出しが変わる書き直しで別の見出しに同じ絵が入らない（先に畳む）', async () => {
    const { db, sqlite, article, images, deps } = await setup();
    mockNet();
    await runInlineImageSteps(syncStep, deps, article.id);
    // 以前の二重実行の名残: 番号1（見出し1の絵）がもう1行ある
    sqlite.prepare(`INSERT INTO images (id, tenant_id, article_id, r2_key, mime_type, size_bytes, line_message_id, is_eyecatch, source, gen_slot, gen_heading, created_at)
      VALUES ('dup', ?, ?, 'dupkey', 'image/png', 1, 'geninline:dup', 0, 'generated', 1, '見出し1', '2026-01-01')`).run(DEFAULT_TENANT_ID, article.id);
    await images.put('dupkey', new Uint8Array([1]).buffer);
    // 書き直しで見出しが変わった: X / Y / 見出し3 / 見出し4（AI 画像は4つ）
    const md = '## X\n[AI画像1]\n## Y\n[AI画像2]\n## 見出し3\n[AI画像3]\n## 見出し4\n[AI画像4]';
    const plan = await reuseGeneratedImages(db, images, article.id, md);
    const rows = await db.listGeneratedImages(article.id);
    // 同じ番号は1つだけ・見出し1の絵は1枚だけ
    expect(new Set(rows.map((r) => r.gen_slot)).size).toBe(rows.length);
    expect(rows.filter((r) => r.gen_heading === '見出し1')).toHaveLength(1);
    // 見出し3の絵は見出し3へ。残りの2枚（見出し1・見出し2の絵）は順番どおり、足りない1つは新しく作る
    expect(rows.find((r) => r.gen_slot === 3)!.gen_heading).toBe('見出し3');
    expect(plan.missing).toEqual([4]);
    // 畳んだほうの置き場も消える（置き場に残る AI 画像は、行のあるものだけ）
    expect([...images.m.keys()].filter((k) => k === 'dupkey' || k.startsWith('gen_inline_')).sort())
      .toEqual(rows.map((r) => r.r2_key).sort());
  });
});

// ── 必須2: 消した画像が戻ってこない ─────────────────────────────
describe('必須2: 「AI画像2を消して」で消した絵は、書き直しのあとも戻らない', () => {
  it('★3枚作る→2を消す→本文を書き直す修正→消した絵（行・置き場）は復活しない。ほかの番号は詰めない', async () => {
    headingNames = ['見出し1', '見出し2', '見出し3', '見出し4'];
    const { db, article, images, deps } = await setup('', { fresh: true });
    await db.setNumberFlag(FLAG_COUNT, 3, 't', 't');
    mockNet();
    const sdeps = serviceDeps(db, images);
    await generateArticle(sdeps, article.id);
    await runInlineImageSteps(syncStep, { ...deps, images }, article.id);
    const rows = await db.listGeneratedImages(article.id);
    expect(rows.map((r) => r.gen_slot)).toEqual([1, 2, 3]);
    const removed = rows.find((r) => r.gen_slot === 2)!;

    await db.setState(article.id, 'preview_ready', 'awaiting_approval', 't');
    const out = await reviseImagePosition(sdeps, article.id, { action: 'remove', index: 2 }, 'generated');
    expect(parse(out.markdown, 'generated').map((p) => p.index)).toEqual([1, 3]); // 番号は詰めない
    expect((await db.listGeneratedImages(article.id)).map((r) => r.gen_slot)).toEqual([1, 3]);
    expect(images.m.has(removed.r2_key)).toBe(false);

    // 本文を書き直す修正（見出しも変わる）
    headingNames = ['新1', '新2', '新3', '新4'];
    await db.setState(article.id, 'awaiting_approval', 'editing', 't');
    await generateArticle(sdeps, article.id);
    const afterRows = await db.listGeneratedImages(article.id);
    expect(afterRows.some((r) => r.id === removed.id)).toBe(false);
    expect(afterRows.some((r) => r.r2_key === removed.r2_key)).toBe(false);
    expect(afterRows).toHaveLength(2); // 残した2枚だけを使い回す（足りない1つは次の step で新しく作る）
  });
});

// ── 必須3: 公開前に人が見る ─────────────────────────────────
describe('必須3: AI 画像つきの初回の「公開する」は一度だけ確認する', () => {
  async function withAiImages() {
    const ctx = await setup();
    mockNet();
    await runInlineImageSteps(syncStep, ctx.deps, ctx.article.id);
    vi.restoreAllMocks();
    return ctx;
  }

  it('判定: AI 画像あり・未保存・未確認のときだけ聞く', async () => {
    expect(shouldAskAiImageReview({ note_id: null, ai_images_confirmed_at: null }, 1)).toBe(true);
    expect(shouldAskAiImageReview({ note_id: '123', ai_images_confirmed_at: null }, 1)).toBe(false);
    expect(shouldAskAiImageReview({ note_id: null, ai_images_confirmed_at: '2026-10-24' }, 1)).toBe(false);
    expect(shouldAskAiImageReview({ note_id: null, ai_images_confirmed_at: null }, 0)).toBe(false);
    const { db, article } = await withAiImages();
    expect(await needsAiImageReview(db, await db.getArticle(article.id))).toBe(true);
    // 本文から消した（目印が無い）なら聞かない
    await db.updateArticle(article.id, { body_md: '## 見出し1\n本文' });
    expect(await needsAiImageReview(db, await db.getArticle(article.id))).toBe(false);
  });

  it('★初回の「公開する」は確認が出て、公開には進まない（承認も記録しない）', async () => {
    const { db, d1, article } = await withAiImages();
    const net = mockNet();
    await postWebhook(lineEnv(d1, memKv()), [{ userId: 'owner', data: `action=publish&id=${article.id}` }]);
    const r = replies(net);
    expect(r[0]).toContain('AI画像がまだ確認されていません');
    expect(r[0]).toContain(`action=publish_confirm&id=${article.id}`);
    expect(r[0]).toContain(`action=savedraft&id=${article.id}`);
    expect((await db.getArticle(article.id))!.approved_by).toBeNull();
    // 文字の「公開」は、その人が担当している確認待ちの記事に効く
    await db.setRequestedBy(article.id, 'owner');
    const net2 = mockNet();
    await postWebhook(lineEnv(d1, memKv()), [{ userId: 'owner', text: '公開' }]);
    expect(replies(net2)[0]).toContain('AI画像がまだ確認されていません');
  });

  it('★『このまま公開する』は確認済みの印を付けて通常の公開へ進む。以後は聞かない', async () => {
    const { db, d1, article } = await withAiImages();
    const net = mockNet();
    await postWebhook(lineEnv(d1, memKv()), [{ userId: 'owner', data: `action=publish_confirm&id=${article.id}` }]);
    const a = (await db.getArticle(article.id))!;
    expect(a.ai_images_confirmed_at).toBeTruthy();
    expect(a.approved_by).toBe('owner'); // 通常の公開（承認）へ進んだ
    expect(replies(net).join()).not.toContain('AI画像がまだ確認されていません');
    expect(await needsAiImageReview(db, a)).toBe(false);
  });

  it('★下書き保存済み（note に保存済み）なら聞かない／AI 画像なしの記事でも聞かない', async () => {
    {
      const { db, d1, article } = await withAiImages();
      await db.updateArticle(article.id, { note_id: '123', note_key: 'nabc' });
      const net = mockNet();
      await postWebhook(lineEnv(d1, memKv()), [{ userId: 'owner', data: `action=publish&id=${article.id}` }]);
      expect(replies(net).join()).not.toContain('AI画像がまだ確認されていません');
      expect((await db.getArticle(article.id))!.approved_by).toBe('owner');
    }
    {
      const { db, d1, article } = await setup('## 見出し1\n本文です。');
      const net = mockNet();
      await postWebhook(lineEnv(d1, memKv()), [{ userId: 'owner', data: `action=publish&id=${article.id}` }]);
      expect(replies(net).join()).not.toContain('AI画像がまだ確認されていません');
      expect((await db.getArticle(article.id))!.approved_by).toBe('owner');
    }
  });

  it('★プレビュー: AI 画像が1枚でも本文にあれば「下書きで確認してから公開」を常に出す。0枚なら出さない', () => {
    const base = { articleId: 'x', title: 't', markdown: BODY, metaDescription: '', hashtags: [], charCount: 1 };
    const view = { slots: 3, created: [1], missing: 2, reasons: [], reusedMismatch: false, canRegenerate: true };
    expect(JSON.stringify(buildPreview({ ...base, inlineImages: view }))).toContain(AI_IMAGE_REVIEW_NOTE);
    expect(JSON.stringify(buildPreview({ ...base, inlineImages: { ...view, created: [], missing: 3 } }))).not.toContain(AI_IMAGE_REVIEW_NOTE);
  });
});

// ── 前倒し4・5 ─────────────────────────────────────────────
describe('前倒し4: 記事に無い物を描かない（指示文で固定）', () => {
  it('文中画像・サムネの両方の指示文に入っている', () => {
    for (const sys of [INLINE_PLAN_SYSTEM, PLAN_SYSTEM]) {
      expect(sys).toContain('記事に出てこない商品・料理・サービス・設備を描かない');
      expect(sys).toContain('記事の本文・ナレッジに書かれたものだけを描く');
      // ★V6（2026-10-27）: 特定の業態に由来する既定の禁止は外した（必要な顧客は自分の画像ルールに書く）
      expect(sys).not.toContain('\u751f\u8089');
    }
  });
});

describe('前倒し5: 位置だけ動かしたら、作ったときの見出し（gen_heading）も合わせる', () => {
  it('★移動: 誤警告が出ず、次の書き直しでも動かした先の見出しに入る', async () => {
    const { db, article, images, deps } = await setup();
    mockNet();
    await runInlineImageSteps(syncStep, deps, article.id);
    const sdeps = serviceDeps(db, images);
    await reviseImagePosition(sdeps, article.id, { action: 'remove', index: 1 }, 'generated');
    const moved = await reviseImagePosition(sdeps, article.id, { action: 'move', index: 3, headingIndex: 0 }, 'generated');
    const rows = await db.listGeneratedImages(article.id);
    expect(rows.find((r) => r.gen_slot === 3)!.gen_heading).toBe('見出し1');
    expect(inlineViewOf(listGeneratedSlots(moved.markdown), rows, { hasKey: true }).reusedMismatch).toBe(false);
    // 書き直しで「見出し3 → 見出し1」の順になった。動かした絵（元の3）は、元の見出し3ではなく動かした先の見出し1に入る
    const imageOf3 = rows.find((r) => r.gen_slot === 3)!.id;
    const plan = await reuseGeneratedImages(db, images, article.id, '## 見出し3\n[AI画像1]\n## 見出し1\n[AI画像2]');
    expect(plan.assign.find((x) => x.slot === 2)!.imageId).toBe(imageOf3);
  });

  it('入れ替え: 両方の番号の見出しが今の位置に合う', async () => {
    const { db, article, images, deps } = await setup();
    mockNet();
    await runInlineImageSteps(syncStep, deps, article.id);
    const out = await reviseImagePosition(serviceDeps(db, images), article.id, { action: 'swap', a: 1, b: 2 }, 'generated');
    const rows = await db.listGeneratedImages(article.id);
    expect(rows.map((r) => [r.gen_slot, r.gen_heading])).toEqual([[1, '見出し2'], [2, '見出し1'], [3, '見出し3']]);
    expect(inlineViewOf(listGeneratedSlots(out.markdown), rows, { hasKey: true }).reusedMismatch).toBe(false);
  });
});
