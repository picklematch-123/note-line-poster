import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import {
  OpenAiImageClient, ImageGenError, IMAGE_MODEL, THUMBNAIL_SIZE, FALLBACK_SIZE, MAX_CALLS_PER_GENERATE, MAX_RETRIES,
} from '../../src/ports/image/openai';
import {
  ensureThumbnail, setThumbAuto, setThumbDailyLimit, getThumbSettings,
  MAX_PER_ARTICLE, DEFAULT_DAILY_LIMIT, buildPlanUser, PLAN_SYSTEM,
} from '../../src/core/image/thumbnail';
import { buildPreview } from '../../src/adapters/line/messages/preview';
import { COMMANDS } from '../../src/adapters/line/commands';

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); databases.splice(0).forEach((d) => d.close()); });

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

const PNG_B64 = Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64');
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';

function memStore() {
  const m = new Map<string, ArrayBuffer>();
  return {
    m,
    put: async (k: string, b: ArrayBuffer) => { m.set(k, b); },
    get: async (k: string) => (m.has(k) ? { bytes: m.get(k)!, contentType: 'image/png' } : null),
    delete: async (k: string) => { m.delete(k); },
  };
}

async function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  const article = await db.createArticle(DEFAULT_TENANT_ID, 'テスト');
  await db.updateArticle(article.id, {
    title: '腰痛と姿勢の話', meta_description: '要約', body_md: '## 見出し1\n本文です。\n[画像1]\n## 見出し2\n続き',
  });
  const images = memStore();
  const deps = { db, images, llm: { anthropicKey: 'sk-ant-test' }, openaiKey: 'sk-openai-test' as string | null };
  return { db, sqlite, article, images, deps };
}

interface Calls { openai: Array<Record<string, unknown>>; anthropic: number }
function mockNetwork(opts: { openai?: () => Response } = {}): Calls {
  const calls: Calls = { openai: [], anthropic: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === OPENAI_URL) {
      calls.openai.push(JSON.parse(String((init as RequestInit).body)));
      return opts.openai ? opts.openai() : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 50, output_tokens: 1000 } }), { status: 200 });
    }
    if (String(url).includes('api.anthropic.com')) {
      calls.anthropic++;
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ prompt: 'A bright flat illustration of a person stretching in a calm room, soft colors, wide composition, no text', altText: '背伸びをする人のイラスト' }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200 });
    }
    throw new Error(`想定外の通信: ${url}`);
  });
  return calls;
}

describe('OpenAI 画像クライアント', () => {
  it('gpt-image-2 固定・指定サイズ・b64 を画像に戻す', async () => {
    const calls = mockNetwork();
    const img = await new OpenAiImageClient('sk-openai-test').generate('p');
    expect(calls.openai[0]).toMatchObject({ model: IMAGE_MODEL, size: THUMBNAIL_SIZE, n: 1 });
    expect(IMAGE_MODEL).toBe('gpt-image-2');
    expect(new Uint8Array(img.bytes)[0]).toBe(137);
  });

  it('★別モデルは受け付けない（勝手に下げない）', () => {
    expect(() => new OpenAiImageClient('sk-x', 'dall-e-3')).toThrow();
  });

  it('キーの形が違えば作れない', () => {
    expect(() => new OpenAiImageClient('')).toThrow(ImageGenError);
  });

  it('サイズを断られたら標準サイズで1回やり直す', async () => {
    let n = 0;
    const calls = mockNetwork({ openai: () => (n++ === 0
      ? new Response(JSON.stringify({ error: { message: 'Invalid size 1536x800', code: 'invalid_value' } }), { status: 400 })
      : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 })) });
    const img = await new OpenAiImageClient('sk-x').generate('p');
    expect(calls.openai.map((c) => c.size)).toEqual([THUMBNAIL_SIZE, FALLBACK_SIZE]);
    expect(img.size).toBe(FALLBACK_SIZE);
  });

  it('残高不足は再試行せず、チャージ先を案内する', async () => {
    const calls = mockNetwork({ openai: () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 }) });
    const e = await new OpenAiImageClient('sk-x').generate('p').catch((x) => x as ImageGenError);
    expect(e.kind).toBe('billing');
    expect(e.userMessage).toContain('Billing');
    expect(e.userMessage).toContain('記事は書けています');
    expect(calls.openai).toHaveLength(1);
  });

  it('★一時エラーは上限回数（初回＋2回）で打ち切る', async () => {
    vi.useFakeTimers();
    const calls = mockNetwork({ openai: () => new Response('{}', { status: 503 }) });
    const p = new OpenAiImageClient('sk-x').generate('p').catch((x) => x as ImageGenError);
    await vi.advanceTimersByTimeAsync(60_000);
    const e = await p;
    expect(e.kind).toBe('temp');
    expect(calls.openai).toHaveLength(3);
  });

  // ── 源蔵レビュー（P2）前倒し8: 予約1件あたりの最悪の呼び出し回数 ──
  const sizeError = () => new Response(JSON.stringify({ error: { message: 'Invalid size 1536x800', code: 'invalid_value' } }), { status: 400 });

  it('★サイズ違いのやり直しは1回まで（標準サイズも断られたら、それ以上は試さない）', async () => {
    const calls = mockNetwork({ openai: sizeError });
    const e = await new OpenAiImageClient('sk-x').generate('p').catch((x) => x as ImageGenError);
    expect(e.kind).toBe('bad_request');
    expect(calls.openai.map((c) => c.size)).toEqual([THUMBNAIL_SIZE, FALLBACK_SIZE]);
  });

  it('★最悪の並び（一時エラー2回→サイズ拒否→一時エラーが続く）でも、呼び出しは上限の6回で止まる', async () => {
    vi.useFakeTimers();
    let n = 0;
    const calls = mockNetwork({ openai: () => (++n === 3 ? sizeError() : new Response('{}', { status: 503 })) });
    const p = new OpenAiImageClient('sk-x').generate('p').catch((x) => x as ImageGenError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await p).kind).toBe('temp');
    expect(MAX_CALLS_PER_GENERATE).toBe(6);
    expect(MAX_CALLS_PER_GENERATE).toBe(2 * (MAX_RETRIES + 1));
    expect(calls.openai).toHaveLength(MAX_CALLS_PER_GENERATE);
  });

  it('★200 で返ったのに画像が読めないときは、やり直さない（課金済みかもしれないため）', async () => {
    const calls = mockNetwork({ openai: () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    const e = await new OpenAiImageClient('sk-x').generate('p').catch((x) => x as ImageGenError);
    expect(e.kind).toBe('temp');
    expect(calls.openai).toHaveLength(1);
  });

  it('キー不正・安全基準・組織認証を見分ける', async () => {
    mockNetwork({ openai: () => new Response('{}', { status: 401 }) });
    expect((await new OpenAiImageClient('sk-x').generate('p').catch((x) => x)).kind).toBe('auth');
    vi.restoreAllMocks();
    mockNetwork({ openai: () => new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'x' } }), { status: 400 }) });
    expect((await new OpenAiImageClient('sk-x').generate('p').catch((x) => x)).kind).toBe('policy');
    vi.restoreAllMocks();
    mockNetwork({ openai: () => new Response(JSON.stringify({ error: { message: 'Your organization must be verified to use gpt-image-2' } }), { status: 403 }) });
    expect((await new OpenAiImageClient('sk-x').generate('p').catch((x) => x)).kind).toBe('verification');
  });
});

describe('サムネの自動生成', () => {
  it('作れる：サムネに指定され、本文の画像には混ざらず、生成として区別される', async () => {
    const { deps, db, article, sqlite } = await setup();
    const calls = mockNetwork();
    const out = await ensureThumbnail(deps, article.id);
    expect(out.status).toBe('created');
    const eye = await db.getEyecatch(article.id);
    expect(eye).toBeTruthy();
    expect(await db.listImages(article.id)).toHaveLength(0);
    expect((sqlite.prepare('SELECT source FROM images WHERE id = ?').get(eye!.id) as { source: string }).source).toBe('generated');
    expect(deps.images.m.has(eye!.r2_key)).toBe(true);
    expect(calls.openai).toHaveLength(1);
  });

  it('★キー未設定なら何もしない（外部にも一切通信しない）', async () => {
    const { deps, article } = await setup();
    const calls = mockNetwork();
    const out = await ensureThumbnail({ ...deps, openaiKey: null }, article.id);
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_key' });
    expect(calls.openai).toHaveLength(0);
    expect(calls.anthropic).toBe(0);
  });

  it('自動生成オフなら作らない。作り直し(force)は押された操作なので作る', async () => {
    const { deps, db, article } = await setup();
    mockNetwork();
    await setThumbAuto(db, false, 'test');
    expect(await ensureThumbnail(deps, article.id)).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('created');
  });

  it('★ご自身の写真がサムネなら触らない（作り直しも）', async () => {
    const { deps, db, article } = await setup();
    const calls = mockNetwork();
    await db.addImage(DEFAULT_TENANT_ID, { articleId: article.id, r2Key: 'k', mimeType: 'image/jpeg', sizeBytes: 1, lineMessageId: 'm1' });
    const [photo] = await db.listAllImages(article.id);
    await db.setEyecatch(article.id, photo.id);
    expect(await ensureThumbnail(deps, article.id)).toMatchObject({ status: 'skipped', reason: 'user_thumbnail' });
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'user_thumbnail' });
    expect(calls.openai).toHaveLength(0);
  });

  it('★すでに生成済みなら、自動の呼び出しでは二重に課金しない', async () => {
    const { deps, article } = await setup();
    const calls = mockNetwork();
    await ensureThumbnail(deps, article.id);
    const again = await ensureThumbnail(deps, article.id);
    expect(again.status).toBe('created');
    expect(calls.openai).toHaveLength(1);
  });

  it('作り直しは前の生成画像を置き換える（本文に残らない）。回数は記事ごとに上限あり', async () => {
    const { deps, db, article, sqlite } = await setup();
    const calls = mockNetwork();
    await ensureThumbnail(deps, article.id);
    for (let i = 1; i < MAX_PER_ARTICLE; i++) expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('created');
    expect(calls.openai).toHaveLength(MAX_PER_ARTICLE);
    expect(await db.listImages(article.id)).toHaveLength(0);
    expect((sqlite.prepare('SELECT COUNT(*) c FROM images WHERE article_id = ?').get(article.id) as { c: number }).c).toBe(1);
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'article_limit' });
    expect(calls.openai).toHaveLength(MAX_PER_ARTICLE);
  });

  it('★1日の上限に達したら作らない。上限は顧客が変えられる', async () => {
    const { deps, db, article } = await setup();
    const calls = mockNetwork();
    expect((await getThumbSettings(db)).dailyLimit).toBe(DEFAULT_DAILY_LIMIT);
    await setThumbDailyLimit(db, 1, 'test');
    await ensureThumbnail(deps, article.id);
    const other = await db.createArticle(DEFAULT_TENANT_ID, '別');
    await db.updateArticle(other.id, { title: 't', body_md: '本文' });
    expect(await ensureThumbnail(deps, other.id)).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
    expect(calls.openai).toHaveLength(1);
  });

  it('★失敗しても例外を投げず、画像は残さない。回数は「呼ぶ直前の予約」として数えたまま', async () => {
    // 2026-10-24 期待値を変更: 以前は「失敗は回数に数えない」だったが、課金されたのに数えない分が出るため
    // （源蔵必須5）、呼ぶ直前に予約として数え、失敗しても取り消さない作りに改めた。
    const { deps, db, article, sqlite } = await setup();
    mockNetwork({ openai: () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota' } }), { status: 429 }) });
    const out = await ensureThumbnail(deps, article.id);
    expect(out).toMatchObject({ status: 'failed', kind: 'billing' });
    expect(await db.getEyecatch(article.id)).toBeNull();
    const reserved = () => (sqlite.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action = 'thumbnail.reserved' AND target = ?`).get(article.id) as { c: number }).c;
    expect(reserved()).toBe(1); // 失敗した1回も数えている
    const again = mockNetwork();
    await ensureThumbnail(deps, article.id);
    expect(again.openai).toHaveLength(1); // 上限（3回）にはまだ余裕があるので作れる
    expect(reserved()).toBe(2);
  });

  it('★失敗した分も上限に数える（失敗を繰り返しても、上限を超えて呼ばない）', async () => {
    const { deps, article } = await setup();
    const calls = mockNetwork({ openai: () => new Response('{}', { status: 400 }) });
    for (let i = 0; i < MAX_PER_ARTICLE + 2; i++) await ensureThumbnail(deps, article.id, { force: true });
    expect(calls.openai).toHaveLength(MAX_PER_ARTICLE);
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'article_limit' });
  });

  it('変更前の記録（thumbnail.generated だけ）も数え漏らさない', async () => {
    const { deps, db, article } = await setup();
    const calls = mockNetwork();
    for (let i = 0; i < MAX_PER_ARTICLE; i++) await db.audit(DEFAULT_TENANT_ID, 'thumbnail.generated', 'system', article.id, 'ok');
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'article_limit' });
    expect(calls.openai).toHaveLength(0);
  });

  it('指示文づくりで、ナレッジの避けることと文字・商標の禁止が伝わる', () => {
    const user = buildPlanUser({ title: 'T', metaDescription: '', headings: ['H'], excerpt: 'E', knowledge: '【書かないこと】医療効果の断定' });
    expect(user).toContain('医療効果の断定');
    expect(PLAN_SYSTEM).toContain('日本語の文字は絶対に入れない');
    expect(PLAN_SYSTEM).toContain('ロゴ');
    expect(PLAN_SYSTEM).toContain('避けること');
  });
});

describe('LINE の見せ方', () => {
  const base = { articleId: 'a1', title: 'T', markdown: '## 見出し\n本文', metaDescription: '', hashtags: [], charCount: 100 };
  const json = (m: unknown) => JSON.stringify(m);

  it('サムネなしのときは、そう表示し、理由を添える', () => {
    const s = json(buildPreview({ ...base, hasEyecatch: false, thumbnailNote: 'サムネを作れませんでした', canRegenerateThumbnail: true }));
    expect(s).toContain('サムネなし');
    expect(s).toContain('サムネを作れませんでした');
    expect(s).toContain('action=thumb_regen&id=a1');
  });

  it('キー未設定のときは「作り直す」ボタンを出さない', () => {
    expect(json(buildPreview({ ...base, hasEyecatch: false, canRegenerateThumbnail: false }))).not.toContain('thumb_regen');
  });

  it('AIが作ったことが分かる', () => {
    expect(json(buildPreview({ ...base, hasEyecatch: true, thumbnailGenerated: true }))).toContain('AIが作成');
  });

  it('「サムネ設定」が設定コマンドに届き、他のコマンドと重ならない', () => {
    expect(COMMANDS.thumbSettings.test('サムネ設定')).toBe(true);
    const others = Object.entries(COMMANDS).filter(([k]) => k !== 'thumbSettings');
    expect(others.filter(([, re]) => (re as RegExp).test('サムネ設定'))).toEqual([]);
  });
});
