/**
 * 画像のルール・参考画像・題名モード・検品（2026-10-26 設計書 docs/design-image-rules-2026-10-26.md）。
 *
 * ★守っていること
 *  - 何も登録しなければ、今までと完全に同じ呼び出し（指示文・画像モデルへの送信・数え方）
 *  - 題名はコードが一字一句そのまま入れる（LLM に言い換えさせない）
 *  - 参考画像があれば images/edits（gpt-image-2 固定・最大3枚・見た目だけ使う固定文）
 *  - 検品で上限まで不合格なら画像を保存しない。検品できないときは未検品で採用
 *  - 1記事の上限は「実行」の数。生成1回ごとの予約は1日の上限に数える
 *  - 画面の書き込みはワンタイムコード必須。登録した本文・画像そのものは画面に出さない
 * 外部には一切通信しない（fetch をモック）。画像は小さなダミーバイト列。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { OpenAiImageClient, EDIT_API, IMAGE_MODEL, MAX_REFERENCE_IMAGES, IMAGE_TIMEOUT_MS } from '../../src/ports/image/openai';
import {
  ensureThumbnail, setThumbDailyLimit, buildPlanSystem, buildPlanUser, composeThumbPrompt, inspectThumbnail,
  countRunsForArticle, countGeneratedToday, countGenerationsForArticle, PLAN_SYSTEM, PLAN_SYSTEM_TITLE, MAX_PER_ARTICLE,
  MAX_GENERATIONS_PER_ARTICLE, THUMB_RUN_BUDGET_MS,
  AUDIT_RESERVED, AUDIT_RUN, AUDIT_INSPECTED,
} from '../../src/core/image/thumbnail';
import {
  ensureInlineImage, buildInlinePlanUser, buildInlinePlanSystem, INLINE_PLAN_SYSTEM, prepareInlinePlan,
} from '../../src/core/image/inline';
import {
  saveImageRules, getImageRules, addImageRef, deleteImageRef, checkRefUpload, sniffImageMime, normalizeRefName,
  loadReferenceImages, loadImageRulesSummary, titleClause,
  REFERENCE_CLAUSE, RULE_BODY_MAX, REF_MAX_BYTES, REF_MAX_COUNT,
} from '../../src/core/image/rules';
import { REQUIRED_COLUMNS } from '../../src/core/setup/schema-check';
import { setupRouter, NEED_SETUP_FIRST } from '../../src/adapters/setup/router';
import { issueSetupCode, SETUP_DONE_KV } from '../../src/core/setup/state';
import { buildImageRulesSummary } from '../../src/adapters/line/messages/image-rules';
import { buildAiSettings } from '../../src/adapters/line/messages/research';
import { buildThumbnailResult } from '../../src/adapters/line/messages/thumbnail';
import type { Llm } from '../../src/ports/llm/types';
import { runThumbnailStep, THUMB_STEP_STOPPED_NOTE } from '../../src/workflows/generate-step';
import { signLineBody } from '../../src/adapters/line/signature';
import { OWNER_ONLY_MESSAGE } from '../../src/core/line/access';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

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

// ── 小さなダミー画像（先頭バイトだけ本物の形式）──────────────────
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).buffer;
const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]).buffer;
const WEBP = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]).buffer;
const GIF = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]).buffer;
const PNG_B64 = Buffer.from(new Uint8Array(PNG())).toString('base64');

function memStore() {
  const m = new Map<string, { bytes: ArrayBuffer; type: string; persistent: boolean }>();
  return {
    m,
    put: async (k: string, b: ArrayBuffer, t: string, o?: { persistent?: boolean }) => { m.set(k, { bytes: b, type: t, persistent: Boolean(o?.persistent) }); },
    get: async (k: string) => (m.has(k) ? { bytes: m.get(k)!.bytes, contentType: m.get(k)!.type } : null),
    delete: async (k: string) => { m.delete(k); },
  };
}

const TITLE = '初心者でも楽しめる｜週末の体験会レポート';
const PLAN_PROMPT = 'A bright flat illustration of a smiling coach at an indoor court, wide composition, soft colors, clear sky area at top';

async function setup() {
  const sqlite = migrate();
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  const article = await db.createArticle(DEFAULT_TENANT_ID, 'テスト');
  await db.updateArticle(article.id, { title: TITLE, meta_description: '要約', body_md: '## 見出し1\n本文です。\n## 見出し2\n続き' });
  const images = memStore();
  const deps = { db, images, llm: { provider: 'openai', openaiKey: 'sk-openai-test' }, openaiKey: 'sk-openai-test' as string | null };
  return { db, sqlite, article, images, deps };
}

type Verdict = { pass: boolean; titleExact?: boolean | null; issues?: string[] } | 'error';

interface Net {
  gen: Array<Record<string, unknown>>;
  edit: FormData[];
  plans: Array<{ instructions: string; input: string }>;
  visions: number;
}

/** OpenAI だけを相手にする偽の通信。指示文づくり（文字の input）と検品（画像つきの input）を見分ける */
function mockOpenAi(verdicts: Verdict[] = [], opts: { plan?: Record<string, unknown> } = {}): Net {
  const net: Net = { gen: [], edit: [], plans: [], visions: 0 };
  const queue = [...verdicts];
  const ok = (text: string) => new Response(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 5 },
  }), { status: 200 });
  const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u === 'https://api.openai.com/v1/images/generations') { net.gen.push(JSON.parse(String(init!.body))); return image(); }
    if (u === EDIT_API) { net.edit.push(init!.body as FormData); return image(); }
    if (u === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(String(init!.body));
      if (Array.isArray(body.input)) {
        net.visions++;
        const v = queue.shift() ?? { pass: true, titleExact: true, issues: [] };
        if (v === 'error') return new Response('{"error":{"message":"down"}}', { status: 500 });
        return ok(JSON.stringify(v));
      }
      net.plans.push({ instructions: body.instructions, input: body.input });
      return ok(JSON.stringify(opts.plan ?? { prompt: PLAN_PROMPT, altText: 'コーチのイラスト' }));
    }
    throw new Error(`想定外の通信: ${u}`);
  });
  return net;
}

const countAudit = (sqlite: DatabaseSync, action: string, target?: string) => (sqlite
  .prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action = ?${target ? ' AND target = ?' : ''}`)
  .get(...(target ? [action, target] : [action])) as { c: number }).c;

// ── 1. 指示文の組み立て ──────────────────────────────────
describe('指示文の組み立て', () => {
  it('★ルールも題名も参考画像も無ければ、今までの指示文そのもの', () => {
    expect(buildPlanSystem({ titleMode: 'none', hasRules: false, hasRefs: false })).toBe(PLAN_SYSTEM);
    const base = { title: 'T', metaDescription: 'M', headings: ['H'], excerpt: 'E', knowledge: 'K' };
    expect(buildPlanUser({ ...base, rules: null, refNames: [] })).toBe(buildPlanUser(base));
    expect(buildInlinePlanSystem({ hasRules: false, hasRefs: false })).toBe(INLINE_PLAN_SYSTEM);
    const ib = { title: 'T', slots: [{ slot: 1, heading: 'H', excerpt: 'E' }], knowledge: null };
    expect(buildInlinePlanUser({ ...ib, rules: null })).toBe(buildInlinePlanUser(ib));
  });

  it('題名モードでは「日本語を入れない」「英単語2語まで」を外し、題名の余白を作らせる', () => {
    expect(PLAN_SYSTEM).toContain('日本語の文字は絶対に入れない');
    expect(PLAN_SYSTEM_TITLE).not.toContain('日本語の文字は絶対に入れない');
    expect(PLAN_SYSTEM_TITLE).not.toContain('最大2語');
    expect(PLAN_SYSTEM_TITLE).toContain('余白');
    // 安全の禁止は残る
    expect(PLAN_SYSTEM_TITLE).toContain('ロゴ');
    expect(PLAN_SYSTEM_TITLE).toContain('生肉');
  });

  it('ルールは「最優先」として渡し、固定の安全ルールはルールより優先と明記する', () => {
    const sys = buildPlanSystem({ titleMode: 'none', hasRules: true, hasRefs: false });
    expect(sys).toContain('この顧客の画像ルール');
    expect(sys).toContain('安全ルールは顧客の画像ルールよりも優先');
    for (const w of ['実在の人物', 'ロゴ', '生肉', '記事に書かれていない']) expect(sys).toContain(w);
    const user = buildPlanUser({ title: 'T', metaDescription: '', headings: [], excerpt: 'E', knowledge: null, rules: '水彩風で描く' });
    expect(user).toContain('【この顧客の画像ルール（最優先）】\n水彩風で描く');
  });

  it('★題名はコードが一字一句そのまま入れる。題名なし・参考画像なしなら指示文そのまま', () => {
    expect(composeThumbPrompt({ planPrompt: PLAN_PROMPT, titleMode: 'none', title: TITLE, hasRefs: false })).toBe(PLAN_PROMPT);
    const p = composeThumbPrompt({ planPrompt: PLAN_PROMPT, titleMode: 'title', title: TITLE, hasRefs: true, feedback: ['靴にロゴ'] });
    expect(p.startsWith(PLAN_PROMPT)).toBe(true);
    expect(p).toContain(`「${TITLE}」`);
    expect(p).toContain('一字一句そのまま');
    expect(p).toContain('ほかの文字は入れない');
    expect(p).toContain(REFERENCE_CLAUSE);
    expect(p).toContain('前回の画像の問題点（必ず直す）: 靴にロゴ');
    expect(titleClause('A\nB')).toContain('「A B」');
  });

  it('参考画像の固定文は、見た目だけ使い、ポーズを写さない', () => {
    for (const w of ['見た目（顔・髪・服・体型・小物）だけ', 'ポーズ・構図・差し出す手', '新しいポーズ', 'キャラクターシート']) {
      expect(REFERENCE_CLAUSE).toContain(w);
    }
  });
});

// ── 2. 参考画像つきの送信（images/edits）──────────────────────
describe('参考画像つきの送信（images/edits）', () => {
  it('★multipart の中身: モデルは gpt-image-2 固定・最大3枚・medium・1枚', async () => {
    const net = mockOpenAi();
    const refs = [PNG(), JPEG(), WEBP(), PNG()].map((bytes, i) => ({ bytes, mime: ['image/png', 'image/jpeg', 'image/webp', 'image/png'][i] }));
    await new OpenAiImageClient('sk-x').edit('描いて', refs);
    expect(net.edit).toHaveLength(1);
    const f = net.edit[0];
    expect(f.get('model')).toBe(IMAGE_MODEL);
    expect(IMAGE_MODEL).toBe('gpt-image-2');
    expect(f.get('prompt')).toBe('描いて');
    expect(f.get('size')).toBe('1536x800');
    expect(f.get('quality')).toBe('medium');
    expect(f.get('n')).toBe('1');
    const imgs = f.getAll('image[]') as File[];
    expect(imgs).toHaveLength(MAX_REFERENCE_IMAGES);
    expect(imgs.map((x) => x.type)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(imgs[0].name).toBe('ref1.png');
    expect(net.gen).toHaveLength(0);
  });

  it('参考画像が0枚なら、従来の generations を使う', async () => {
    const net = mockOpenAi();
    await new OpenAiImageClient('sk-x').edit('描いて', []);
    expect(net.gen).toHaveLength(1);
    expect(net.edit).toHaveLength(0);
  });

  it('★200 で返ったのに画像が読めなかったら、やり直さない（課金済みかもしれないため）', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls++; return new Response('{"data":[]}', { status: 200 }); });
    const e = await new OpenAiImageClient('sk-x').edit('p', [{ bytes: PNG(), mime: 'image/png' }]).catch((x) => x);
    expect(e.kind).toBe('temp');
    expect(calls).toBe(1);
  });
});

// ── 3. ルール未登録なら今までと同じ ─────────────────────────────
describe('★回帰: 何も登録しなければ、今までと同じ呼び出し', () => {
  it('generations を1回・検品なし・指示文は従来の system・送る指示は指示文そのもの', async () => {
    const { deps, db, article, sqlite } = await setup();
    const net = mockOpenAi();
    const out = await ensureThumbnail(deps, article.id);
    expect(out.status).toBe('created');
    expect(net.gen).toHaveLength(1);
    expect(net.edit).toHaveLength(0);
    expect(net.visions).toBe(0);
    expect(net.gen[0].prompt).toBe(PLAN_PROMPT);
    expect(net.plans[0].instructions.startsWith(PLAN_SYSTEM)).toBe(true);
    expect(net.plans[0].instructions).not.toContain('この顧客の画像ルール');
    expect(countAudit(sqlite, AUDIT_INSPECTED)).toBe(0);
    expect(await db.getEyecatch(article.id)).toBeTruthy();
  });

  it('文中画像も、登録が無ければ generations で描き、指示文は従来どおり', async () => {
    const { deps, db, article } = await setup();
    await db.updateArticle(article.id, { body_md: '## 見出し1\n本文\n[AI画像1]\n' });
    const net = mockOpenAi([], { plan: { images: [{ slot: 1, prompt: PLAN_PROMPT, altText: '挿絵' }] } });
    const plan = await prepareInlinePlan(deps, article.id);
    expect(plan.status).toBe('ok');
    expect(net.plans[0].instructions.startsWith(INLINE_PLAN_SYSTEM)).toBe(true);
    expect(net.plans[0].instructions).not.toContain('この顧客の画像ルール');
    const out = await ensureInlineImage(deps, article.id, { slot: 1, heading: '見出し1', prompt: PLAN_PROMPT, altText: '挿絵' });
    expect(out.status).toBe('created');
    expect(net.gen).toHaveLength(1);
    expect(net.gen[0].prompt).toBe(PLAN_PROMPT);
    expect(net.edit).toHaveLength(0);
  });
});

// ── 4. 題名モード・参考画像・ルール本文の反映 ─────────────────────
describe('題名モード・参考画像・ルール', () => {
  it('★題名モード: 記事タイトルが一字一句そのまま画像の指示に入り、指示文づくりは題名用の system', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { titleMode: 'title', inspectRetries: 0, by: 't' });
    const net = mockOpenAi([{ pass: true, titleExact: true, issues: [] }]);
    expect((await ensureThumbnail(deps, article.id)).status).toBe('created');
    expect(String(net.gen[0].prompt)).toContain(`「${TITLE}」`);
    expect(String(net.gen[0].prompt).startsWith(PLAN_PROMPT)).toBe(true);
    expect(net.plans[0].instructions.startsWith(PLAN_SYSTEM_TITLE)).toBe(true);
    expect(net.visions).toBe(1); // 題名モードは、やり直し0回でも検品する
  });

  it('参考画像があれば edits で描き、固定文が入る。サムネ用ルールは指示文づくりにだけ渡る', async () => {
    const { deps, db, article, images } = await setup();
    await addImageRef(db, images, DEFAULT_TENANT_ID, { name: 'キャラA', bytes: PNG(), by: 't' });
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '水彩風。背景は白い空', inspectRetries: 0, by: 't' });
    const net = mockOpenAi();
    expect((await ensureThumbnail(deps, article.id)).status).toBe('created');
    expect(net.gen).toHaveLength(0);
    expect(net.edit).toHaveLength(1);
    expect(String(net.edit[0].get('prompt'))).toContain(REFERENCE_CLAUSE);
    expect(net.edit[0].getAll('image[]')).toHaveLength(1);
    expect(net.plans[0].input).toContain('水彩風。背景は白い空');
    expect(net.plans[0].input).toContain('キャラA');
    expect(net.plans[0].instructions).toContain('安全ルールは顧客の画像ルールよりも優先');
    expect(net.visions).toBe(0); // やり直し0回・題名なし＝検品しない
  });

  it('文中画像: 専用ルール欄が指示文づくりに渡り、参考画像（共有）があれば edits', async () => {
    const { deps, db, article, images } = await setup();
    await db.updateArticle(article.id, { body_md: '## 見出し1\n本文\n[AI画像1]\n' });
    await saveImageRules(db, DEFAULT_TENANT_ID, 'inline', { body: '挿絵は線画で', by: 't' });
    await addImageRef(db, images, DEFAULT_TENANT_ID, { name: 'キャラA', bytes: JPEG(), by: 't' });
    const net = mockOpenAi([], { plan: { images: [{ slot: 1, prompt: PLAN_PROMPT, altText: '挿絵' }] } });
    await prepareInlinePlan(deps, article.id);
    expect(net.plans[0].input).toContain('【この顧客の画像ルール（最優先）】\n挿絵は線画で');
    expect(net.plans[0].instructions).toContain('安全ルールは顧客の画像ルールよりも優先');
    await ensureInlineImage(deps, article.id, { slot: 1, heading: '見出し1', prompt: PLAN_PROMPT, altText: '挿絵' });
    expect(net.edit).toHaveLength(1);
    expect(String(net.edit[0].get('prompt'))).toContain(REFERENCE_CLAUSE);
    expect(net.visions).toBe(0); // 文中画像は検品しない
  });
});

// ── 5. 検品とやり直し ──────────────────────────────────────
describe('検品とやり直し', () => {
  it('合格なら1枚で採用。検品の記録は結果だけ（指摘の文・画像は入れない）', async () => {
    const { deps, db, article, sqlite } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: 'ルール本文ひみつ', inspectRetries: 1, by: 't' });
    const net = mockOpenAi([{ pass: true, titleExact: null, issues: [] }]);
    expect((await ensureThumbnail(deps, article.id)).status).toBe('created');
    expect(net.gen).toHaveLength(1);
    expect(net.visions).toBe(1);
    const rows = sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = ?`).all(AUDIT_INSPECTED) as Array<{ detail_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({ result: 'pass', issues: 0 });
    expect(rows[0].detail_json).not.toContain('ルール本文ひみつ');
  });

  it('★不合格 → 指摘を足して作り直し → 合格で採用', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    const net = mockOpenAi([{ pass: false, issues: ['靴に実在ブランド風の模様'] }, { pass: true, issues: [] }]);
    expect((await ensureThumbnail(deps, article.id)).status).toBe('created');
    expect(net.gen).toHaveLength(2);
    expect(String(net.gen[0].prompt)).not.toContain('前回の画像の問題点');
    expect(String(net.gen[1].prompt)).toContain('前回の画像の問題点（必ず直す）: 靴に実在ブランド風の模様');
  });

  it('★上限まで不合格なら画像を保存せず rejected（サムネなしで進める）。生成は 1+やり直し回数まで', async () => {
    const { deps, db, article, sqlite, images } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    const net = mockOpenAi([{ pass: false, issues: ['肩に文字風の模様'] }, { pass: false, issues: ['x'] }, { pass: false, issues: ['手が崩れている'] }, { pass: true }]);
    const out = await ensureThumbnail(deps, article.id);
    expect(out).toMatchObject({ status: 'rejected', attempts: 3 });
    expect(out.status === 'rejected' && out.note).toContain('サムネなしで進めます');
    expect(net.gen).toHaveLength(3);
    expect(await db.getEyecatch(article.id)).toBeNull();
    expect(images.m.size).toBe(0);
    expect(countAudit(sqlite, AUDIT_RESERVED, article.id)).toBe(3); // 1枚ごとに予約
    expect(countAudit(sqlite, AUDIT_RUN, article.id)).toBe(1);
    // LINE には「もう一度作る」を出す
    expect(JSON.stringify(buildThumbnailResult(article.id, out))).toContain('action=thumb_regen');
  });

  it('題名モード・やり直し0回: 題名が一致しなければ1枚で打ち切り（rejected）', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { titleMode: 'title', inspectRetries: 0, by: 't' });
    const net = mockOpenAi([{ pass: true, titleExact: false, issues: [] }]);
    const out = await ensureThumbnail(deps, article.id);
    expect(out).toMatchObject({ status: 'rejected', attempts: 1 });
    expect(out.status === 'rejected' && out.note).toContain('題名');
    expect(net.gen).toHaveLength(1);
  });

  it('★検品の通信に失敗したら、未検品として採用する（記録に印を残す）', async () => {
    const { deps, db, article, sqlite } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    const net = mockOpenAi(['error']);
    expect((await ensureThumbnail(deps, article.id)).status).toBe('created');
    expect(net.gen).toHaveLength(1); // 作り直さない
    const d = JSON.parse((sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = ?`).get(AUDIT_INSPECTED) as { detail_json: string }).detail_json);
    expect(d.result).toBe('unchecked');
    const g = JSON.parse((sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'thumbnail.generated'`).get() as { detail_json: string }).detail_json);
    expect(g.inspected).toBe('unchecked');
  });

  it('画像入力が無い提供元は「未検品」（例外を投げない）', async () => {
    const llm: Llm = { structured: async () => { throw new Error('呼ばれない'); } };
    const v = await inspectThumbnail(llm, { bytes: PNG(), contentType: 'image/png' }, { titleMode: 'title', title: 'T', rules: null });
    expect(v).toMatchObject({ verdict: 'unchecked', reason: 'unsupported' });
    const throwing: Llm = { structured: async () => { throw new Error('x'); }, vision: async () => { throw new Error('boom'); } };
    expect((await inspectThumbnail(throwing, { bytes: PNG(), contentType: 'image/png' }, { titleMode: 'none', title: '', rules: null })).verdict).toBe('unchecked');
  });
});

// ── 6. 上限の数え方 ─────────────────────────────────────────
describe('上限の数え方', () => {
  it('★1記事の上限は「実行」の数。自動のやり直しで手動の作り直し枠を食わない（実行3回で止まる）', async () => {
    const { deps, db, article } = await setup();
    // ★本文が空・やり直し既定(1)のままだと行を作らない（＝検品しない）ので、本文を入れる
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: 'ルール', inspectRetries: 1, by: 't' });
    await setThumbDailyLimit(db, 100, 't');
    // 1回目: 不合格→合格（2枚・1実行）／2回目・3回目: 合格（1枚ずつ）
    const net = mockOpenAi([{ pass: false, issues: ['x'] }, { pass: true }, { pass: true }, { pass: true }]);
    for (let i = 0; i < MAX_PER_ARTICLE; i++) {
      expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('created');
    }
    expect(net.gen).toHaveLength(4);
    expect(await countRunsForArticle(db, article.id)).toBe(MAX_PER_ARTICLE);
    expect(await countGenerationsForArticle(db, article.id)).toBe(4); // 合計6枚にはまだ届いていない
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'article_limit' });
    expect(net.gen).toHaveLength(4);
  });

  it('★生成の合計は1記事6枚まで（実行が3回に届いていなくても止める）', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    await setThumbDailyLimit(db, 100, 't');
    const net = mockOpenAi(Array.from({ length: 20 }, () => ({ pass: false, issues: ['x'] })));
    expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('rejected');
    expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('rejected');
    expect(net.gen).toHaveLength(MAX_GENERATIONS_PER_ARTICLE);
    expect(await countRunsForArticle(db, article.id)).toBe(2);
    const out = await ensureThumbnail(deps, article.id, { force: true });
    expect(out).toMatchObject({ status: 'skipped', reason: 'article_limit' });
    expect(out.status === 'skipped' && out.note).toContain('画像6枚');
    expect(net.gen).toHaveLength(MAX_GENERATIONS_PER_ARTICLE);
  });

  it('★実行の途中で合計6枚に届いたら、そこで作り直しを止める（rejected・理由つき）', async () => {
    const { deps, db, article, sqlite } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    await setThumbDailyLimit(db, 100, 't');
    const f = { pass: false, issues: ['x'] };
    const net = mockOpenAi([f, f, f, { pass: true }, f, f, f]);
    await ensureThumbnail(deps, article.id, { force: true }); // 3枚
    await ensureThumbnail(deps, article.id, { force: true }); // 1枚（合格）＝計4
    const out = await ensureThumbnail(deps, article.id, { force: true }); // 2枚で合計6 → 3枚目は作らない
    expect(out).toMatchObject({ status: 'rejected', attempts: 2 });
    expect(out.status === 'rejected' && out.note).toContain(`合計（${MAX_GENERATIONS_PER_ARTICLE}枚）`);
    expect(net.gen).toHaveLength(6);
    expect(countAudit(sqlite, AUDIT_RESERVED, article.id)).toBe(6);
  });

  it('合計の数え方の後方互換: 変更前の記録（生成だけ／予約だけ）も数え漏らさない', async () => {
    const { db, article } = await setup();
    for (let i = 0; i < 3; i++) await db.audit(DEFAULT_TENANT_ID, 'thumbnail.generated', 'system', article.id, 'ok', { size: 's' });
    expect(await countGenerationsForArticle(db, article.id)).toBe(3);
    for (let i = 0; i < 4; i++) await db.audit(DEFAULT_TENANT_ID, 'thumbnail.reserved', 'system', article.id, 'ok');
    expect(await countGenerationsForArticle(db, article.id)).toBe(4);
  });

  it('★経過時間が約150秒を超えたら、次の1枚は作らない（時間がかかりすぎた）', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    const times = [0, 1_000, THUMB_RUN_BUDGET_MS + 1];
    const now = () => times.length > 1 ? times.shift()! : times[0];
    const net = mockOpenAi([{ pass: false, issues: ['x'] }, { pass: true }]);
    const out = await ensureThumbnail({ ...deps, now }, article.id);
    expect(out).toMatchObject({ status: 'rejected', attempts: 1 });
    expect(out.status === 'rejected' && out.note).toContain('時間がかかりすぎた');
    expect(net.gen).toHaveLength(1);
  });

  it('指示文づくりだけで時間を使い切ったら、描かずに終える（課金も実行の記録もしない）', async () => {
    const { deps, article, sqlite } = await setup();
    const times = [0, THUMB_RUN_BUDGET_MS + 1];
    const now = () => times.length > 1 ? times.shift()! : times[0];
    const net = mockOpenAi();
    expect(await ensureThumbnail({ ...deps, now }, article.id)).toMatchObject({ status: 'failed', kind: 'timeout' });
    expect(net.gen).toHaveLength(0);
    expect(countAudit(sqlite, AUDIT_RUN, article.id)).toBe(0);
    expect(countAudit(sqlite, AUDIT_RESERVED, article.id)).toBe(0);
  });

  it('★やり直しの1枚も1日の上限に数え、上限に達したら作り直しを止める', async () => {
    const { deps, db, article } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: 2, by: 't' });
    await setThumbDailyLimit(db, 2, 't');
    const net = mockOpenAi([{ pass: false, issues: ['a'] }, { pass: false, issues: ['b'] }, { pass: true }]);
    const out = await ensureThumbnail(deps, article.id);
    expect(out).toMatchObject({ status: 'rejected', attempts: 2 });
    expect(out.status === 'rejected' && out.note).toContain('上限');
    expect(net.gen).toHaveLength(2);
    expect(await countGeneratedToday(db, DEFAULT_TENANT_ID)).toBe(2);
  });

  it('★後方互換: 変更前の記録（run を持たない予約・生成）も1実行ずつ数える', async () => {
    const { deps, db, article } = await setup();
    await db.audit(DEFAULT_TENANT_ID, 'thumbnail.reserved', 'system', article.id, 'ok');
    await db.audit(DEFAULT_TENANT_ID, 'thumbnail.generated', 'system', article.id, 'ok', { size: '1536x800' });
    await db.audit(DEFAULT_TENANT_ID, 'thumbnail.reserved', 'system', article.id, 'ok');
    expect(await countRunsForArticle(db, article.id)).toBe(2);
    const net = mockOpenAi();
    expect((await ensureThumbnail(deps, article.id, { force: true })).status).toBe('created');
    expect(await countRunsForArticle(db, article.id)).toBe(3);
    expect(await ensureThumbnail(deps, article.id, { force: true })).toMatchObject({ status: 'skipped', reason: 'article_limit' });
    expect(net.gen).toHaveLength(1);
  });
});

// ── 7. ルール・参考画像の保存と検査 ──────────────────────────────
describe('ルール・参考画像の保存と検査', () => {
  it('形式は先頭バイトで判定する（拡張子・申告は信じない）', () => {
    expect(sniffImageMime(PNG())).toBe('image/png');
    expect(sniffImageMime(JPEG())).toBe('image/jpeg');
    expect(sniffImageMime(WEBP())).toBe('image/webp');
    expect(sniffImageMime(GIF())).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    // RIFF だが WebP ではない（WAVE）
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });

  it('★アップロード検査: 空・大きすぎ・形式違い・枚数超えを断る', () => {
    expect(checkRefUpload(new ArrayBuffer(0), 0)).toMatchObject({ ok: false, reason: 'empty' });
    const big = new Uint8Array(REF_MAX_BYTES + 1); big.set(new Uint8Array(PNG()));
    expect(checkRefUpload(big, 0)).toMatchObject({ ok: false, reason: 'too_large' });
    const edge = new Uint8Array(REF_MAX_BYTES); edge.set(new Uint8Array(PNG()));
    expect(checkRefUpload(edge, 0)).toMatchObject({ ok: true, mime: 'image/png' });
    expect(checkRefUpload(GIF(), 0)).toMatchObject({ ok: false, reason: 'bad_type' });
    expect(checkRefUpload(PNG(), REF_MAX_COUNT)).toMatchObject({ ok: false, reason: 'too_many' });
  });

  it('参考画像は3枚まで。期限なしで置き、消すと置き場からも消える。読み込みは最大3枚', async () => {
    const { db, images } = await setup();
    const ids: string[] = [];
    for (const b of [PNG(), JPEG(), WEBP()]) {
      const r = await addImageRef(db, images, DEFAULT_TENANT_ID, { name: '<b>名前</b>', bytes: b, by: 't' });
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.id);
    }
    expect(await addImageRef(db, images, DEFAULT_TENANT_ID, { name: 'x', bytes: PNG(), by: 't' })).toMatchObject({ ok: false, reason: 'too_many' });
    expect([...images.m.values()].every((v) => v.persistent)).toBe(true);
    const refs = await loadReferenceImages(db, images, DEFAULT_TENANT_ID);
    expect(refs.map((r) => r.mime)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(refs[0].name).toBe('b名前/b'); // 山かっこは落とす
    expect(await deleteImageRef(db, images, DEFAULT_TENANT_ID, ids[0], 't')).toBe(true);
    expect(images.m.size).toBe(2);
    expect(await deleteImageRef(db, images, DEFAULT_TENANT_ID, ids[0], 't')).toBe(false);
    expect(normalizeRefName('')).toBe('参考画像');
  });

  it('ルール: 上限超えは保存しない。何も変えていなければ行を作らない。文中画像は題名・検品なし', async () => {
    const { db, sqlite } = await setup();
    expect(await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: 'あ'.repeat(RULE_BODY_MAX + 1), by: 't' }))
      .toEqual({ ok: false, reason: 'too_long' });
    expect(await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '', titleMode: 'none', inspectRetries: '1', by: 't' }))
      .toEqual({ ok: true, saved: false });
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail')).toBeNull();
    expect(await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { titleMode: 'bogus', by: 't' })).toEqual({ ok: false, reason: 'bad_value' });
    expect(await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { inspectRetries: '5', by: 't' })).toEqual({ ok: false, reason: 'bad_value' });

    await saveImageRules(db, DEFAULT_TENANT_ID, 'inline', { body: '線画', titleMode: 'title', inspectRetries: 2, by: 't' });
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'inline')).toMatchObject({ body: '線画', titleMode: 'none', inspectRetries: 0 });

    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '本文A', by: 't' });
    // 空欄は「変えない」、消すのはチェック
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '', titleMode: 'title', by: 't' });
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail')).toMatchObject({ body: '本文A', titleMode: 'title', inspectRetries: 1 });
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { clearBody: true, by: 't' });
    expect((await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail'))!.body).toBe('');
    // 監査に本文を入れない
    const details = (sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'image_rules.saved'`).all() as Array<{ detail_json: string }>)
      .map((r) => r.detail_json).join();
    expect(details).not.toContain('本文A');
    expect(details).not.toContain('線画');
  });

  it('★表が読めないときは「未登録」として扱う（従来の作り方で続ける）', async () => {
    const broken = new Db({ prepare() { throw new Error('no such table: image_rules'); } } as unknown as D1Database);
    expect(await getImageRules(broken, DEFAULT_TENANT_ID, 'thumbnail')).toBeNull();
    expect(await loadReferenceImages(broken, memStore(), DEFAULT_TENANT_ID)).toEqual([]);
  });
});

// ── 8. マイグレーションと /health ─────────────────────────────
describe('マイグレーション 0014 と /health の照合', () => {
  it('★全マイグレーションを流すと、/health が照合する表と列がすべて揃う', () => {
    const sqlite = migrate();
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      const have = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
      for (const c of cols) expect(have.has(c), `${table}.${c} が無い`).toBe(true);
    }
    expect(REQUIRED_COLUMNS.image_rules).toContain('inspect_retries');
    expect(REQUIRED_COLUMNS.image_refs).toContain('r2_key');
  });

  it('表の制約: 種類・題名モード・やり直し回数・本文の長さ', async () => {
    const sqlite = migrate();
    await new Db(asD1(sqlite)).ensureTenant();
    const ins = (kind: string, mode: string, n: number, body = '') => () => sqlite
      .prepare(`INSERT INTO image_rules (tenant_id, kind, body, title_mode, inspect_retries, updated_at) VALUES (?, ?, ?, ?, ?, 'now')`)
      .run(DEFAULT_TENANT_ID, kind, body, mode, n);
    expect(ins('banner', 'none', 0)).toThrow();
    expect(ins('thumbnail', 'big', 0)).toThrow();
    expect(ins('thumbnail', 'none', 3)).toThrow();
    expect(ins('thumbnail', 'none', 0, 'あ'.repeat(RULE_BODY_MAX + 1))).toThrow();
    expect(ins('thumbnail', 'title', 2)).not.toThrow();
  });
});

// ── 9. /setup の画面と認可 ───────────────────────────────────
function fakeKv(initial: Record<string, string> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: async (k: string) => (store[k] as string | undefined) ?? null,
    put: async (k: string, v: unknown) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
    getWithMetadata: async (k: string) => ({ value: store[k] ?? null, metadata: { contentType: 'image/png' } }),
  } as unknown as KVNamespace & { store: Record<string, unknown> };
}

/** セットアップ済み（＝書き込みにコードが要る）環境 */
async function runningEnv() {
  const sqlite = migrate();
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  const kv = fakeKv({ [SETUP_DONE_KV]: new Date().toISOString() });
  return { sqlite, db, kv, env: { DB: asD1(sqlite), KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy', OPENAI_API_KEY: 'sk-openai-test' } };
}

const postForm = (env: unknown, path: string, body: Record<string, string>) =>
  setupRouter.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
  }, env);

function uploadForm(fields: Record<string, string>, file?: { bytes: ArrayBuffer; type: string; name: string }): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append('file', new File([file.bytes], file.name, { type: file.type }));
  return f;
}

describe('/setup の「画像のルール」', () => {
  it('★登録した本文・参考画像そのものは画面に出さない（文字数・名前・サイズだけ）', async () => {
    const { db, env, kv } = await runningEnv();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '社外秘の画像ルール本文', titleMode: 'title', by: 't' });
    await addImageRef(db, new (await import('../../src/ports/storage/images')).KvImageStore(kv), DEFAULT_TENANT_ID, { name: 'キャラA', bytes: PNG(), by: 't' });
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('画像のルール');
    expect(html).toContain(`登録済み（${'社外秘の画像ルール本文'.length}字）`);
    expect(html).not.toContain('社外秘の画像ルール本文');
    expect(html).toContain('キャラA');
    expect(html).not.toContain(PNG_B64);
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('sk-openai-test');
    // コード欄には入手方法が必ず付く
    expect(html).toContain('「セットアップ」</b> と送ると届きます');
  });

  it('★コード無し・不正なコードは 403 で、何も保存しない', async () => {
    const { db, env } = await runningEnv();
    expect((await postForm(env, '/setup/image-rules', { thumb_body: '悪意あるルール', thumb_title_mode: 'title', thumb_inspect: '2' })).status).toBe(403);
    expect((await postForm(env, '/setup/image-rules', { code: 'ZZZZ-9999', thumb_body: '悪意あるルール' })).status).toBe(403);
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail')).toBeNull();
  });

  it('正しいコードで保存できる（コードは1回きり）', async () => {
    const { db, env, kv } = await runningEnv();
    const { display } = await issueSetupCode(kv);
    const res = await postForm(env, '/setup/image-rules', {
      code: display, thumb_body: 'ルールです', thumb_title_mode: 'title', thumb_inspect: '2', inline_body: '挿絵ルール',
    });
    expect(res.status).toBe(200);
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail')).toMatchObject({ body: 'ルールです', titleMode: 'title', inspectRetries: 2 });
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'inline')).toMatchObject({ body: '挿絵ルール' });
    expect((await postForm(env, '/setup/image-rules', { code: display, thumb_body: '上書き' })).status).toBe(403);
  });

  it('★参考画像の追加: コード無しは 403 で何も置かない。正しいコードで追加・削除もコード必須', async () => {
    const { db, env, kv } = await runningEnv();
    const file = { bytes: PNG(), type: 'image/png', name: 'a.png' };
    const denied = await setupRouter.request('/setup/image-refs', { method: 'POST', body: uploadForm({ name: 'A' }, file) }, env);
    expect(denied.status).toBe(403);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(0);
    expect(Object.keys(kv.store).some((k) => k.startsWith('img:'))).toBe(false);

    const { display } = await issueSetupCode(kv);
    const ok = await setupRouter.request('/setup/image-refs', { method: 'POST', body: uploadForm({ name: 'A', code: display }, file) }, env);
    expect(ok.status).toBe(200);
    const [ref] = await db.listImageRefs(DEFAULT_TENANT_ID);
    expect(ref).toMatchObject({ name: 'A', mime: 'image/png' });

    expect((await postForm(env, '/setup/image-refs/delete', { id: ref.id })).status).toBe(403);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(1);
    const { display: d2 } = await issueSetupCode(kv);
    expect((await postForm(env, '/setup/image-refs/delete', { id: ref.id, code: d2 })).status).toBe(200);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(0);
  });

  it('★拡張子を偽った画像は、コードを使う前に断る（コードは残る）', async () => {
    const { db, env, kv } = await runningEnv();
    const { display } = await issueSetupCode(kv);
    const res = await setupRouter.request('/setup/image-refs', {
      method: 'POST', body: uploadForm({ name: 'A', code: display }, { bytes: GIF(), type: 'image/png', name: 'fake.png' }),
    }, env);
    expect(res.status).toBe(400);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(0);
    // コードはまだ使える
    const ok = await setupRouter.request('/setup/image-refs', {
      method: 'POST', body: uploadForm({ name: 'A', code: display }, { bytes: PNG(), type: 'image/png', name: 'a.png' }),
    }, env);
    expect(ok.status).toBe(200);
  });
});

// ── 10. LINE の文面 ─────────────────────────────────────────
describe('LINE「AI設定」→「画像のルール」', () => {
  it('要約だけを出し、本文は出さない。「設定画面を開く」は『セットアップ』を送る', async () => {
    const { db } = await setup();
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '社外秘ルール', titleMode: 'title', inspectRetries: 2, by: 't' });
    const msg = buildImageRulesSummary(await loadImageRulesSummary(db, DEFAULT_TENANT_ID), true);
    const s = JSON.stringify(msg);
    expect(s).not.toContain('社外秘ルール');
    expect(s).toContain('登録済み（6字）');
    expect(s).toContain('2回まで');
    expect(s).toContain('0 / 3 枚');
    expect((msg.quickReply as { items: Array<{ action: { type: string; text: string } }> }).items[0].action)
      .toMatchObject({ type: 'message', text: 'セットアップ' });
  });

  it('AI設定の画面（キーあり）に「画像のルール」ボタンがある', () => {
    const r = { mode: 'none' as const, domains: 'any' as const, dailyLimit: 5 };
    expect(JSON.stringify(buildAiSettings(r, true, undefined))).toContain('action=ai_imgrules');
    const items = (buildAiSettings(r, true, { count: 1, dailyLimit: 10 }).quickReply as { items: unknown[] }).items;
    expect(items.length).toBeLessThanOrEqual(13);
  });
});

// ── 11. OpenAI の画像入力（vision）─────────────────────────────
describe('OpenAI の vision', () => {
  it('★input_image で送り、store:false。画像を受け付けないモデルは次の候補へ（light → heavy）', async () => {
    const { OpenAiLlm } = await import('../../src/ports/llm/openai');
    const { z } = await import('zod');
    const seen: Array<{ model: string; body: any }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const body = JSON.parse(String(init!.body));
      seen.push({ model: body.model, body });
      if (body.model === 'light-1') {
        return new Response(JSON.stringify({ error: { message: 'Invalid content: image input is not supported for this model' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"pass":true,"issues":[]}' }] }] }), { status: 200 });
    });
    const llm = new OpenAiLlm('sk-x', { light: ['light-1'], heavy: ['heavy-1'] });
    const r = await llm.vision({
      tier: 'light', label: 't', system: 's', user: '確認して', schema: z.object({ pass: z.boolean(), issues: z.array(z.string()) }),
      images: [{ bytes: PNG(), mime: 'image/png' }],
    });
    expect(r.data.pass).toBe(true);
    expect(seen.map((x) => x.model)).toEqual(['light-1', 'heavy-1']);
    const b = seen[1].body;
    expect(b.store).toBe(false);
    expect(b.input[0].content[0]).toMatchObject({ type: 'input_text' });
    expect(b.input[0].content[0].text).toMatch(/json/i);
    expect(b.input[0].content[1].type).toBe('input_image');
    expect(b.input[0].content[1].image_url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('出力の形が不正なら、再試行せずに投げる（呼び出し側は未検品で採用）', async () => {
    const { OpenAiLlm } = await import('../../src/ports/llm/openai');
    const { z } = await import('zod');
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }), { status: 200 });
    });
    const e = await new OpenAiLlm('sk-x').vision({
      tier: 'light', label: 't', system: 's', user: 'u', schema: z.object({ pass: z.boolean() }), images: [{ bytes: PNG(), mime: 'image/png' }],
    }).catch((x) => x);
    expect(e.kind).toBe('bad_output');
    expect(calls).toBe(1);
  });
});


// ── 12. 源蔵レビュー（2026-10-26・条件付き通過）の必須・前倒し ─────────────
describe('必須1: サムネが固まっても記事は止めない', () => {
  it('画像の通信は約120秒で打ち切り、時間切れは再試行しない（課金済みかもしれないため）', async () => {
    expect(IMAGE_TIMEOUT_MS).toBe(120_000);
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      calls++;
      const signal = (init as RequestInit).signal as AbortSignal;
      return new Promise<Response>((_r, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
    });
    const e = await new OpenAiImageClient('sk-x', IMAGE_MODEL, 20).generate('p').catch((x) => x);
    expect(e.kind).toBe('timeout');
    expect(e.userMessage).toContain('時間がかかりすぎた');
    expect(calls).toBe(1);
  });

  it('runThumbnailStep: step が落ちても例外を外へ出さず「失敗」として返す。成功はそのまま', async () => {
    expect(await runThumbnailStep(async () => { throw new Error('step timed out after 5 minutes'); }))
      .toEqual({ status: 'failed', kind: 'step', note: THUMB_STEP_STOPPED_NOTE });
    expect(await runThumbnailStep(async () => ({ status: 'created' as const, altText: 'a' }))).toEqual({ status: 'created', altText: 'a' });
  });

  it('★Workflow を実際に動かす: 「サムネイルを作る」が落ちても、プレビューは届き、確認待ちになる', async () => {
    const sqlite = migrate();
    const d1 = asD1(sqlite);
    const db = new Db(d1);
    await db.ensureTenant();
    const article = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ');
    await db.updateArticle(article.id, { title: 'T', body_md: '## 見出し\n本文' });
    await db.setState(article.id, 'received', 'generating', 'system');
    await db.setState(article.id, 'generating', 'preview_ready', 'system');

    const pushed: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.line.me')) pushed.push(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    const { GenerateArticleWorkflow } = await import('../../src/workflows/generate-article');
    const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
    const env = { DB: d1, KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner', OPENAI_API_KEY: 'sk-openai-test' };
    const wf = new (GenerateArticleWorkflow as unknown as new (c: unknown, e: unknown) => {
      run: (ev: unknown, step: unknown) => Promise<void>;
    })({}, env);
    const done: string[] = [];
    const step = {
      sleep: async () => {},
      do: async (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
        if (name === '記事を調べる') { done.push(name); return null; }
        // 記事は書けた（生成の中身は偽物）
        if (name === '記事を生成する') {
          done.push(name);
          return { ok: true, title: 'T', markdown: '## 見出し\n本文', metaDescription: '', hashtags: [], charCount: 10, hasEyecatch: false, research: null };
        }
        // サムネは step ごと時間切れで落ちる
        if (name === 'サムネイルを作る') throw new Error('WorkflowTimeoutError: step timed out');
        done.push(name);
        return fn();
      },
    };
    await wf.run({ payload: { articleId: article.id, lineUserId: 'u1', debounceSec: 0 } }, step);
    expect(done).toContain('プレビューを送る');
    expect(done).not.toContain('失敗を通知する');
    expect((await db.getArticle(article.id))!.state).toBe('awaiting_approval');
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    expect(pushed.join()).toContain('サムネの作成が途中で止まりました');
  });
});

describe('必須2: セットアップ前（コード無しで通る状態）は、画像のルールの書き込みを断る', () => {
  async function firstRunEnv() {
    const sqlite = migrate();
    const db = new Db(asD1(sqlite));
    await db.ensureTenant();
    const kv = fakeKv(); // 完了の印なし・note 未連携＝初回
    return { db, kv, env: { DB: asD1(sqlite), KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy', OPENAI_API_KEY: 'sk-openai-test' } };
  }

  it('★3つの経路とも 403 で「先にセットアップを」。何も保存しない', async () => {
    const { db, kv, env } = await firstRunEnv();
    const r1 = await postForm(env, '/setup/image-rules', { thumb_body: 'ルール', thumb_title_mode: 'title' });
    expect(r1.status).toBe(403);
    expect(await r1.text()).toContain('先にセットアップを済ませてください');
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'thumbnail')).toBeNull();

    const r2 = await setupRouter.request('/setup/image-refs', {
      method: 'POST', body: uploadForm({ name: 'A' }, { bytes: PNG(), type: 'image/png', name: 'a.png' }),
    }, env);
    expect(r2.status).toBe(403);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(0);
    expect(Object.keys(kv.store).some((k) => k.startsWith('img:'))).toBe(false);

    // 削除も断る（行を直接入れておいて、消えないこと）
    await addImageRef(db, memStore(), DEFAULT_TENANT_ID, { name: 'B', bytes: PNG(), by: 't' });
    const [ref] = await db.listImageRefs(DEFAULT_TENANT_ID);
    const r3 = await postForm(env, '/setup/image-refs/delete', { id: ref.id });
    expect(r3.status).toBe(403);
    expect(await db.listImageRefs(DEFAULT_TENANT_ID)).toHaveLength(1);
  });

  it('画面にもフォームを出さず、案内だけ出す', async () => {
    const { env } = await firstRunEnv();
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain(NEED_SETUP_FIRST);
    expect(html).not.toContain('action="/setup/image-rules"');
    expect(html).not.toContain('action="/setup/image-refs"');
  });

  it('セットアップ済み＋正しいコードなら通る（3経路とも）', async () => {
    const { db, env, kv } = await runningEnv();
    expect((await postForm(env, '/setup/image-rules', { code: (await issueSetupCode(kv)).display, thumb_body: 'ルール' })).status).toBe(200);
    expect((await setupRouter.request('/setup/image-refs', {
      method: 'POST', body: uploadForm({ name: 'A', code: (await issueSetupCode(kv)).display }, { bytes: PNG(), type: 'image/png', name: 'a.png' }),
    }, env)).status).toBe(200);
    const [ref] = await db.listImageRefs(DEFAULT_TENANT_ID);
    expect((await postForm(env, '/setup/image-refs/delete', { id: ref.id, code: (await issueSetupCode(kv)).display })).status).toBe(200);
  });
});

describe('前倒し4〜7', () => {
  it('4: 6000字を超えるルールは、コードを使う前に断る（コードは残る）', async () => {
    const { db, env, kv } = await runningEnv();
    const { display } = await issueSetupCode(kv);
    const res = await postForm(env, '/setup/image-rules', { code: display, inline_body: 'あ'.repeat(RULE_BODY_MAX + 1) });
    expect(res.status).toBe(400);
    expect(await getImageRules(db, DEFAULT_TENANT_ID, 'inline')).toBeNull();
    expect((await postForm(env, '/setup/image-rules', { code: display, inline_body: '短い' })).status).toBe(200);
  });

  it('★5: 投稿者（staff）が「画像のルール」を押すと持ち主専用の案内。持ち主には要約', async () => {
    const SECRET = 'line-secret-test';
    const sqlite = migrate();
    const d1 = asD1(sqlite);
    const db = new Db(d1);
    await db.ensureTenant();
    await db.addStaff(DEFAULT_TENANT_ID, 'staff1', 'スタッフ', 'owner', 5);
    await saveImageRules(db, DEFAULT_TENANT_ID, 'thumbnail', { body: '社外秘ルール', by: 't' });
    const replies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/reply')) replies.push(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    const kvm = new Map<string, string>();
    const kv = { get: async (k: string) => kvm.get(k) ?? null, put: async (k: string, v: string) => { kvm.set(k, v); },
      delete: async (k: string) => { kvm.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
    const env = { DB: d1, KV: kv, LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner', OPENAI_API_KEY: 'sk-openai-test' };
    const { handleLineWebhook } = await import('../../src/adapters/line/webhook');
    const send = async (userId: string) => {
      const body = JSON.stringify({ events: [{ type: 'postback', replyToken: 'rt', source: { userId }, postback: { data: 'action=ai_imgrules' } }] });
      const pending: Array<Promise<unknown>> = [];
      const res = await handleLineWebhook(new Request('https://x/webhook', {
        method: 'POST', body, headers: { 'x-line-signature': await signLineBody(body, SECRET) },
      }), env as never, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as never);
      expect(res.status).toBe(200);
      await Promise.all(pending);
    };
    await send('staff1');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(OWNER_ONLY_MESSAGE);
    expect(replies[0]).not.toContain('社外秘ルール');
    await send('owner');
    expect(replies[1]).toContain('画像のルール');
    expect(replies[1]).toContain('登録済み（6字）');
    expect(replies[1]).not.toContain('社外秘ルール');
  });

  it('6: 「作り直さない」の説明が実態どおり（タイトルなしなら確認しない・ありなら1回確認）', async () => {
    const { env } = await runningEnv();
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('タイトルを入れないときは AI の確認そのものを行いません');
    expect(html).toContain('タイトルを入れるときは1回だけ確認');
    expect(html).toContain(`最大${MAX_GENERATIONS_PER_ARTICLE}枚（約35〜40円）`);
    expect(html).toContain('1回の作成で最大 約17〜20円');
  });

  it('★7: 文中画像は、参考画像を1回の実行で1度だけ置き場から読む', async () => {
    const { deps, db, article, images } = await setup();
    await db.updateArticle(article.id, { body_md: '## A\n本文\n[AI画像1]\n## B\n本文\n[AI画像2]\n## C\n本文\n[AI画像3]\n' });
    await addImageRef(db, images, DEFAULT_TENANT_ID, { name: 'キャラ', bytes: PNG(), by: 't' });
    const { runInlineImageSteps } = await import('../../src/core/image/inline');
    const net = mockOpenAi([], { plan: { images: [1, 2, 3].map((slot) => ({ slot, prompt: PLAN_PROMPT, altText: 'a' })) } });
    let gets = 0;
    const counting = { ...images, get: async (k: string) => { gets++; return images.get(k); } };
    await runInlineImageSteps(async (_n, _c, fn) => fn(), { ...deps, images: counting }, article.id);
    expect(net.edit).toHaveLength(3);
    expect(gets).toBe(1);
  });

  it('LINE のサムネの文面は「作成3回・画像6枚まで」', () => {
    const s = JSON.stringify(buildThumbnailResult('a1', { status: 'created', altText: 'x' }));
    expect(s).toContain(`作成${MAX_PER_ARTICLE}回・画像${MAX_GENERATIONS_PER_ARTICLE}枚まで`);
    expect(s).not.toContain('合計3回');
  });
});
