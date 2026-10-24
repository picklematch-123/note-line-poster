/**
 * 文中画像の自動生成（P3・設計書 18章）。
 * 本物の D1 の代わりに node:sqlite へ全マイグレーションを流して動かす。OpenAI・note への通信はすべて偽物
 * （★本物の OpenAI は呼ばない。実機は費用確認のあとで運用側が行う）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID, type ArticleRow } from '../../src/ports/storage/db';
import {
  splitGeneratedPlaceholders, normalize, parse, move, swap, remove, fill,
} from '../../src/core/article/placeholders';
import { composeArticleMarkdown, aiImageNote } from '../../src/core/article/compose';
import {
  findArticleLinkProblems, renderWithPlaceholders, buildAllowedLinks, generatedImageUrlPlaceholder, precheckArticleLinks,
} from '../../src/core/article/links';
import {
  applyInlineSetting, getInlineSettings, effectiveInlineCount, FLAG_COUNT, FLAG_DAILY_LIMIT,
  ensureInlineImage, prepareInlinePlan, runInlineImageSteps, planGeneratedReuse, reuseGeneratedImages,
  countInlineForArticle, countInlineToday, MAX_INLINE_PER_ARTICLE, AUDIT_INLINE_RESERVED,
  INLINE_PLAN_SYSTEM, buildInlinePlanUser, listGeneratedSlots, inlineViewOf, type StepDo, type InlineDeps,
} from '../../src/core/image/inline';
import { countGeneratedToday, AUDIT_RESERVED as THUMB_RESERVED } from '../../src/core/image/thumbnail';
import { generateArticle, saveArticleAsDraft, reviseImagePosition, type ServiceDeps } from '../../src/core/article/service';
import { buildPlan } from '../../src/core/agent/plan';
import { toNoteHtml } from '../../src/ports/publisher/note/html';
import { buildPreview } from '../../src/adapters/line/messages/preview';
import { buildAiSettings } from '../../src/adapters/line/messages/research';
import { toLineText } from '../../src/adapters/line/messages/fulltext';
import { RevisionIntent } from '../../src/core/generation/schema';

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
const IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const KEY = 'sk-openai-test';

function memStore() {
  const m = new Map<string, ArrayBuffer>();
  return {
    m,
    put: async (k: string, b: ArrayBuffer) => { m.set(k, b); },
    get: async (k: string) => (m.has(k) ? { bytes: m.get(k)!, contentType: 'image/png' } : null),
    delete: async (k: string) => { m.delete(k); },
  };
}

const BODY = '冒頭の文です。\n\n## 見出し1\n一つ目の本文。\n\n[AI画像1]\n\n## 見出し2\n二つ目の本文。\n\n[画像1]\n\n## 見出し3\n三つ目。\n\n[AI画像2]';

async function setup(body = BODY, opts: { photos?: number; fresh?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  const article = await db.createArticle(DEFAULT_TENANT_ID, '腰痛のネタ', 'staff1');
  // fresh = 生成前（受付直後の状態のまま。generateArticle を通すテスト用）
  await db.updateArticle(article.id, { title: '腰痛の話', body_md: body, ...(opts.fresh ? {} : { state: 'awaiting_approval' as ArticleRow['state'] }) });
  for (let i = 0; i < (opts.photos ?? 0); i++) {
    await db.addImage(DEFAULT_TENANT_ID, { articleId: article.id, r2Key: `photo${i}`, mimeType: 'image/png', sizeBytes: 3, lineMessageId: `m${i}` });
  }
  const images = memStore();
  for (let i = 0; i < (opts.photos ?? 0); i++) await images.put(`photo${i}`, new Uint8Array([1]).buffer);
  const deps: InlineDeps = { db, images, llm: { provider: 'openai', openaiKey: KEY }, openaiKey: KEY };
  return { db, sqlite, article, images, deps };
}

/** 偽の OpenAI（文章は Responses API、画像は images/generations）。呼ばれた回数を数える */
interface Net { images: Array<Record<string, unknown>>; texts: string[] }
function mockOpenAi(opts: { image?: (n: number) => Response; plan?: (input: string) => Response } = {}): Net {
  const net: Net = { images: [], texts: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u === IMAGES_URL) {
      net.images.push(JSON.parse(String((init as RequestInit).body)));
      return opts.image ? opts.image(net.images.length) : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }
    if (u === RESPONSES_URL) {
      const body = JSON.parse(String((init as RequestInit).body)) as { input: string };
      const input = String(body.input);
      net.texts.push(input);
      if (input.includes('挿絵を入れる場所')) {
        if (opts.plan) return opts.plan(input);
        const slots = [...input.matchAll(/- slot (\d+):/g)].map((m) => Number(m[1]));
        return structured({ images: slots.map((slot) => ({
          slot, prompt: `A calm flat illustration for section ${slot}, soft colors, wide composition, no text at all`, altText: `挿絵${slot}`,
        })) });
      }
      return writer(input);
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

/** 記事4ステップの偽物。本文は「画像が N 枚」に合わせて [画像1]〜[画像N] を見出しの下に置く */
function writer(input: string) {
  if (input.includes('キーワード設計をしてください')) {
    return structured({ primaryKeyword: '腰痛', secondaryKeywords: ['ストレッチ'], searchIntent: 'i', targetReader: 'r', competitorAngle: 'c' });
  }
  if (input.includes('記事の構成を作ってください')) {
    return structured({ workingTitle: 'w', leadIntent: 'l', sections: [1, 2, 3, 4].map((i) => ({ heading: `見出し${i}`, level: 2, intent: 'x', keywords: [], targetChars: 300, wantsImage: false })) });
  }
  if (input.includes('本文を書いてください')) {
    const n = Number(/\[画像1\] 〜 \[画像(\d+)\]/.exec(input)?.[1] ?? 0);
    const parts = ['腰痛の話です。'];
    for (let i = 1; i <= 4; i++) {
      parts.push(`## 見出し${i}`, `本文${i}です。${'毎日の小さな習慣が大切です。'.repeat(4)}`);
      if (i <= n) parts.push(`[画像${i}]`);
    }
    return structured({ markdown: parts.join('\n\n') });
  }
  if (input.includes('仕上げてください')) {
    return structured({ titles: ['腰痛の話'], leadParagraph: 'l', metaDescription: 'm', hashtags: [], imageAlts: { 1: '写真のalt', 2: 'AIのはずのalt' }, revisedMarkdown: null });
  }
  throw new Error(`想定外の入力: ${input.slice(0, 40)}`);
}

function serviceDeps(db: Db, images = memStore(), key: string | null = KEY): ServiceDeps {
  return {
    db, llm: { provider: 'openai', openaiKey: key }, noteSession: { cookieHeader: '_note_session_v5=x', userAgent: 'ua', urlname: 'test' },
    ownerLineUserId: 'owner', staffLineUserIds: ['staff1'],
    images: images as unknown as ServiceDeps['images'],
  } as ServiceDeps;
}

const syncStep: StepDo = async (_name, _cfg, fn) => fn();

/** プレビュー → 確認待ち → 修正中（「修正する」で本文を作り直すときと同じ道） */
async function toEditing(db: Db, id: string) {
  await db.setState(id, 'preview_ready', 'awaiting_approval', 't');
  await db.setState(id, 'awaiting_approval', 'editing', 't');
}

// ── 1. 番号の設計 ───────────────────────────────────────
describe('番号: 写真は [画像N]、AI 画像は [AI画像N]（設計書 18-2）', () => {
  const bodyWith = (n: number) => ['リード', ...Array.from({ length: n }, (_, i) => `## 見出し${i + 1}\n本文\n\n[画像${i + 1}]`)].join('\n\n');

  it('★写真 k 枚＋生成 m 枚の全組合せ（k,m = 0〜3 の16例）で、前から k 個が写真・残りが AI 画像1〜m', () => {
    for (let k = 0; k <= 3; k++) {
      for (let m = 0; m <= 3; m++) {
        const out = splitGeneratedPlaceholders(bodyWith(k + m), k);
        expect(parse(out).map((p) => p.index)).toEqual(Array.from({ length: k }, (_, i) => i + 1));
        expect(parse(out, 'generated').map((p) => p.index)).toEqual(Array.from({ length: m }, (_, i) => i + 1));
        // 出現順: 写真が前、AI 画像が後ろ（見出しの順のまま）
        const gen = parse(out, 'generated');
        if (k && m) expect(gen[0].headingIndex).toBe(k);
      }
    }
  });

  it('本文にもともと [AI画像N] が書かれていたら消してから振り分ける（番号の出どころを1つにする）', () => {
    const out = splitGeneratedPlaceholders('## A\n[AI画像7]\n\n[画像1]\n## B\n[画像2]', 1);
    expect(out).not.toContain('[AI画像7]');
    expect(parse(out).map((p) => p.index)).toEqual([1]);
    expect(parse(out, 'generated').map((p) => p.index)).toEqual([1]);
  });

  it('★写真を後から足しても [AI画像N] は変わらない（normalize は AI 画像に触らない）', () => {
    const md = splitGeneratedPlaceholders(bodyWith(3), 1); // 写真1・AI 2
    const after = normalize(md, 2); // 確認待ちの間に写真が1枚増えた
    expect(parse(after, 'generated').map((p) => [p.index, p.heading])).toEqual(parse(md, 'generated').map((p) => [p.index, p.heading]));
    expect(parse(after).map((p) => p.index)).toEqual([1, 2]);
    // 写真が減っても AI 画像はそのまま
    expect(parse(normalize(md, 0), 'generated')).toHaveLength(2);
  });

  it('★位置移動・削除・入れ替えで、もう一方の系統が壊れない', () => {
    const md = '## A\n[画像1]\n\n[AI画像1]\n## B\n[画像2]\n\n[AI画像2]\n## C\n本文';
    const moved = move(md, 1, 2, 'generated');
    expect(parse(moved, 'generated').find((p) => p.index === 1)!.heading).toBe('C');
    expect(parse(moved).map((p) => p.heading)).toEqual(['A', 'B']);
    const swapped = swap(md, 1, 2, 'generated');
    expect(parse(swapped, 'generated').map((p) => [p.index, p.heading])).toEqual([[2, 'A'], [1, 'B']]);
    expect(parse(swapped).map((p) => [p.index, p.heading])).toEqual([[1, 'A'], [2, 'B']]);
    const removed = remove(md, 2, 'generated');
    expect(parse(removed, 'generated').map((p) => p.index)).toEqual([1]);
    expect(parse(removed)).toHaveLength(2);
    // 写真の操作も AI 画像に触らない（既定は写真）
    expect(parse(swap(md, 1, 2), 'generated').map((p) => p.heading)).toEqual(['A', 'B']);
    expect(parse(remove(md, 1), 'generated')).toHaveLength(2);
    expect(() => move(md, 3, 0, 'generated')).toThrow('[AI画像3]');
  });

  it('fill は種類ごと。画像の無い番号の目印は消える', () => {
    const md = '[画像1]\n[AI画像1]\n[AI画像2]';
    const out = fill(fill(md, { 1: 'https://p/1.png' }), { 1: 'https://g/1.png' }, { 1: 'alt1' }, 'generated');
    expect(out).toBe('<figure><img src="https://p/1.png"></figure>\n<figure><img src="https://g/1.png" alt="alt1"></figure>\n');
  });
});

describe('listImages は写真だけ（設計書 18-2）', () => {
  it('★AI の文中画像・サムネを写真に数えない（normalize が余計な [画像N] を足さない）／受信順の番号も写真だけ', async () => {
    const { db, sqlite, article, deps } = await setup(BODY, { photos: 1 });
    mockOpenAi();
    await ensureInlineImage(deps, article.id, { slot: 1, heading: '見出し1', prompt: 'x'.repeat(30), altText: 'a' });
    // 生成サムネを写真から外した（is_eyecatch=0 に戻った）状態も作る
    sqlite.prepare(`INSERT INTO images (id, tenant_id, article_id, r2_key, mime_type, size_bytes, line_message_id, is_eyecatch, source, created_at)
      VALUES ('thumb', ?, ?, 'k', 'image/png', 1, 'gen:x', 0, 'generated', '2026-01-01')`).run(DEFAULT_TENANT_ID, article.id);
    expect((await db.listImages(article.id)).map((r) => r.r2_key)).toEqual(['photo0']);
    expect((await db.listAllImages(article.id)).map((r) => r.r2_key)).toEqual(['photo0']);
    expect((await db.listGeneratedImages(article.id)).map((r) => r.gen_slot)).toEqual([1]);
    const md = normalize(BODY, (await db.listImages(article.id)).length);
    expect(parse(md)).toHaveLength(1);
  });
});

// ── 2. 設定 ───────────────────────────────────────────
describe('設定: 文中の画像の枚数（持ち主のみ・キーが無ければ有効にしない）', () => {
  it('★持ち主以外は denied・キー無しは no_key（どちらも何も変えない）', async () => {
    const { db } = await setup();
    expect(await applyInlineSetting(db, { isOwner: false, hasKey: true, action: 'ai_img_set', value: '3', by: 't' })).toBe('denied');
    expect(await applyInlineSetting(db, { isOwner: true, hasKey: false, action: 'ai_img_set', value: '3', by: 't' })).toBe('no_key');
    expect((await getInlineSettings(db)).count).toBe(0);
    expect(await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_img_set', value: '3', by: 't' })).toBe('saved');
    expect((await getInlineSettings(db)).count).toBe(3);
  });

  it('★読めない値は ignored で何も変えない（6・-1・2.5・空・文字・知らない操作）', async () => {
    const { db } = await setup();
    await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_img_set', value: '2', by: 't' });
    for (const v of ['6', '-1', '2.5', '', 'abc', null]) {
      expect(await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_img_set', value: v, by: 't' })).toBe('ignored');
    }
    expect(await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_ilimit_set', value: '7', by: 't' })).toBe('ignored');
    expect(await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_unknown', value: '1', by: 't' })).toBe('ignored');
    expect(await getInlineSettings(db)).toEqual({ count: 2, dailyLimit: 10 });
    expect(await applyInlineSetting(db, { isOwner: true, hasKey: true, action: 'ai_ilimit_set', value: '20', by: 't' })).toBe('saved');
    expect((await getInlineSettings(db)).dailyLimit).toBe(20);
  });

  it('既定は0枚・保存済みの値が壊れていたら0枚で読む・キーが無ければ設定に関わらず0枚', async () => {
    const { db } = await setup();
    expect(await getInlineSettings(db)).toEqual({ count: 0, dailyLimit: 10 });
    await db.setNumberFlag(FLAG_COUNT, 99, '壊れた値', 't');
    await db.setNumberFlag(FLAG_DAILY_LIMIT, 7, '壊れた値', 't');
    expect(await getInlineSettings(db)).toEqual({ count: 0, dailyLimit: 10 });
    await db.setNumberFlag(FLAG_COUNT, 4, '正しい値', 't');
    expect(await effectiveInlineCount(db, KEY)).toBe(4);
    expect(await effectiveInlineCount(db, null)).toBe(0);
    expect(await effectiveInlineCount(db, 'not-a-key')).toBe(0);
  });

  it('★AI設定の画面: キーが無ければ文中の画像の項目もボタンも出さない', () => {
    const r = { mode: 'none' as const, domains: 'any' as const, dailyLimit: 5 };
    const noKey = JSON.stringify(buildAiSettings(r, false, undefined));
    expect(noKey).not.toContain('ai_img');
    const withKey = JSON.stringify(buildAiSettings(r, true, { count: 2, dailyLimit: 10 }));
    expect(withKey).toContain('action=ai_img');
    expect(withKey).toContain('action=ai_ilimit');
    expect(withKey).toContain('1記事2枚');
  });
});

// ── 3. 費用（予約で数える）──────────────────────────────
describe('費用の歯止め: 課金の直前に予約として数える（サムネとは別枠）', () => {
  const item = (slot: number) => ({ slot, heading: `見出し${slot}`, prompt: 'p'.repeat(30), altText: `alt${slot}` });

  it('★描く直前に予約が記録され、失敗しても数えたまま', async () => {
    const { db, article, deps } = await setup();
    let reservedAtCall = -1;
    mockOpenAi({ image: () => { reservedAtCall = -2; return new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }); } });
    const spy = vi.spyOn(db, 'audit');
    const out = await ensureInlineImage(deps, article.id, item(1));
    expect(out.status).toBe('failed');
    expect(reservedAtCall).toBe(-2);
    expect(spy.mock.calls[0][1]).toBe(AUDIT_INLINE_RESERVED);
    expect(await countInlineForArticle(db, article.id)).toBe(1);
    expect(await db.listGeneratedImages(article.id)).toHaveLength(0);
  });

  it('★1記事10回で止まる（11回目は OpenAI を呼ばない）', async () => {
    const { db, sqlite, article, deps } = await setup();
    await db.setNumberFlag(FLAG_DAILY_LIMIT, 50, 't', 't');
    for (let i = 0; i < MAX_INLINE_PER_ARTICLE; i++) await db.audit(DEFAULT_TENANT_ID, AUDIT_INLINE_RESERVED, 'system', article.id, 'ok');
    const net = mockOpenAi();
    const out = await ensureInlineImage(deps, article.id, item(1));
    expect(out).toMatchObject({ status: 'skipped', reason: 'article_limit', stopRest: true });
    expect(net.images).toHaveLength(0);
    // 指示文も作らない（費用をかけない）
    expect((await prepareInlinePlan(deps, article.id)).status).toBe('skipped');
    expect(net.texts).toHaveLength(0);
    expect(sqlite).toBeTruthy();
  });

  it('★1日の上限で止まる。サムネの予約は文中画像の上限に数えない（逆も同じ）', async () => {
    const { db, article, deps } = await setup();
    await db.setNumberFlag(FLAG_DAILY_LIMIT, 5, 't', 't');
    // サムネの予約が10件あっても、文中画像はまだ作れる
    for (let i = 0; i < 10; i++) await db.audit(DEFAULT_TENANT_ID, THUMB_RESERVED, 'system', 'other', 'ok');
    const net = mockOpenAi();
    expect((await ensureInlineImage(deps, article.id, item(1))).status).toBe('created');
    expect(await countGeneratedToday(db, DEFAULT_TENANT_ID)).toBe(10); // 文中画像はサムネに数えない
    expect(await countInlineToday(db, DEFAULT_TENANT_ID)).toBe(1);
    for (let i = 0; i < 4; i++) await db.audit(DEFAULT_TENANT_ID, AUDIT_INLINE_RESERVED, 'system', 'other', 'ok');
    const out = await ensureInlineImage(deps, article.id, item(2));
    expect(out).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
    expect(net.images).toHaveLength(1);
  });

  it('★残高不足が出たら残りの枚数は呼ばない（呼び出しは1回）。理由は残る', async () => {
    const { db, article, deps } = await setup();
    await db.setNumberFlag(FLAG_COUNT, 2, 't', 't');
    const net = mockOpenAi({ image: () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 }) });
    const reasons = await runInlineImageSteps(syncStep, deps, article.id);
    expect(net.images).toHaveLength(1);
    expect(reasons.join()).toContain('残高');
  });

  it('自動の呼び出しでは、すでにある番号を作り直さない（処理のやり直しで二重課金しない）', async () => {
    const { article, deps } = await setup();
    const net = mockOpenAi();
    await runInlineImageSteps(syncStep, deps, article.id);
    expect(net.images).toHaveLength(2);
    await runInlineImageSteps(syncStep, deps, article.id);
    expect(net.images).toHaveLength(2);
    expect(net.texts).toHaveLength(1); // 2回目は指示文も作らない
  });

  it('gpt-image-2・サイズ 1536x800 で描く', async () => {
    const { article, deps } = await setup();
    const net = mockOpenAi();
    await ensureInlineImage(deps, article.id, item(1));
    expect(net.images[0]).toMatchObject({ model: 'gpt-image-2', size: '1536x800', n: 1 });
  });
});

// ── 4. 0枚・キー無し ──────────────────────────────────────
describe('★0枚のとき・キーが無いとき、画像 API の呼び出しは0回', () => {
  it('generateArticle → 文中画像の step まで通しても、0枚設定なら画像 API は0回・本文に [AI画像N] が無い', async () => {
    const { db, article, deps } = await setup('', { photos: 1, fresh: true });
    const net = mockOpenAi();
    const { article: done } = await generateArticle(serviceDeps(db), article.id);
    expect(parse(done.body_md!, 'generated')).toHaveLength(0);
    expect(parse(done.body_md!)).toHaveLength(1);
    await runInlineImageSteps(syncStep, deps, article.id);
    expect(net.images).toHaveLength(0);
    expect(net.texts.some((t) => t.includes('挿絵'))).toBe(false);
  });

  it('キーが無い環境では、設定が3枚でも本文に AI 画像を置かず、画像 API も呼ばない', async () => {
    const { db, article, deps } = await setup('', { fresh: true });
    await db.setNumberFlag(FLAG_COUNT, 3, 't', 't');
    // OpenAI のキーが無い＝文章は Claude の環境（既存の顧客）。文章の偽物は Claude、画像の通信は数えるだけ
    const net: Net = { images: [], texts: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u === IMAGES_URL) { net.images.push({}); return new Response('{}', { status: 500 }); }
      if (u.includes('api.anthropic.com')) {
        const user = String((JSON.parse(String((init as RequestInit).body)) as { messages: Array<{ content: string }> }).messages[0].content);
        net.texts.push(user);
        const inner = await writer(user).json() as { output: Array<{ content: Array<{ text: string }> }> };
        return new Response(JSON.stringify({ content: [{ type: 'text', text: inner.output[0].content[0].text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }
      throw new Error(`想定外の通信: ${u}`);
    });
    const claudeDeps = { ...serviceDeps(db, memStore(), null), llm: { provider: 'anthropic', anthropicKey: 'sk-ant-test', openaiKey: null } } as ServiceDeps;
    const { article: done } = await generateArticle(claudeDeps, article.id);
    // 本文は書けている。写真0＋AI 0 で書かせた（「画像が 3 枚」と頼んでいない）
    expect(done.body_md).toContain('## 見出し1');
    expect(net.texts.some((t) => t.includes('画像が 0 枚'))).toBe(true);
    expect(parse(done.body_md ?? '', 'generated')).toHaveLength(0);
    expect(await runInlineImageSteps(syncStep, { ...deps, openaiKey: null }, article.id)).toEqual([]);
    expect(net.images).toHaveLength(0);
  });
});

// ── 5. 生成の流れ ───────────────────────────────────────
describe('生成: 写真 k 枚＋生成 m 枚で書かせ、保存の直前に分ける', () => {
  it('★写真1・AI 2: 本文は [画像1] と [AI画像1][AI画像2]。写真の alt だけ残す。AI 画像は1枚ずつ作られる', async () => {
    const { db, article, deps } = await setup('', { photos: 1, fresh: true });
    await db.setNumberFlag(FLAG_COUNT, 2, 't', 't');
    const net = mockOpenAi();
    const { article: done, charCount } = await generateArticle(serviceDeps(db), article.id);
    expect(parse(done.body_md!).map((p) => p.index)).toEqual([1]);
    expect(parse(done.body_md!, 'generated').map((p) => [p.index, p.heading])).toEqual([[1, '見出し2'], [2, '見出し3']]);
    expect(JSON.parse(done.image_alts_json!)).toEqual({ 1: '写真のalt' });
    expect(charCount).toBe(done.body_md!.replace(/\[(?:AI)?画像\d+\]/g, '').length);

    const reasons = await runInlineImageSteps(syncStep, deps, article.id);
    expect(reasons).toEqual([]);
    expect(net.images).toHaveLength(2);
    expect(net.texts.filter((t) => t.includes('挿絵'))).toHaveLength(1); // 指示文は1記事1回
    const rows = await db.listGeneratedImages(article.id);
    expect(rows.map((r) => [r.gen_slot, r.gen_heading, r.alt_text])).toEqual([[1, '見出し2', '挿絵1'], [2, '見出し3', '挿絵2']]);
  });

  it('★失敗しても記事は届く: 指示文の失敗・1枚の失敗・step の落下で、理由が返り、失敗した番号は公開 HTML から消える', async () => {
    // 指示文の失敗
    {
      const { article, deps } = await setup();
      const net = mockOpenAi({ plan: () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 }) });
      const reasons = await runInlineImageSteps(syncStep, deps, article.id);
      expect(reasons.join()).toContain('下ごしらえ');
      expect(net.images).toHaveLength(0);
    }
    vi.restoreAllMocks();
    // 1枚目だけ安全基準で断られる → 2枚目は作る
    {
      const { db, article, deps } = await setup();
      mockOpenAi({ image: (n) => (n === 1
        ? new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'x' } }), { status: 400 })
        : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 })) });
      const reasons = await runInlineImageSteps(syncStep, deps, article.id);
      expect(reasons.join()).toContain('安全基準');
      expect((await db.listGeneratedImages(article.id)).map((r) => r.gen_slot)).toEqual([2]);
      const a = (await db.getArticle(article.id))!;
      const view = inlineViewOf(listGeneratedSlots(a.body_md!), await db.listGeneratedImages(article.id), { hasKey: true, reasons });
      expect(view).toMatchObject({ slots: 2, created: [2], missing: 1 });
      const html = renderWithPlaceholders(a, 0, [{ slot: 2, alt: 'x' }]);
      expect(html).not.toContain('AI画像1');
      expect(html).toContain(generatedImageUrlPlaceholder(2));
      // プレビューに件数と理由が出る（同じ Flex の中）
      const preview = JSON.stringify(buildPreview({ articleId: a.id, title: 't', markdown: a.body_md!, metaDescription: '', hashtags: [], charCount: 1, inlineImages: view }));
      expect(preview).toContain('文中画像 1枚（AIが作成）');
      expect(preview).toContain('作れなかった画像が1枚あります：OpenAI の安全基準で断られました');
      expect(preview).toContain('AI画像2');
      expect(preview).not.toContain('AI画像1"');
      expect(preview).toContain('action=inline_regen');
    }
    vi.restoreAllMocks();
    // step そのものが落ちる
    {
      const { article, deps } = await setup();
      mockOpenAi();
      const throwing: StepDo = async (name, _c, fn) => { if (name.includes('作る 1')) throw new Error('step timed out'); return fn(); };
      const reasons = await runInlineImageSteps(throwing, deps, article.id);
      expect(reasons.join()).toContain('打ち切り');
      const stopAll: StepDo = async () => { throw new Error('step timed out'); };
      expect((await runInlineImageSteps(stopAll, deps, article.id))[0]).toContain('止まりました');
    }
  });
});

// ── 6. 指示文 ──────────────────────────────────────────
describe('指示文: 禁止事項とナレッジ', () => {
  it('★文字・実在人物・ロゴ・画風・実物写真風・before/after の禁止がプロンプトに入っている', () => {
    for (const s of ['文字を入れない', '日本語の文字は絶対に入れない', '実在の人物', 'ロゴ', '商標', '画風を指定しない', '実物の写真」に見える絵にしない', 'before/after', '避けること']) {
      expect(INLINE_PLAN_SYSTEM).toContain(s);
    }
  });

  it('見出しと前後の文・ナレッジ（避けること）を1回でまとめて渡す（heavy）', async () => {
    const { db, article, deps } = await setup();
    await db.saveContext(DEFAULT_TENANT_ID, '避けること: 医療機関と誤解される表現。画風: 水彩', {}, '避けること: 医療機関と誤解される表現。画風: 水彩');
    const net = mockOpenAi();
    const plan = await prepareInlinePlan(deps, article.id);
    expect(plan.status).toBe('ok');
    const input = net.texts.find((t) => t.includes('挿絵'))!;
    expect(input).toContain('slot 1: 見出し「見出し1」');
    expect(input).toContain('一つ目の本文。');
    expect(input).toContain('slot 2: 見出し「見出し3」');
    expect(input).toContain('避けること: 医療機関と誤解される表現');
    expect(buildInlinePlanUser({ title: 't', slots: [], knowledge: null })).not.toContain('ナレッジ');
  });
});

// ── 7. 修正時の使い回し ───────────────────────────────────
describe('修正: 前回の画像を使い回す（設計書 18-7・承認済みの方針④）', () => {
  const old = [
    { id: 'a', slot: 1, heading: '見出しA' },
    { id: 'b', slot: 2, heading: '見出しB' },
    { id: 'c', slot: 3, heading: '見出しC' },
  ];

  it('見出しが同じものはその画像、残りは前回の順番どおり', () => {
    const r = planGeneratedReuse(old, [
      { slot: 1, heading: '見出しC' }, { slot: 2, heading: '新しい見出し' }, { slot: 3, heading: '見出しA' },
    ]);
    expect(r.assign).toEqual([{ slot: 1, imageId: 'c' }, { slot: 2, imageId: 'b' }, { slot: 3, imageId: 'a' }]);
    expect(r.missing).toEqual([]);
    expect(r.leftover).toEqual([]);
  });

  it('見出しが1つも合わなければ順番どおり／新しいほうが多ければ足りない分だけ新規／少なければ余りは消す', () => {
    const none = planGeneratedReuse(old, [{ slot: 1, heading: 'x' }, { slot: 2, heading: 'y' }, { slot: 3, heading: 'z' }]);
    expect(none.assign.map((x) => x.imageId)).toEqual(['a', 'b', 'c']);
    const more = planGeneratedReuse(old.slice(0, 2), [{ slot: 1, heading: '見出しB' }, { slot: 2, heading: 'y' }, { slot: 3, heading: 'z' }]);
    expect(more.assign).toEqual([{ slot: 1, imageId: 'b' }, { slot: 2, imageId: 'a' }]);
    expect(more.missing).toEqual([3]);
    const fewer = planGeneratedReuse(old, [{ slot: 1, heading: '見出しB' }]);
    expect(fewer.assign).toEqual([{ slot: 1, imageId: 'b' }]);
    expect(fewer.leftover).toEqual(['a', 'c']);
    expect(planGeneratedReuse([], [{ slot: 1, heading: 'x' }]).missing).toEqual([1]);
  });

  it('★作り直し（generateArticle）で同じ枚数なら新規0枚・増えた分だけ新規・0枚設定なら前回の画像は消える', async () => {
    const { db, article, images, deps } = await setup('', { photos: 0, fresh: true });
    await db.setNumberFlag(FLAG_COUNT, 2, 't', 't');
    const net = mockOpenAi();
    const sdeps = serviceDeps(db, images);
    await generateArticle(sdeps, article.id);
    await runInlineImageSteps(syncStep, { ...deps, images }, article.id);
    expect(net.images).toHaveLength(2);
    const firstIds = (await db.listGeneratedImages(article.id)).map((r) => r.id);

    // 同じ枚数で本文を作り直す → 新規0枚（使い回し）
    await toEditing(db, article.id);
    await generateArticle(sdeps, article.id);
    await runInlineImageSteps(syncStep, { ...deps, images }, article.id);
    expect(net.images).toHaveLength(2);
    expect((await db.listGeneratedImages(article.id)).map((r) => r.id)).toEqual(firstIds);

    // 3枚に増やして作り直す → 増えた1枚だけ新規
    await db.setNumberFlag(FLAG_COUNT, 3, 't', 't');
    await toEditing(db, article.id);
    await generateArticle(sdeps, article.id);
    await runInlineImageSteps(syncStep, { ...deps, images }, article.id);
    expect(net.images).toHaveLength(3);
    expect(await db.listGeneratedImages(article.id)).toHaveLength(3);

    // 0枚にして作り直す → 新規0・前回の画像は使わない（行も置き場も消える）
    await db.setNumberFlag(FLAG_COUNT, 0, 't', 't');
    await toEditing(db, article.id);
    const { article: zero } = await generateArticle(sdeps, article.id);
    await runInlineImageSteps(syncStep, { ...deps, images }, article.id);
    expect(net.images).toHaveLength(3);
    expect(parse(zero.body_md!, 'generated')).toHaveLength(0);
    expect(await db.listGeneratedImages(article.id)).toHaveLength(0);
    expect([...images.m.keys()].some((k) => k.startsWith('gen_inline_'))).toBe(false);
  });

  it('見出しが変わった場所に使い回したら、プレビューで知らせて作り直しボタンを出す', async () => {
    const { db, article, images, deps } = await setup();
    mockOpenAi();
    await runInlineImageSteps(syncStep, deps, article.id);
    await reuseGeneratedImages(db, images, article.id, '## 別の見出し\n[AI画像1]\n## 見出し3\n[AI画像2]');
    const a = { id: article.id, body_md: '## 別の見出し\n[AI画像1]\n## 見出し3\n[AI画像2]' };
    const view = inlineViewOf(listGeneratedSlots(a.body_md), await db.listGeneratedImages(article.id), { hasKey: true });
    expect(view.reusedMismatch).toBe(true);
    const preview = JSON.stringify(buildPreview({ articleId: a.id, title: 't', markdown: a.body_md, metaDescription: '', hashtags: [], charCount: 1, inlineImages: view }));
    expect(preview).toContain('前回のものを使っています');
    expect(preview).toContain('文中画像を作り直す');
  });

  it('★作り直しボタン（force）: 本文にある番号すべてを作り直し、上限に数える。失敗した番号は前の画像のまま', async () => {
    const { db, article, deps } = await setup();
    const net = mockOpenAi({ image: (n) => (n === 4
      ? new Response('{}', { status: 400 })
      : new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 })) });
    await runInlineImageSteps(syncStep, deps, article.id);
    const before = await db.listGeneratedImages(article.id);
    await runInlineImageSteps(syncStep, deps, article.id, { force: true, prefix: '作り直し: ' });
    expect(net.images).toHaveLength(4);
    expect(await countInlineForArticle(db, article.id)).toBe(4);
    const after = await db.listGeneratedImages(article.id);
    expect(after.find((r) => r.gen_slot === 1)!.id).not.toBe(before.find((r) => r.gen_slot === 1)!.id);
    expect(after.find((r) => r.gen_slot === 2)!.id).toBe(before.find((r) => r.gen_slot === 2)!.id);
  });

  it('位置だけの修正（AI画像の移動・削除）は課金0・写真に触らない', async () => {
    const { db, article } = await setup(BODY, { photos: 1 });
    const net = mockOpenAi();
    const sdeps = serviceDeps(db);
    const moved = await reviseImagePosition(sdeps, article.id, { action: 'move', index: 2, headingIndex: 0 }, 'generated');
    expect(moved.message).toBe('[AI画像2] を「見出し1」の下に移動しました');
    expect(parse(moved.markdown).map((p) => p.heading)).toEqual(['見出し2']);
    const removed = await reviseImagePosition(sdeps, article.id, { action: 'remove', index: 1 }, 'generated');
    expect(parse(removed.markdown, 'generated').map((p) => p.index)).toEqual([2]);
    expect(net.images).toHaveLength(0);
    expect(net.texts).toHaveLength(0);
  });

  it('意図分類の imageKind は既定で写真。知らない値も写真として読む', () => {
    expect(RevisionIntent.parse({ action: 'move_image' }).imageKind).toBe('photo');
    expect(RevisionIntent.parse({ action: 'move_image', imageKind: 'generated' }).imageKind).toBe('generated');
    expect(RevisionIntent.parse({ action: 'move_image', imageKind: 'weird' }).imageKind).toBe('photo');
  });
});

// ── 8. 公開 HTML ───────────────────────────────────────
const NOTE_PHOTO = 'https://assets.st-note.com/img/photo.png';
const NOTE_AI = 'https://assets.st-note.com/img/ai.png';

describe('公開 HTML: [AI画像N] が正しい画像 URL になり、許可外リンクは今どおり止まる', () => {
  it('★下書き保存（サーバー）: 生成画像も note に上げて差し込み、リンク検査を通る。AI 作成の1行が入る', async () => {
    const { db, article, images, deps } = await setup(BODY, { photos: 1 });
    mockOpenAi();
    await runInlineImageSteps(syncStep, deps, article.id);
    vi.restoreAllMocks();
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      calls.push(u);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (u.includes('/v2/current_user')) return json({ id: 1, urlname: 'test', nickname: 't' });
      if (u.endsWith('/v1/text_notes')) return json({ id: 123, key: 'nabc', slug: 'slug-nabc' });
      if (u.includes('text_note_picture')) {
        const file = (init as RequestInit).body as FormData;
        const name = (file.get('file') as File).name;
        return json({ url: name.startsWith('ai-') ? NOTE_AI.replace('ai', name.replace('.png', '')) : NOTE_PHOTO });
      }
      return json({});
    });
    await saveArticleAsDraft(serviceDeps(db, images), article.id);
    const saved = (await db.getArticle(article.id))!;
    expect(saved.state).toBe('drafted');
    expect(saved.body_html).toContain(NOTE_PHOTO);
    expect(saved.body_html).toContain('https://assets.st-note.com/img/ai-image1.png');
    expect(saved.body_html).toContain('https://assets.st-note.com/img/ai-image2.png');
    expect(saved.body_html).toContain('alt="挿絵1"');
    expect(saved.body_html).not.toContain('AI画像');
    expect(saved.body_html).toContain('※記事中の一部の画像は、AIで作成したイメージです。');
    expect(calls.filter((u) => u.includes('text_note_picture'))).toHaveLength(3);
    const rows = await db.listGeneratedImages(article.id);
    expect(rows.map((r) => r.slot_index)).toEqual([101, 102]);
  });

  it('★拡張の手順書: 目印は {{image(100+N)_url}}。検査を通り、生成画像の id が取りに来てよい画像に入る', async () => {
    const { db, article, images, deps } = await setup(BODY, { photos: 1 });
    mockOpenAi();
    await runInlineImageSteps(syncStep, deps, article.id);
    const plan = await buildPlan({ db, images }, (await db.getArticle(article.id))!, 'draft');
    const ids = plan.steps.map((s) => s.id);
    expect(ids).toEqual(['create', 'image1', 'image101', 'image102', 'draft_save']);
    const body = (plan.steps.find((s) => s.id === 'draft_save')!.json as { body: string }).body;
    expect(body).toContain('{{image1_url}}');
    expect(body).toContain('{{image101_url}}');
    expect(body).toContain('{{image102_url}}');
    expect(body).toContain('AIで作成したイメージです');
    expect(plan.steps.find((s) => s.id === 'image101')!.capture).toEqual({ image101_url: 'url' });
  });

  it('純関数: 目印は AI 画像の番号の分だけ許可。許可外リンクは今どおり拾う', () => {
    const html = '<figure><img src="{{image1_url}}"></figure><figure><img src="{{image101_url}}"></figure><figure><img src="{{image103_url}}"></figure>';
    expect(findArticleLinkProblems(html, [], 1, [1, 3])).toEqual([]);
    expect(findArticleLinkProblems(html, [], 1, [1])).toEqual(['{{image103_url}}']);
    expect(findArticleLinkProblems(html, [], 1)).toEqual(['{{image101_url}}', '{{image103_url}}']);
    const evil = toNoteHtml(composeArticleMarkdown({
      bodyMd: '## A\n[AI画像1]\n本文 https://evil.example/x', photoCount: 0, photoUrls: {}, photoAlts: {},
      generated: { 1: { url: NOTE_AI } },
    }));
    expect(findArticleLinkProblems(evil, buildAllowedLinks({ trustedTexts: [], imageUrls: [NOTE_AI] }))).toEqual(['https://evil.example/x']);
  });

  it('★AI 作成の1行: AI 画像が1枚でも入ったときだけ。写真だけ・作れなかった・0枚では入らない。文末のリンク1行の手前に入る', () => {
    const base = { photoAlts: {} };
    const only = composeArticleMarkdown({ ...base, bodyMd: '## A\n[AI画像1]', photoCount: 0, photoUrls: {}, generated: { 1: { url: NOTE_AI } } });
    expect(only).toContain(aiImageNote(false));
    const mixed = composeArticleMarkdown({ ...base, bodyMd: '## A\n[画像1]\n[AI画像1]', photoCount: 1, photoUrls: { 1: NOTE_PHOTO }, generated: { 1: { url: NOTE_AI } } });
    expect(mixed).toContain(aiImageNote(true));
    expect(composeArticleMarkdown({ ...base, bodyMd: '## A\n[画像1]', photoCount: 1, photoUrls: { 1: NOTE_PHOTO } })).not.toContain('AIで作成');
    expect(composeArticleMarkdown({ ...base, bodyMd: '## A\n[AI画像1]', photoCount: 0, photoUrls: {}, generated: {} })).not.toContain('AIで作成');
    expect(composeArticleMarkdown({ ...base, bodyMd: '## A\n本文', photoCount: 0, photoUrls: {}, generated: { 1: { url: NOTE_AI } } })).not.toContain('AIで作成');
    const link = composeArticleMarkdown({ ...base, bodyMd: '## A\n[AI画像1]\n\n[ご予約はこちら](https://shop.example.jp/r)', photoCount: 0, photoUrls: {}, generated: { 1: { url: NOTE_AI } } });
    expect(link.trimEnd().endsWith('[ご予約はこちら](https://shop.example.jp/r)')).toBe(true);
    expect(link.indexOf('AIで作成')).toBeLessThan(link.indexOf('[ご予約はこちら]'));
  });

  it('本文に [AI画像N] が無い記事（P3 より前）は、生成画像の一覧を読まない', async () => {
    const article = { id: 'a', tenant_id: DEFAULT_TENANT_ID, body_md: '## 見出し\n[画像1]', image_alts_json: null } as unknown as ArticleRow;
    const db = { listImages: async () => [{}], listGeneratedImages: async () => { throw new Error('読んではいけない'); } } as unknown as Db;
    await precheckArticleLinks(db, article, 'publish');
  });
});

describe('表示: プレビュー・全文', () => {
  it('プレビューの構成に 🎨 AI画像N（写真の 🖼 と区別）・本文に AI 画像が無ければ何も出さない', () => {
    const p = JSON.stringify(buildPreview({ articleId: 'x', title: 't', markdown: BODY, metaDescription: '', hashtags: [], charCount: 1,
      inlineImages: { slots: 2, created: [1, 2], missing: 0, reasons: [], reusedMismatch: false, canRegenerate: true } }));
    expect(p).toContain('🎨');
    expect(p).toContain('AI画像1');
    expect(p).toContain('文中画像 2枚（AIが作成）');
    expect(p).not.toContain('作れなかった');
    const none = JSON.stringify(buildPreview({ articleId: 'x', title: 't', markdown: '## A\n本文', metaDescription: '', hashtags: [], charCount: 1 }));
    expect(none).not.toContain('文中画像');
    expect(none).not.toContain('inline_regen');
  });

  it('全文表示でも AI 画像を写真と見分けられる', () => {
    expect(toLineText('## A\n[AI画像1]\n[画像1]')).toContain('🎨 AI画像1');
    expect(toLineText('## A\n[AI画像1]\n[画像1]')).toContain('[画像1]');
  });
});
