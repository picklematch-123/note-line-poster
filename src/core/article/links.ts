/**
 * 公開・下書き保存の直前のリンク検査（★2026-10-24 源蔵 再レビューの条件）。
 *
 * 仕上げ（core/research/finalize.ts）で、本人が書いた URL と検査済みの出典以外は消してある。
 * ここはその「最後の関所」。仕上げを通らない道（古い記事・将来の改修での抜け）ができても、
 * note に送る HTML に許可外のリンク先（href / src など）があれば、公開も下書き保存もしない。
 *
 * ★許可の考え方は finalize と同じ（同じ判定を2か所に書かない＝検査は findDisallowedLinks 1つ）:
 *   ・ナレッジの原文（★過去の版も含める。古い記事に、前の版のナレッジの URL が残っていても止めない）
 *   ・ネタ・修正指示（本人が書いたもの）
 *   ・保存済みの調査（research_json）の検査済み出典
 *   ・note に上げた画像の URL／拡張が後で差し替える目印 `{{imageN_url}}`（AI 文中画像は `{{image(100+N)_url}}`）
 * ★research_json が NULL の記事（調査の仕組みより前の記事）でも、本人の URL と note の画像だけなら通る。
 *
 * 引っかかったら: 監査ログに記録 → 記事の状態を「直せる状態」に保つ → 呼び出し側が LINE で知らせる。
 */
import type { Db, ArticleRow } from '../../ports/storage/db';
import type { ArticleState } from './state';
import { toNoteHtml } from '../../ports/publisher/note/html';
import { parse } from './placeholders';
import { composeArticleMarkdown, type GeneratedFill } from './compose';
import { findDisallowedLinks, extractTextUrls } from '../research/urls';
import { parseResearch } from '../research/run';
import { log } from '../../lib/mask';

export const AUDIT_LINK_BLOCKED = 'publish.link_blocked';

/** 許可に使うナレッジの版の数の上限（通常は数件。読み込みすぎない） */
const MAX_CONTEXT_ROWS = 100;

/** 公開時まで画像の URL が分からないので、本文には差し込み用の目印を入れておく（core/agent/plan.ts と同じ形） */
export function imageUrlPlaceholder(slot: number): string {
  return `{{image${slot}_url}}`;
}

/**
 * AI が作った文中画像（`[AI画像N]`）の目印。写真の目印と番号がぶつからないよう 100 を足す（設計書 18-2）。
 * 形は写真と同じ `{{imageN_url}}` なので、html.ts の FILLED_FIGURE と拡張の差し替えがそのまま使える
 */
export const GENERATED_SLOT_OFFSET = 100;
export function generatedImageUrlPlaceholder(slot: number): string {
  return imageUrlPlaceholder(GENERATED_SLOT_OFFSET + slot);
}

export type LinkGuardKind = 'publish' | 'draft';

/** どこで止めたか。precheck = note に何も送る前／final = 送る直前の最終 HTML */
export type LinkGuardStage = 'precheck' | 'final' | 'agent_plan';

/**
 * 止めたことを示す例外。userMessage は LINE にそのまま出せる日本語。
 * ★リンク先そのものは文面に入れない（LINE が文中の URL をリンクにしてしまうため）。
 */
export class DisallowedLinksError extends Error {
  constructor(
    readonly kind: LinkGuardKind,
    readonly bad: string[],
    readonly userMessage: string,
  ) {
    super(`許可されていないリンク先が ${bad.length} 件あったため止めました`);
    this.name = 'DisallowedLinksError';
  }
}

/**
 * URL の書き方の揺れも許可に足す。
 * 出典一覧（finalize の buildReferences）は `new URL().href` にそろえ、括弧・空白を %28 などにしてから
 * リンクにするので、元の書き方と比べると食い違う。同じ URL のいくつかの書き方をまとめて許可する。
 */
function variants(url: string): string[] {
  const out = [url];
  try {
    const href = new URL(url).href;
    out.push(href, href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20'));
  } catch { /* URL として読めないものは元の形だけ */ }
  return out;
}

/** 許可する URL の一覧を作る（純関数） */
export function buildAllowedLinks(input: {
  trustedTexts: Array<string | null | undefined>;
  sourceUrls?: string[];
  imageUrls?: string[];
}): string[] {
  const urls = [
    ...input.trustedTexts.flatMap((t) => (t ? extractTextUrls(t) : [])),
    ...(input.sourceUrls ?? []),
    ...(input.imageUrls ?? []),
  ];
  return [...new Set(urls.flatMap(variants))];
}

/** ナレッジの原文（有効な版と過去の版）。新しい順 */
async function listKnowledgeTexts(db: Db, tenantId: string): Promise<string[]> {
  const r = await db.raw
    .prepare('SELECT raw_text FROM tenant_context WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?')
    .bind(tenantId, MAX_CONTEXT_ROWS)
    .all<{ raw_text: string | null }>();
  return (r.results ?? []).map((x) => x.raw_text ?? '').filter(Boolean);
}

/** この記事で許可する URL（note の画像 URL は呼び出し側が分かった時点で渡す） */
export async function collectAllowedLinks(db: Db, article: ArticleRow, imageUrls: string[] = []): Promise<string[]> {
  const research = parseResearch(article.research_json);
  return buildAllowedLinks({
    trustedTexts: [...(await listKnowledgeTexts(db, article.tenant_id)), article.source_text, article.revision_instruction],
    sourceUrls: (research?.facts ?? []).map((f) => f.sourceUrl),
    imageUrls,
  });
}

/**
 * 公開 HTML の検査（純関数）。許可外のリンク先を返す（空なら問題なし）。
 * @param placeholderSlots 拡張に渡す手順書の `{{imageN_url}}`（1..N）を許可する数
 * @param generatedSlots AI 文中画像の番号。`{{image(100+N)_url}}` を、その番号の分だけ許可する
 */
export function findArticleLinkProblems(
  html: string, allowed: Iterable<string>, placeholderSlots = 0, generatedSlots: readonly number[] = [],
): string[] {
  const placeholders = new Set([
    ...Array.from({ length: placeholderSlots }, (_, i) => imageUrlPlaceholder(i + 1)),
    ...generatedSlots.map(generatedImageUrlPlaceholder),
  ]);
  return findDisallowedLinks(html, allowed).filter((v) => !placeholders.has(v));
}

/**
 * 公開する HTML を、画像の URL を目印にしたまま組み立てる（service.ts / plan.ts と同じ compose を通す）
 * @param generated AI 文中画像（番号 → alt）。画像のある番号だけ渡す
 */
export function renderWithPlaceholders(
  article: ArticleRow, imageCount: number, generated: Array<{ slot: number; alt?: string | null }> = [],
): string {
  const urls: Record<number, string> = {};
  for (let i = 1; i <= imageCount; i++) urls[i] = imageUrlPlaceholder(i);
  const gen: Record<number, GeneratedFill> = {};
  for (const g of generated) gen[g.slot] = { url: generatedImageUrlPlaceholder(g.slot), alt: g.alt };
  const alts: Record<string, string> = article.image_alts_json ? JSON.parse(article.image_alts_json) : {};
  return toNoteHtml(composeArticleMarkdown({
    bodyMd: article.body_md ?? '', photoCount: imageCount, photoUrls: urls, photoAlts: alts, generated: gen,
  }));
}

/**
 * 本文に置かれていて、画像もある AI 文中画像（番号順）。
 * ★本文に `[AI画像N]` が1つも無ければ D1 を読まない（P3 より前の記事・0枚設定。ほとんどの記事）
 */
export async function listPlacedGeneratedImages(db: Db, article: Pick<ArticleRow, 'id' | 'body_md'>) {
  const slots = new Set(parse(article.body_md ?? '', 'generated').map((p) => p.index));
  if (slots.size === 0) return [];
  return (await db.listGeneratedImages(article.id)).filter((r) => r.gen_slot != null && slots.has(r.gen_slot));
}

/** 止めたあとも、この状態のままにしておく（「修正する」「公開する」をもう一度押せる） */
const KEEP_STATES: readonly ArticleState[] = ['awaiting_approval', 'preview_ready', 'editing', 'drafted'];

function blockedMessage(kind: LinkGuardKind, stage: LinkGuardStage, failed: boolean): string {
  const what = kind === 'publish' ? '公開' : '下書き保存';
  const head = `記事に想定外のリンクが含まれていたため、${what}を止めました。` +
    (stage === 'final' ? '' : '（note には何も送っていません）');
  const next = failed
    ? '直したい内容（例:「想定外のリンクを消して」）をこのまま送ってください。書き直します。\nやめる場合は「やめる」と送ってください。'
    : '「修正する」を押して、「想定外のリンクを消して」のように送ってください。書き直します。';
  return `${head}\n\n${next}`;
}

/**
 * 止めた後始末（監査ログ・記事の状態）をして、投げる例外を返す。
 * ★状態が壊れないようにする:
 *   ・確認待ち・下書き済みなど → そのまま（承認だけ取り消す。直したあとに改めて「公開する」を押してもらう）
 *   ・待機中（blocked / awaiting_session）や送信中 → failed に落とす。
 *     待機中のままにすると、15分ごとの自動公開が同じ記事で止まり続け、知らせも繰り返し届く
 */
export async function blockForDisallowedLinks(
  db: Db, article: ArticleRow, kind: LinkGuardKind, bad: string[], stage: LinkGuardStage,
): Promise<DisallowedLinksError> {
  log.warn('許可されていないリンク先があったため止めました', { articleId: article.id, kind, stage, count: bad.length });
  await db.audit(article.tenant_id, AUDIT_LINK_BLOCKED, 'system', article.id, 'denied', {
    kind, stage, count: bad.length, links: bad.slice(0, 5).map((s) => s.slice(0, 200)),
  });
  const current = (await db.getArticle(article.id)) ?? article;
  const failed = !KEEP_STATES.includes(current.state);
  if (failed) {
    await db.markFailed(article.id, 'system', { reason: 'disallowed_links', kind, stage });
  }
  await db.updateArticle(article.id, {
    approved_at: null, approved_by: null,
    error_code: 'disallowed_links',
    error_message: `許可されていないリンク先 ${bad.length} 件（${stage}）`,
  });
  return new DisallowedLinksError(kind, bad, blockedMessage(kind, stage, failed));
}

/**
 * 事前検査: note に何かを送る前（器の作成・画像のアップロードより前）に、画像を目印にした HTML で検査する。
 * ★ここで止めれば note に空の下書きが残らない。最終 HTML との違いは「画像の URL（note のもの＝許可）」だけ。
 */
export async function precheckArticleLinks(db: Db, article: ArticleRow, kind: LinkGuardKind): Promise<void> {
  const images = await db.listImages(article.id);
  const generated = (await listPlacedGeneratedImages(db, article)).map((r) => ({ slot: r.gen_slot!, alt: r.alt_text }));
  const html = renderWithPlaceholders(article, images.length, generated);
  await checkOrBlock(db, article, html, kind, [], images.length, 'precheck', generated.map((g) => g.slot));
}

/**
 * リンク先が1つも無い（画像だけ）なら、許可の一覧を読まずに通す（ほとんどの記事はこれ。D1 を余計に読まない）。
 * リンク先があるときだけ、ナレッジ・調査を読んで許可の一覧と照らす。
 */
async function checkOrBlock(
  db: Db, article: ArticleRow, html: string, kind: LinkGuardKind,
  imageUrls: string[], placeholderSlots: number, stage: LinkGuardStage, generatedSlots: readonly number[] = [],
): Promise<void> {
  if (findArticleLinkProblems(html, buildAllowedLinks({ trustedTexts: [], imageUrls }), placeholderSlots, generatedSlots).length === 0) return;
  const allowed = await collectAllowedLinks(db, article, imageUrls);
  const bad = findArticleLinkProblems(html, allowed, placeholderSlots, generatedSlots);
  if (bad.length) throw await blockForDisallowedLinks(db, article, kind, bad, stage);
}

/** 送る直前の HTML を検査する。引っかかったら後始末をして DisallowedLinksError を投げる */
export async function assertArticleHtmlLinks(
  db: Db, article: ArticleRow, html: string, kind: LinkGuardKind,
  opts: { imageUrls?: string[]; placeholderSlots?: number; generatedSlots?: readonly number[]; stage: LinkGuardStage },
): Promise<void> {
  await checkOrBlock(db, article, html, kind, opts.imageUrls ?? [], opts.placeholderSlots ?? 0, opts.stage, opts.generatedSlots ?? []);
}

/** 知らせる相手（押した人・記事の担当者・持ち主）。同じ人には1回だけ */
export function linkBlockRecipients(
  article: Pick<ArticleRow, 'requested_by'> | null, ownerLineUserId: string | null, presser?: string | null,
): string[] {
  return [...new Set([presser, article?.requested_by, ownerLineUserId].filter((x): x is string => Boolean(x)))];
}
