/**
 * 文中画像の自動生成（P3・設計書 18章）。
 *
 * 流れ: 本文の `[AI画像N]`（生成時に純関数で振り分け済み）→ 見出しと前後の文から、全枚数ぶんの指示文を1回で作る
 *       → 1枚ずつ OpenAI(gpt-image-2) で描く（Workflow の独立 step・retries 0）→ KV に置き、images に登録
 *
 * ★守っていること（サムネ core/image/thumbnail.ts と同じ作り）
 *  - 既定は0枚（作らない）。費用は顧客が決める
 *  - 失敗しても記事は止めない。例外は投げず、結果（理由つき）を返す。作れなかった番号は公開時に本文から消える
 *  - 費用の歯止め: ★課金の直前に「予約」として数える（監査ログ `inline_image.reserved`。サムネとは別に数える）。
 *    1記事の予約は最大10回・1日の予約は既定10回（選択肢 5/10/20/50）。失敗しても数えたまま
 *  - 残高不足・キー不正・組織認証が出たら、残りの枚数は呼ばない（同じ理由で全部失敗し、費用と案内が重なるだけ）
 *  - 画像に文字を入れさせない／実在の人物・ロゴ・商標・作家の画風を描かせない／実物の写真に見える絵にしない
 *  - OpenAI のキーが無い環境では何もしない（設定も有効にならない）
 *  - 修正で本文が作り直されたら、前回の画像を使い回す（見出しが同じものはその画像、残りは順番どおり）。
 *    足りない分だけ新しく作る。作り直しは専用ボタンを押したときだけ（二重課金を避ける）
 *  - ★2026-10-26 画像のルール: 文中画像用のルール欄（kind='inline'）があれば指示文づくりに渡す。
 *    参考画像（サムネと共有）があれば images/edits で描く。検品・題名モードは入れない（段階1）。
 *    何も登録しなければ今までと同じ（指示文・呼び出しとも）。枚数の上限・予約・ロックは変えない
 */
import { z } from 'zod';
import type { Db, ArticleRow, ImageRow } from '../../ports/storage/db';
import type { ImageStore } from '../../ports/storage/images';
import { LlmError, type Llm } from '../../ports/llm/types';
import { createLlm, type LlmConfig } from '../../ports/llm';
import { ImageGenError, OpenAiImageClient, THUMBNAIL_SIZE, type ImageErrorKind } from '../../ports/image/openai';
import type { ImageGenerator } from '../../ports/image/types';
import { getImageRules, listImageRefs, loadReferenceImages, REFERENCE_CLAUSE, REF_MAX_COUNT, type LoadedRef, getRefRandom, selectRefs, refNamesClause } from './rules';
import { RULES_PRIORITY_SYSTEM, REFS_SYSTEM } from './thumbnail';
import { parse, parseHeadings } from '../article/placeholders';
import { jstDate } from '../../lib/time';
import { newId } from '../../lib/id';
import { log } from '../../lib/mask';

// ── 設定（顧客ごと＝環境ごとに system_flags へ保存）────────────
export const FLAG_COUNT = 'inline_image_count';
export const FLAG_DAILY_LIMIT = 'inline_image_daily_limit';

/** 1記事あたりの文中画像の枚数の選択肢。既定0（作らない） */
export const COUNT_OPTIONS = [0, 1, 2, 3, 4, 5] as const;
export const DEFAULT_COUNT = 0;
/** 1日の予約回数の上限の選択肢（サムネとは別枠） */
export const DAILY_LIMIT_OPTIONS = [5, 10, 20, 50] as const;
export const DEFAULT_DAILY_LIMIT = 10;
/** 1記事あたりの予約回数の上限（初回＋修正で足りなくなった分＋作り直しボタン）。請求の暴走を防ぐ */
export const MAX_INLINE_PER_ARTICLE = 10;
/** 画像のサイズ（サムネと同じ・実機で受理済み・約4〜5円）。断られたら標準サイズで1回だけ（クライアント側） */
export const INLINE_IMAGE_SIZE = THUMBNAIL_SIZE;
/** 目安の費用（選ぶ画面に出す） */
export const COST_NOTE = '1枚 約5円（OpenAI の料金・お客さまのご負担）';

export interface InlineSettings { count: number; dailyLimit: number }

/** 画像を作れるキーがあるか（形の違うキーは「無い」として扱う。OpenAiImageClient も sk- 以外を断る） */
export function hasImageKey(key: string | null | undefined): boolean {
  return Boolean(key?.startsWith('sk-'));
}

export function parseCount(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return (COUNT_OPTIONS as readonly number[]).includes(n) ? n : null;
}

export function parseInlineDailyLimit(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return (DAILY_LIMIT_OPTIONS as readonly number[]).includes(n) ? n : null;
}

/** ★保存済みの値が壊れていたら、作らない側（0枚・既定の上限）で読む */
export async function getInlineSettings(db: Db): Promise<InlineSettings> {
  return {
    count: parseCount(await db.getNumberFlag(FLAG_COUNT, DEFAULT_COUNT)) ?? DEFAULT_COUNT,
    dailyLimit: parseInlineDailyLimit(await db.getNumberFlag(FLAG_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)) ?? DEFAULT_DAILY_LIMIT,
  };
}

/** 生成のときに実際に使う枚数（キーが無ければ設定に関わらず0） */
export async function effectiveInlineCount(db: Db, openaiKey: string | null | undefined): Promise<number> {
  if (!hasImageKey(openaiKey)) return 0;
  return (await getInlineSettings(db)).count;
}

export type InlineSettingAction = 'ai_img_set' | 'ai_ilimit_set';
export type InlineApplyResult = 'saved' | 'denied' | 'no_key' | 'ignored';

/**
 * 設定を1つ保存する（判定をここに集める。applyResearchSetting と同じ作り）。
 *   denied  = 持ち主ではない（費用に直結する設定なので持ち主だけ）
 *   no_key  = OpenAI のキーが無い環境（使えない機能を有効にしない）
 *   ignored = 読めない値・知らない操作（何も変えない。危ない側＝多い枚数に丸めない）
 */
export async function applyInlineSetting(db: Db, req: {
  isOwner: boolean; hasKey: boolean; action: string; value: string | null; by: string;
}): Promise<InlineApplyResult> {
  if (!req.isOwner) return 'denied';
  if (!req.hasKey) return 'no_key';
  if (req.action === 'ai_img_set') {
    const v = parseCount(req.value);
    if (v === null) return 'ignored';
    await db.setNumberFlag(FLAG_COUNT, v, '文中画像の枚数', req.by);
    return 'saved';
  }
  if (req.action === 'ai_ilimit_set') {
    const v = parseInlineDailyLimit(req.value);
    if (v === null) return 'ignored';
    await db.setNumberFlag(FLAG_DAILY_LIMIT, v, '文中画像の1日の上限', req.by);
    return 'saved';
  }
  return 'ignored';
}

/** 受付の返事に足す目安（1枚 約20〜60秒・推測。順番に作るので枚数ぶん遅れる） */
export function inlineWaitNote(count: number): string {
  if (count <= 0) return '';
  // 1枚 最大1分として枚数ぶん（5枚で最大5分ほど）。短く約束しない
  return `文中の画像を${count}枚作るため、さらに最大${count}分ほどかかります。`;
}

// ── 本文の中の AI 画像の位置 ─────────────────────────────────
export interface GeneratedSlot {
  slot: number;
  /** 直前の見出し（無ければ null） */
  heading: string | null;
  /** その見出しの本文の先頭（指示文づくりに使う） */
  excerpt: string;
}

const EXCERPT_CHARS = 300;

/** 本文の `[AI画像N]` を、直前の見出しと前後の文つきで列挙する（同じ番号が2つあれば最初の1つ） */
export function listGeneratedSlots(md: string): GeneratedSlot[] {
  const lines = md.split('\n');
  const headings = parseHeadings(md);
  const seen = new Set<number>();
  const out: GeneratedSlot[] = [];
  for (const p of parse(md, 'generated')) {
    if (seen.has(p.index)) continue;
    seen.add(p.index);
    const start = p.headingIndex >= 0 ? headings[p.headingIndex].line + 1 : 0;
    const next = headings.find((h) => h.line > p.line);
    const end = next ? next.line : lines.length;
    const excerpt = lines.slice(start, end).join('\n')
      .replace(/\[(?:AI)?画像\d+\]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
    out.push({ slot: p.index, heading: p.heading, excerpt });
  }
  return out;
}

// ── 修正で本文が作り直されたときの使い回し（純関数）────────────
export interface ReusePlan {
  /** 新しい番号 → 使い回す画像の id */
  assign: Array<{ slot: number; imageId: string }>;
  /** 使わない画像（消す） */
  leftover: string[];
  /** 新しく作る番号 */
  missing: number[];
}

/**
 * ★設計書 18-7: 見出しが完全に同じものはその画像、残りは前回の順番どおりに当てはめる。
 *   新しい本文の枚数のほうが多いときだけ、足りない分を新しく作る。余りは使わない。
 */
export function planGeneratedReuse(
  old: Array<{ id: string; slot: number; heading: string | null }>,
  next: Array<{ slot: number; heading: string | null }>,
): ReusePlan {
  const pool = [...old].sort((a, b) => a.slot - b.slot);
  const used = new Set<string>();
  const assigned = new Map<number, string>();
  // 1. 見出しが完全に同じもの
  for (const n of next) {
    if (n.heading === null) continue;
    const hit = pool.find((o) => !used.has(o.id) && o.heading === n.heading);
    if (hit) { used.add(hit.id); assigned.set(n.slot, hit.id); }
  }
  // 2. 残りは順番どおり
  for (const n of next) {
    if (assigned.has(n.slot)) continue;
    const hit = pool.find((o) => !used.has(o.id));
    if (hit) { used.add(hit.id); assigned.set(n.slot, hit.id); }
  }
  return {
    assign: next.filter((n) => assigned.has(n.slot)).map((n) => ({ slot: n.slot, imageId: assigned.get(n.slot)! })),
    leftover: pool.filter((o) => !used.has(o.id)).map((o) => o.id),
    missing: next.filter((n) => !assigned.has(n.slot)).map((n) => n.slot),
  };
}

/**
 * 新しい本文に、前回作った AI 画像を当てはめる（費用0）。余った画像は KV と行を消す。
 * 0枚設定・キー無しで本文に `[AI画像N]` が無ければ、前回の画像はすべて消える（0枚＝入れない）。
 */
export async function reuseGeneratedImages(
  db: Db, images: ImageStore, articleId: string, md: string,
): Promise<ReusePlan> {
  // ★先に同じ番号の重複を畳む。残したままだと、重複した絵が順番どおりの当てはめで別の見出しに入る
  await foldGeneratedDuplicates(db, images, articleId);
  const old = await db.listGeneratedImages(articleId);
  const next = listGeneratedSlots(md);
  const plan = planGeneratedReuse(
    old.map((o) => ({ id: o.id, slot: o.gen_slot ?? 0, heading: o.gen_heading ?? null })),
    next,
  );
  for (const a of plan.assign) {
    await db.raw.prepare('UPDATE images SET gen_slot = ?, note_image_url = NULL WHERE id = ?').bind(a.slot, a.imageId).run();
  }
  for (const id of plan.leftover) {
    const row = old.find((o) => o.id === id);
    await db.raw.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
    if (row) await images.delete(row.r2_key).catch(() => {});
  }
  return plan;
}

// ── 行の後始末（同じ番号は1つだけ・消した番号は残さない）──────────────
/**
 * ★不変条件: 同じ記事・同じ gen_slot の行は1つだけ（2026-10-24 源蔵レビュー P3 必須1）。
 *   2本同時に作った・前の画像を消し損ねた、などで重複したら、いちばん後に保存した行（SQLite の rowid が最大）を残し、
 *   残りは行と置き場（KV）を消す。★作成時刻は同じミリ秒になりうるので使わない。rowid は保存した順に必ず増えるので、
 *   同時に畳んでも、どちらも同じ行を残す（結果が食い違って0枚になることがない）
 */
export async function foldGeneratedDuplicates(db: Db, images: ImageStore, articleId: string): Promise<number> {
  const rows = (await db.raw
    .prepare(`SELECT id, r2_key, gen_slot, rowid AS rn FROM images
              WHERE article_id = ? AND source = 'generated' AND is_eyecatch = 0 AND gen_slot IS NOT NULL`)
    .bind(articleId)
    .all<{ id: string; r2_key: string; gen_slot: number; rn: number }>()).results ?? [];
  const keep = new Map<number, number>();
  for (const r of rows) keep.set(r.gen_slot, Math.max(keep.get(r.gen_slot) ?? -Infinity, r.rn));
  let removed = 0;
  for (const r of rows) {
    if (keep.get(r.gen_slot) === r.rn) continue;
    await db.raw.prepare('DELETE FROM images WHERE id = ?').bind(r.id).run();
    await images.delete(r.r2_key).catch(() => {});
    removed++;
  }
  return removed;
}

/**
 * 「AI画像Nを消して」のとき、その番号の画像の行と置き場（KV）も消す。
 * ★残すと、次の書き直しで使い回され、消したはずの絵が黙って戻ってくる（設計書 18-7「消した画像は使い回さない」）。
 *   ほかの番号は詰め直さない（番号の欠けは今までどおり）
 */
export async function deleteGeneratedSlot(db: Db, images: ImageStore, articleId: string, slot: number): Promise<number> {
  const rows = (await db.listGeneratedImages(articleId)).filter((r) => r.gen_slot === slot);
  for (const r of rows) {
    await db.raw.prepare('DELETE FROM images WHERE id = ?').bind(r.id).run();
    await images.delete(r.r2_key).catch(() => {});
  }
  return rows.length;
}

/**
 * 画像を位置だけ動かした（移動・入れ替え）あと、その番号の「作ったときの見出し」を今の見出しに合わせる。
 * ★合わせないと、動かしただけで「前回のものを使っています」と誤って出し、次の書き直しで元の見出しの位置に戻される
 */
export async function syncGeneratedHeadings(db: Db, articleId: string, md: string, slots: readonly number[]): Promise<void> {
  const current = listGeneratedSlots(md);
  for (const slot of new Set(slots)) {
    const s = current.find((x) => x.slot === slot);
    if (!s) continue;
    await db.raw.prepare(
      `UPDATE images SET gen_heading = ? WHERE article_id = ? AND source = 'generated' AND is_eyecatch = 0 AND gen_slot = ?`)
      .bind(s.heading, articleId, slot).run();
  }
}

// ── 指示文づくり（1記事で1回の文章呼び出し）──────────────────
const InlinePlan = z.object({
  images: z.array(z.object({
    slot: z.number().int(),
    prompt: z.string().min(20).max(1500),
    altText: z.string().min(1).max(80),
  })).max(10),
});
export type InlinePlan = z.infer<typeof InlinePlan>;

export const INLINE_PLAN_SYSTEM = `あなたは note 記事の挿絵（文中の画像）の指示文を作る編集者です。
記事の見出しごとに、その見出しの内容に合う横長の挿絵を描くための英語の指示文(prompt)と、日本語の代替テキスト(altText)を作ります。

【指示文のルール】
- 英語で書く。構図・主題・色・雰囲気を具体的に（80〜150語）
- 横長(約2:1)。大事なものは中央に置く
- 画像の中に文字を入れない。図解が必要でも文字なしにする（どうしても必要なら短い英単語を最大2語まで）
- 日本語の文字は絶対に入れない（崩れるため）
- 実在の人物・有名人・ロゴ・商標・ブランド名・既存の作品のキャラクターを描かない。人を描くなら架空の人物（参考画像が渡された場合は、その参考画像の扱いに従う）
- 特定の作家・作品・スタジオの画風を指定しない（ナレッジに書かれていても使わない）
- 商品・料理・店舗・施設などの「実物の写真」に見える絵にしない。イラスト調で、イメージだと分かる表現にする（実物と誤認させない）
- 効果・効能の before/after、数字・グラフで事実を示唆する絵にしない
- 記事に書かれていない事実（効果・数字・施設）を示唆する絵にしない
- 記事に出てこない商品・料理・サービス・設備を描かない。記事の本文・ナレッジに書かれたものだけを描く
- ナレッジの「書かないこと」「避けること」に当たるものは描かない
- 既定は、明るく親しみやすいフラットなイラスト調。ナレッジに画風の指定があればそちらを優先する（ただし上の禁止が優先）
- 同じ記事の中の画像は、画風・色味をそろえる

【altText】
画像の内容を日本語で40字以内。「〜の画像」で終えない。キーワードを詰め込まない。

【出力】
渡された番号(slot)すべてについて1つずつ。
JSON: {"images": [{"slot": 1, "prompt": "...", "altText": "..."}]}`;

export interface InlinePlanInput {
  title: string;
  slots: GeneratedSlot[];
  /** ナレッジ（立場・避けること・画風の指定）。無ければ null */
  knowledge: string | null;
  /** この顧客の画像ルール（文中画像用）。無ければ省く */
  rules?: string | null;
  /** 参考画像の名前（何の画像か。顧客が登録した文字列）。無ければ省く */
  refNames?: string[];
  /** ランダム選択のとき、画像（slot）ごとに参考にする画像の名前 */
  castBySlot?: Record<number, string[]>;
}

export function buildInlinePlanUser(i: InlinePlanInput): string {
  return [
    `【記事タイトル】${i.title}`,
    `【挿絵を入れる場所（${i.slots.length}枚）】\n` + i.slots.map((s) =>
      `- slot ${s.slot}: 見出し「${s.heading ?? '（リード文）'}」\n  その見出しの本文: ${s.excerpt || '（なし）'}`).join('\n'),
    i.knowledge ? `【ナレッジ（この人の立場・避けること・画風の指定）】\n${i.knowledge.slice(0, 3000)}` : '',
    i.rules ? `【この顧客の画像ルール（最優先）】\n${i.rules}` : '',
    i.refNames?.length ? `【参考画像（名前）】${i.refNames.join('、')}` : '',
    i.castBySlot && Object.keys(i.castBySlot).length
      ? `【画像ごとに参考にする画像（その画像では、これだけを参考にする）】\n${Object.entries(i.castBySlot)
        .map(([slot, names]) => `- slot ${slot}: ${names.join('、')}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

/** ルール・参考画像があるときだけ足す（無ければ INLINE_PLAN_SYSTEM そのもの＝今までと同じ） */
export function buildInlinePlanSystem(o: { hasRules: boolean; hasRefs: boolean }): string {
  let sys = INLINE_PLAN_SYSTEM;
  if (o.hasRules) sys += RULES_PRIORITY_SYSTEM;
  if (o.hasRefs) sys += REFS_SYSTEM;
  return sys;
}

export async function planInlineImages(llm: Llm, input: InlinePlanInput) {
  return llm.structured({
    tier: 'heavy',
    label: '文中画像の指示文',
    schema: InlinePlan,
    maxTokens: 4000,
    system: buildInlinePlanSystem({ hasRules: Boolean(input.rules), hasRefs: Boolean(input.refNames?.length) }),
    user: buildInlinePlanUser(input),
  });
}

// ── 記録（監査ログで数える）─────────────────────────────────
/** 描く直前に記録する（成功・失敗にかかわらず数える）。上限の判定はこれで行う。★サムネ（thumbnail.reserved）とは別 */
export const AUDIT_INLINE_RESERVED = 'inline_image.reserved';
/** 保存まで済んだ記録（記録用。判定には使わない） */
export const AUDIT_INLINE_GENERATED = 'inline_image.generated';

function jstDayStartIso(): string {
  return new Date(`${jstDate()}T00:00:00+09:00`).toISOString();
}

export async function countInlineToday(db: Db, tenantId: string): Promise<number> {
  return (await db.raw
    .prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND tenant_id = ? AND created_at >= ?')
    .bind(AUDIT_INLINE_RESERVED, tenantId, jstDayStartIso())
    .first<{ c: number }>())?.c ?? 0;
}

export async function countInlineForArticle(db: Db, articleId: string): Promise<number> {
  return (await db.raw
    .prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND target = ?')
    .bind(AUDIT_INLINE_RESERVED, articleId)
    .first<{ c: number }>())?.c ?? 0;
}

// ── 失敗の理由（プレビューに出す短い日本語）────────────────────
const STOP_KINDS: readonly string[] = ['billing', 'auth', 'verification'];

export function inlineFailureNote(kind: ImageErrorKind | string): string {
  switch (kind) {
    case 'billing': return 'OpenAI の残高または利用上限に達していました（platform.openai.com の Billing でチャージをお願いします）';
    case 'auth': return 'OpenAI の API キーが正しくありませんでした';
    case 'verification': return 'OpenAI の「組織の認証」が必要と表示されました';
    case 'policy': return 'OpenAI の安全基準で断られました';
    case 'rate': return 'OpenAI が混み合っていました';
    case 'temp': return 'OpenAI 側の一時的な不調でした';
    case 'timeout': return '画像の作成に時間がかかりすぎたため打ち切りました';
    default: return '画像を作れませんでした';
  }
}

export const NOTE_ARTICLE_LIMIT =
  `この記事の文中の画像は${MAX_INLINE_PER_ARTICLE}回まで作りました。これ以上は費用が増えるため止めています`;
export function noteDailyLimit(limit: number): string {
  return `きょうの文中の画像の上限（${limit}枚）に達したため、作りませんでした。あすになるとまた作れます`;
}

// ── 本体 ──────────────────────────────────────────────────
export interface InlineDeps {
  db: Db;
  images: ImageStore;
  /** 指示文づくりに使う LLM の設定 */
  llm: LlmConfig;
  /** 未設定なら生成しない */
  openaiKey?: string | null;
  /** 画像を作る口（テスト用の差し替え）。省略時は OpenAI（gpt-image-2） */
  generator?: ImageGenerator;
  /** 参考画像のランダム選択に使う乱数（0 以上 1 未満）。テストで固定するためのもの */
  random?: () => number;
}

export interface InlinePlanItem {
  slot: number; heading: string | null; prompt: string; altText: string;
  /** ランダム選択のとき、この画像に使う参考画像の id（並びは画像の順）。無ければ登録した参考画像を全部使う */
  refIds?: string[];
}

export type InlinePlanOutcome =
  | { status: 'ok'; items: InlinePlanItem[]; notes: string[] }
  | { status: 'skipped'; reason: 'no_key' | 'none' | 'article_limit' | 'daily_limit'; note: string | null }
  | { status: 'failed'; note: string };

/**
 * 指示文を作る（Workflow の step「文中の画像の指示文を作る」の中身）。例外は投げない。
 * @param force 作り直し（ボタン）。本文にある番号すべてを作り直す。既定は「画像がまだ無い番号」だけ
 */
export async function prepareInlinePlan(
  deps: InlineDeps, articleId: string, opts: { force?: boolean } = {},
): Promise<InlinePlanOutcome> {
  const { db } = deps;
  try {
    if (!hasImageKey(deps.openaiKey)) return { status: 'skipped', reason: 'no_key', note: null };
    const article = await db.getArticle(articleId);
    if (!article?.body_md) return { status: 'skipped', reason: 'none', note: null };
    const slots = listGeneratedSlots(article.body_md);
    if (slots.length === 0) return { status: 'skipped', reason: 'none', note: null };

    const existing = new Set((await db.listGeneratedImages(articleId)).map((r) => r.gen_slot));
    const targets = opts.force ? slots : slots.filter((s) => !existing.has(s.slot));
    // ★作る必要が無ければ、文章モデルも呼ばない（修正で全部使い回せたとき・処理のやり直し）
    if (targets.length === 0) return { status: 'skipped', reason: 'none', note: null };

    // ★上限に達しているなら、指示文の費用もかけない
    if ((await countInlineForArticle(db, articleId)) >= MAX_INLINE_PER_ARTICLE) {
      return { status: 'skipped', reason: 'article_limit', note: NOTE_ARTICLE_LIMIT };
    }
    const settings = await getInlineSettings(db);
    if ((await countInlineToday(db, article.tenant_id)) >= settings.dailyLimit) {
      return { status: 'skipped', reason: 'daily_limit', note: noteDailyLimit(settings.dailyLimit) };
    }

    const context = await db.getActiveContext(article.tenant_id);
    // ★登録が無ければ null / 空（今までと同じ指示文になる）
    const rules = await getImageRules(db, article.tenant_id, 'inline');
    // 指示文づくりに要るのは名前だけ（画像そのものは読まない。置き場から読むのは描くときの1回だけ）
    const refRows = (await listImageRefs(db, article.tenant_id)).slice(0, REF_MAX_COUNT);
    const refNames = refRows.map((r) => r.name);
    // ★ランダム選択: 画像ごとに組を選ぶ（指示文づくりの前に選び、名前を渡して場面に合わせて描かせる）
    const castIds = new Map<number, string[]>();
    if (refRows.length && await getRefRandom(db)) {
      for (const t of targets) castIds.set(t.slot, selectRefs(refRows, deps.random ?? Math.random).map((r) => r.id));
    }
    const nameOf = (id: string) => refRows.find((r) => r.id === id)?.name ?? '';
    const castBySlot = castIds.size
      ? Object.fromEntries([...castIds].map(([slot, ids]) => [slot, ids.map(nameOf)])) : undefined;
    const llm = createLlm(deps.llm);
    const { data } = await planInlineImages(llm, {
      title: article.title ?? '',
      slots: targets,
      knowledge: context ? (context.prompt_snippet ?? context.raw_text) : null,
      rules: rules?.body || null,
      refNames: refNames.length ? refNames : undefined,
      castBySlot,
    });
    const byslot = new Map(data.images.map((x) => [x.slot, x]));
    const items: InlinePlanItem[] = [];
    for (const t of targets) {
      const p = byslot.get(t.slot);
      if (p) {
        items.push({
          slot: t.slot, heading: t.heading, prompt: p.prompt, altText: p.altText.slice(0, 80),
          ...(castIds.has(t.slot) ? { refIds: castIds.get(t.slot)! } : {}),
        });
      }
    }
    const lacking = targets.length - items.length;
    return { status: 'ok', items, notes: lacking > 0 ? [`${lacking}枚分の指示文を作れませんでした`] : [] };
  } catch (e) {
    if (e instanceof LlmError) {
      log.warn('文中画像の指示文づくりに失敗', e.message);
      return { status: 'failed', note: `文中の画像の下ごしらえに失敗しました（${e.userMessage.split('\n')[0]}）` };
    }
    log.error('文中画像の指示文づくりで想定外のエラー', String(e));
    return { status: 'failed', note: '文中の画像の下ごしらえに失敗しました' };
  }
}

export type InlineImageOutcome =
  | { status: 'created'; slot: number }
  | { status: 'exists'; slot: number }
  | { status: 'skipped'; slot: number; reason: 'no_key' | 'gone' | 'article_limit' | 'daily_limit'; note: string | null; stopRest: boolean }
  | { status: 'failed'; slot: number; kind: string; note: string; stopRest: boolean };

/**
 * 1枚作って登録する（Workflow の step「文中の画像を作る N」の中身）。例外は投げない。
 * @param force 作り直し。すでにある画像は、新しい画像ができてから消す（失敗したら前の画像のまま）
 */
export async function ensureInlineImage(
  deps: InlineDeps, articleId: string, item: InlinePlanItem,
  /** refs: 読み込み済みの参考画像（runInlineImageSteps が1回の実行で1度だけ読んで渡す）。省略時はここで読む */
  opts: { force?: boolean; refs?: LoadedRef[] } = {},
): Promise<InlineImageOutcome> {
  const { db } = deps;
  const slot = item.slot;
  try {
    if (!hasImageKey(deps.openaiKey)) return { status: 'skipped', slot, reason: 'no_key', note: null, stopRest: true };
    const article = await db.getArticle(articleId);
    // 指示文を作ったあとに本文が変わり、この番号が無くなった（作らない・課金しない）
    if (!article?.body_md || !listGeneratedSlots(article.body_md).some((s) => s.slot === slot)) {
      return { status: 'skipped', slot, reason: 'gone', note: null, stopRest: false };
    }
    const existing = (await db.listGeneratedImages(articleId)).find((r) => r.gen_slot === slot) ?? null;
    // ★自動の呼び出しでは、すでにあるものを作り直さない（処理のやり直しで二重に課金されないため）
    if (existing && !opts.force) return { status: 'exists', slot };

    if ((await countInlineForArticle(db, articleId)) >= MAX_INLINE_PER_ARTICLE) {
      return { status: 'skipped', slot, reason: 'article_limit', note: NOTE_ARTICLE_LIMIT, stopRest: true };
    }
    const settings = await getInlineSettings(db);
    if ((await countInlineToday(db, article.tenant_id)) >= settings.dailyLimit) {
      return { status: 'skipped', slot, reason: 'daily_limit', note: noteDailyLimit(settings.dailyLimit), stopRest: true };
    }

    // 参考画像（サムネと共有）。あれば images/edits、無ければ従来どおり
    const loaded = opts.refs ?? await loadReferenceImages(db, deps.images, article.tenant_id);
    // ★ランダム選択のときは、指示文づくりで選んだ組だけを使う（並びも選んだ順）。
    //   選んだ画像がその後に消されていたら、残った分だけで描く
    const refs = item.refIds
      ? item.refIds.map((id) => loaded.find((r) => r.id === id)).filter((r): r is LoadedRef => Boolean(r))
      : loaded;
    const editPrompt = [item.prompt, REFERENCE_CLAUSE, item.refIds ? refNamesClause(refs.map((r) => r.name)) : '']
      .filter(Boolean).join('\n\n');

    // 描く（課金はここ）。★直前に予約として数える。この後に失敗しても取り消さない
    const client = deps.generator ?? new OpenAiImageClient(deps.openaiKey!);
    await db.audit(article.tenant_id, AUDIT_INLINE_RESERVED, 'system', articleId, 'ok', { slot });
    const img = refs.length
      ? await client.edit(editPrompt, refs, INLINE_IMAGE_SIZE)
      : await client.generate(item.prompt, INLINE_IMAGE_SIZE);

    // ★置き場の名前は一意のIDで作る（サムネと同じ理由。同名で前の画像を消す事故を防ぐ）
    const n = newId();
    const key = `gen_inline_${articleId}_${n}`;
    await deps.images.put(key, img.bytes, img.contentType);
    await db.raw.prepare(
      `INSERT INTO images (id, tenant_id, article_id, r2_key, mime_type, size_bytes, line_message_id,
                           alt_text, is_eyecatch, source, gen_prompt, gen_slot, gen_heading, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'generated', ?, ?, ?, ?)`)
      .bind(newId(), article.tenant_id, articleId, key, img.contentType, img.bytes.byteLength,
        `geninline:${articleId}:${n}`, item.altText, item.prompt, slot, item.heading, new Date().toISOString())
      .run();
    // ★置き換えるのは、描く前に取った行ではなく「描いたあとに読み直した同じ番号の行すべて」。
    //   いま入れた行（いちばん新しい）だけを残す（同時に2本走った・前の画像を消し損ねた場合も1つに畳む）
    await foldGeneratedDuplicates(db, deps.images, articleId);
    await db.audit(article.tenant_id, AUDIT_INLINE_GENERATED, 'system', articleId, 'ok', {
      slot, size: img.size, bytes: img.bytes.byteLength, usage: img.usage,
    });
    return { status: 'created', slot };
  } catch (e) {
    if (e instanceof ImageGenError) {
      log.warn('文中画像の生成に失敗', `${e.kind}: ${e.message}`);
      return { status: 'failed', slot, kind: e.kind, note: inlineFailureNote(e.kind), stopRest: STOP_KINDS.includes(e.kind) };
    }
    log.error('文中画像の生成で想定外のエラー', String(e));
    return { status: 'failed', slot, kind: 'unknown', note: inlineFailureNote('unknown'), stopRest: false };
  }
}

/** Workflow の step.do と同じ形（単体テストで実際に動かせるよう、cloudflare:workers に依存しない） */
export type StepDo = <T>(name: string, config: { retries: { limit: number; delay: string }; timeout: string },
  fn: () => Promise<T>) => Promise<T>;

const STEP_CONFIG = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' };

/**
 * 指示文 → 1枚ずつ、を Workflow の独立した step で順番に行う。理由（プレビューに出す）を返す。例外は投げない。
 * ★retries: 0 の理由: 描いた時点で課金されるので、step の自動再試行で二重に課金させない。
 * ★step そのものが落ちても（5分の時間切れなど）受け止めて次へ進む（記事は必ず届ける）。
 * @param prefix step 名の頭（記事生成と作り直しで step 名がぶつからないようにする）
 */
export async function runInlineImageSteps(
  stepDo: StepDo, deps: InlineDeps, articleId: string,
  opts: { force?: boolean; prefix?: string; heartbeat?: () => Promise<void> } = {},
): Promise<string[]> {
  const prefix = opts.prefix ?? '';
  let plan: InlinePlanOutcome;
  try {
    plan = await stepDo(`${prefix}文中の画像の指示文を作る`, STEP_CONFIG,
      () => prepareInlinePlan(deps, articleId, { force: opts.force }));
  } catch (e) {
    log.error('「文中の画像の指示文を作る」が止まったため、文中の画像なしで続けます', String(e));
    return ['文中の画像の下ごしらえが途中で止まりました'];
  }
  if (plan.status === 'failed') return [plan.note];
  if (plan.status === 'skipped') return plan.note ? [plan.note] : [];

  const reasons = [...plan.notes];
  // ★参考画像は1回の実行で1度だけ読み、全部の画像で使い回す（1枚ごとに置き場から読み直さない）。
  //   step の戻り値には入れられない（画像のバイト列）ので step の外で読む。読めなければ参考画像なしで続ける
  let refs: LoadedRef[] = [];
  try { refs = await loadReferenceImages(deps.db, deps.images, (await deps.db.getArticle(articleId))?.tenant_id ?? ''); } catch { refs = []; }
  for (let i = 0; i < plan.items.length; i++) {
    let out: InlineImageOutcome;
    // 1枚ごとに「作成中」の印の期限を延ばす（5枚で10分を超えても、途中で別の作り直しを通さない）
    await opts.heartbeat?.().catch(() => {});
    try {
      out = await stepDo(`${prefix}文中の画像を作る ${i + 1}`, STEP_CONFIG,
        () => ensureInlineImage(deps, articleId, plan.items[i], { force: opts.force, refs }));
    } catch (e) {
      log.error('「文中の画像を作る」が止まったため、この1枚を飛ばします', String(e));
      out = { status: 'failed', slot: plan.items[i].slot, kind: 'step', note: '時間がかかりすぎたため打ち切りました', stopRest: false };
    }
    if ((out.status === 'failed' || out.status === 'skipped') && out.note) reasons.push(out.note);
    if ((out.status === 'failed' || out.status === 'skipped') && out.stopRest) break;
  }
  return [...new Set(reasons)];
}

// ── プレビューに載せる形 ──────────────────────────────────────
export interface InlineImagesView {
  /** 本文にある AI 画像の番号の数 */
  slots: number;
  /** 画像ができている番号 */
  created: number[];
  /** 作れなかった枚数 */
  missing: number;
  /** 作れなかった理由（分かるときだけ） */
  reasons: string[];
  /** 前回の画像を、見出しの違う場所に使い回している */
  reusedMismatch: boolean;
  /** 「文中画像を作り直す」を出すか */
  canRegenerate: boolean;
}

/** 本文と images から、いまの状態を作る（理由は Workflow から渡されたときだけ） */
export async function loadInlineView(
  db: Db, article: Pick<ArticleRow, 'id' | 'body_md'>, opts: { hasKey: boolean; reasons?: string[] },
): Promise<InlineImagesView | undefined> {
  const slots = listGeneratedSlots(article.body_md ?? '');
  if (slots.length === 0) return undefined;
  const rows = await db.listGeneratedImages(article.id);
  return inlineViewOf(slots, rows, opts);
}

/** 純関数版（テスト用にも使う） */
export function inlineViewOf(
  slots: GeneratedSlot[], rows: Array<Pick<ImageRow, 'gen_slot' | 'gen_heading'>>,
  opts: { hasKey: boolean; reasons?: string[] },
): InlineImagesView {
  const bySlot = new Map(rows.map((r) => [r.gen_slot, r]));
  const created = slots.filter((s) => bySlot.has(s.slot)).map((s) => s.slot);
  const reusedMismatch = slots.some((s) => {
    const r = bySlot.get(s.slot);
    return Boolean(r) && (r!.gen_heading ?? null) !== s.heading;
  });
  return {
    slots: slots.length,
    created,
    missing: slots.length - created.length,
    reasons: opts.reasons ?? [],
    reusedMismatch,
    canRegenerate: opts.hasKey,
  };
}
