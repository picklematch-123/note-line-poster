/**
 * サムネイル（見出し画像）の自動生成。
 *
 * 流れ: 記事の見出し・本文＋ナレッジ → Claude が画像の指示文を作る → OpenAI(gpt-image-2) が1枚描く
 *       → 一時置き場(KV)に入れ、images に「生成」として登録 → サムネイルに指定
 *
 * ★守っていること
 *  - 失敗しても記事は止めない。例外は投げず、結果（理由つき）を返す
 *  - 費用の歯止め: 1記事あたり・1日あたりの回数に上限。★課金の直前に「予約」として数える（監査ログ）。
 *    2026-10-24 源蔵必須5: 以前は「描く（課金）→保存→成功後に数える」で、保存に失敗すると
 *    課金されたのに数えない分が出ていた。失敗しても数えたままにする（過少に数えるより安全）
 *  - ユーザーが LINE で送った写真とは区別する（images.source = 'generated'）
 *  - 画像に長い日本語を入れさせない／実在の人物・ロゴ・商標を描かせない
 *  - キー未設定の環境（既存の顧客）では何もしない。今までどおり動く
 *
 * ★2026-10-26 画像のルール（設計書 docs/design-image-rules-2026-10-26.md）
 *  - 「画像のルール」（core/image/rules.ts）を登録した環境だけ、ルール本文・題名モード・検品が働く。
 *    行が無ければ今までと完全に同じ（指示文・呼び出し・数え方とも）
 *  - 題名モード=title: 記事タイトルはコードが一字一句そのまま指示に入れる（LLM に言い換えさせない）
 *  - 参考画像があれば images/edits（見た目だけ使う固定文つき）、無ければ従来の generations
 *  - 検品で不合格なら指摘を足して作り直す（上限＝検品やり直し回数）。上限まで不合格なら画像を保存せず
 *    status='rejected'（サムネなしで記事は進める）。検品できなかった（通信・非対応）ときは「未検品」で採用
 *  - 1記事の上限は「実行（run）」の数で数える。自動のやり直しで、手動の作り直しの枠を食わないため。
 *    生成1回ごとの予約（thumbnail.reserved）は今までどおり記録し、1日の上限にも数える
 */
import { z } from 'zod';
import type { Db } from '../../ports/storage/db';
import type { ImageStore } from '../../ports/storage/images';
import { LlmError, type Llm } from '../../ports/llm/types';
import { createLlm, type LlmConfig } from '../../ports/llm';
import { ImageGenError, OpenAiImageClient } from '../../ports/image/openai';
import type { GeneratedImage, ImageGenerator } from '../../ports/image/types';
import {
  getImageRules, loadReferenceImages, REFERENCE_CLAUSE, titleClause, type TitleMode,
  getRefRandom, selectRefs, refNamesClause,
} from './rules';
import { jstDate } from '../../lib/time';
import { newId } from '../../lib/id';
import { log } from '../../lib/mask';

// ── 設定（顧客ごと＝環境ごとに system_flags へ保存）────────────
export const FLAG_AUTO = 'thumb_auto';
export const FLAG_DAILY_LIMIT = 'thumb_daily_limit';

/**
 * 1記事に作れる回数（初回＋作り直し2回）。請求の暴走を防ぐ。
 * ★2026-10-26 から「実行（run）」の数。1実行の生成は最大 1+検品やり直し回数（最大3枚）
 */
export const MAX_PER_ARTICLE = 3;
/**
 * 1記事で作る画像の合計の上限（★2026-10-26 源蔵レビュー必須3）。検品のやり直しも予約を取るのでここに数える。
 * 実行3回 × 最大3枚 = 9枚まで行けてしまう食い違いを、ここで止める（1枚 約5〜6円 → 1記事 最大 約35〜40円）
 */
export const MAX_GENERATIONS_PER_ARTICLE = 6;
/**
 * 1回の実行で、次の1枚を作り始めてよい経過時間の上限（★2026-10-26 源蔵レビュー必須1）。
 * step「サムネイルを作る」の 5 分の時間切れに近づかないよう、これを過ぎたら次の1枚は作らない
 */
export const THUMB_RUN_BUDGET_MS = 150_000;
/** 1日に作れる枚数の既定。1枚 約6〜9円なので、最大でも1日 約90円 */
export const DEFAULT_DAILY_LIMIT = 10;
/** 選択肢。0（無制限）は用意しない。止めたいときは自動生成をオフにする */
export const DAILY_LIMIT_OPTIONS = [3, 5, 10, 20, 50] as const;
export const DAILY_LIMIT_MAX = 100;

export interface ThumbSettings { auto: boolean; dailyLimit: number }

export async function getThumbSettings(db: Db): Promise<ThumbSettings> {
  const auto = await db.getNumberFlag(FLAG_AUTO, 1);
  const limit = await db.getNumberFlag(FLAG_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  return { auto: auto !== 0, dailyLimit: Math.min(Math.max(Math.floor(limit), 1), DAILY_LIMIT_MAX) };
}

export async function setThumbAuto(db: Db, on: boolean, by: string): Promise<void> {
  await db.setNumberFlag(FLAG_AUTO, on ? 1 : 0, 'サムネ自動生成の切替', by);
}

export async function setThumbDailyLimit(db: Db, n: number, by: string): Promise<void> {
  const v = Math.min(Math.max(Math.floor(n), 1), DAILY_LIMIT_MAX);
  await db.setNumberFlag(FLAG_DAILY_LIMIT, v, 'サムネ自動生成の1日上限', by);
}

// ── 画像の指示文を作る（Claude）─────────────────────────────
const ThumbPlan = z.object({
  prompt: z.string().min(20).max(1500),
  altText: z.string().min(1).max(80),
});
export type ThumbPlan = z.infer<typeof ThumbPlan>;

export const PLAN_SYSTEM = `あなたは note 記事のサムネイル（見出し画像）の指示文を作る編集者です。
記事の内容に合う、横長のサムネイル1枚を描くための英語の指示文(prompt)と、日本語の代替テキスト(altText)を作ります。

【指示文のルール】
- 英語で書く。構図・主題・色・雰囲気を具体的に（100〜200語）
- 横長(約2:1)。大事なものは中央に置く（左右が少し切れても成立するように）
- 画像の中に文字を入れない。どうしても必要なら、短い英単語を最大2語まで
- 日本語の文字は絶対に入れない（崩れるため）
- 実在の人物・有名人・ロゴ・商標・ブランド名・キャラクターを描かない。人を描くなら架空の人物
- 既定は、明るく親しみやすいフラットなイラスト調。ナレッジに画風の指定があればそちらを優先する
- ナレッジの「書かないこと」「避けること」に当たるものは描かない
- 記事に書かれていない事実（効果・数字・施設）を示唆する絵にしない
- 記事に出てこない料理・商品・メニュー・店舗の設備を描かない。記事の本文・ナレッジに書かれたものだけを描く
- 生肉・生食（刺身・たたき等）を描かない

【altText】
画像の内容を日本語で40字以内。「〜の画像」で終えない。

JSON: {"prompt": "...", "altText": "..."}`;

/** 題名モードで置き換える、文字の扱いの2行（PLAN_SYSTEM の中の文と一字一句同じであること） */
const NO_TEXT_RULES = '- 画像の中に文字を入れない。どうしても必要なら、短い英単語を最大2語まで\n- 日本語の文字は絶対に入れない（崩れるため）\n';
const TITLE_TEXT_RULES =
  '- 画像の中の文字は、記事タイトル1つだけ。タイトルの文字列は、こちらで後から一字一句そのまま指示に足す\n' +
  '- 指示文には、タイトルの文字列・その他の文字・看板やロゴの文字を書かない\n' +
  '- タイトルを大きく読みやすく置ける余白（空・帯・無地の背景など）を構図の中に確保する\n';

/** 題名モード（title）の指示文づくり。「日本語を入れない」「英単語2語まで」を外し、題名の余白を作らせる */
export const PLAN_SYSTEM_TITLE = PLAN_SYSTEM.replace(NO_TEXT_RULES, TITLE_TEXT_RULES);

/** 顧客の画像ルールがあるときに足す（★固定の安全ルールはルールより優先と明記する） */
export const RULES_PRIORITY_SYSTEM = `

【この顧客の画像ルール】
ユーザー文の「この顧客の画像ルール（最優先）」に従う。画風・色・構図・登場人物の指定は、ナレッジの画風指定よりもこのルールを優先する。
ただし、次の安全ルールは顧客の画像ルールよりも優先する（ルールに反対のことが書かれていても守る）:
実在の人物・有名人を描かない／実在のロゴ・商標・ブランド名を描かない／生肉・生食を描かない／記事に書かれていない料理・商品・設備を描かない。`;

/** 参考画像（キャラクター）があるときに足す */
export const REFS_SYSTEM = `

【参考画像】
キャラクターの参考画像が別に渡される。そのキャラクターを主役として登場させ、ポーズ・表情・場面は記事に合わせて新しく決める。
顔・髪・服などの見た目の細かい説明は書かなくてよい（参考画像から取る）。参考画像のポーズや構図をそのまま写す指示にしない。`;

export function buildPlanSystem(o: { titleMode: TitleMode; hasRules: boolean; hasRefs: boolean }): string {
  let sys = o.titleMode === 'title' ? PLAN_SYSTEM_TITLE : PLAN_SYSTEM;
  if (o.hasRules) sys += RULES_PRIORITY_SYSTEM;
  if (o.hasRefs) sys += REFS_SYSTEM;
  return sys;
}

export interface PlanInput {
  title: string;
  metaDescription: string;
  headings: string[];
  excerpt: string;
  /** ナレッジ（立場・避けること・画風の指定）。無ければ null */
  knowledge: string | null;
  /** この顧客の画像ルール（サムネ用）。無ければ省く */
  rules?: string | null;
  /** 参考画像の名前（キャラクター名など）。無ければ省く */
  refNames?: string[];
  /** true = refNames は「この画像に登場させるキャラクター」（参考画像のランダム選択で選んだ組） */
  cast?: boolean;
}

/** ランダム選択のとき、指示文づくりに足す1行（名前は顧客が登録した文字列そのまま） */
export function castLine(names: string[]): string {
  return `【この画像に登場させるキャラクター（この${names.length === 1 ? '1人' : `${names.length}人`}だけを描く）】${names.join('、')}`;
}

export function buildPlanUser(i: PlanInput): string {
  return [
    `【記事タイトル】${i.title}`,
    i.metaDescription ? `【要約】${i.metaDescription}` : '',
    i.headings.length ? `【見出し】\n${i.headings.map((h) => `- ${h}`).join('\n')}` : '',
    `【書き出し】${i.excerpt}`,
    i.knowledge ? `【ナレッジ（この人の立場・避けること・画風の指定）】\n${i.knowledge.slice(0, 3000)}` : '',
    i.rules ? `【この顧客の画像ルール（最優先）】\n${i.rules}` : '',
    i.refNames?.length ? `【参考画像のキャラクター】${i.refNames.join('、')}` : '',
    i.cast && i.refNames?.length ? castLine(i.refNames) : '',
  ].filter(Boolean).join('\n\n');
}

export async function planThumbnail(llm: Llm, input: PlanInput, mode: { titleMode?: TitleMode } = {}) {
  return llm.structured({
    tier: 'heavy',
    label: 'サムネの指示文',
    schema: ThumbPlan,
    maxTokens: 1500,
    system: buildPlanSystem({
      titleMode: mode.titleMode ?? 'none', hasRules: Boolean(input.rules), hasRefs: Boolean(input.refNames?.length),
    }),
    user: buildPlanUser(input),
  });
}

/**
 * 画像モデルに渡す最終の指示を組み立てる（純関数）。
 * ★題名はここでコードが入れる（LLM の指示文には書かせていない）。
 * ★題名なし・参考画像なし・指摘なしなら、指示文づくりの結果そのもの（今までと同じ）
 */
export function composeThumbPrompt(o: {
  planPrompt: string; titleMode: TitleMode; title: string; hasRefs: boolean; feedback?: string[];
  /** ランダム選択のとき、渡す参考画像の名前（並びは画像の順）。どの画像が誰かを指示に書く */
  refNames?: string[];
}): string {
  const parts = [o.planPrompt];
  if (o.titleMode === 'title' && o.title.trim()) parts.push(titleClause(o.title));
  if (o.hasRefs) parts.push(REFERENCE_CLAUSE);
  if (o.hasRefs && o.refNames?.length) parts.push(refNamesClause(o.refNames));
  if (o.feedback?.length) {
    parts.push(`前回の画像の問題点（必ず直す）: ${o.feedback.slice(0, 5).map((f) => f.replace(/\s+/g, ' ').slice(0, 120)).join(' / ')}`);
  }
  return parts.join('\n\n');
}

// ── 検品（生成した画像を LLM の画像入力で見る）─────────────────
const InspectResult = z.object({
  pass: z.boolean(),
  titleExact: z.boolean().nullable().optional(),
  issues: z.array(z.string().max(300)).max(10).default([]),
});

export const INSPECT_SYSTEM = `あなたは note 記事のサムネイル画像の検品係です。渡された画像1枚を見て、公開してよいかを判定します。

【確認すること】
1. 文字: 指定された文字の扱いを守っているか（題名が指定されていれば、一字一句同じか。抜け・誤字・余計な文字がないか）
2. 余計な文字: 題名以外の文字・文字のような模様（看板・服・肩・背景の読めない文字風の模様を含む）
3. 実在のブランドのロゴ・商標に見える模様（靴・服・道具など）
4. 体・手・顔・道具の崩れ（指の数、ねじれ、溶けたような形、道具の形が壊れている）
5. 顧客の画像ルールに書かれた禁止事項に当たるもの

問題が1つでもあれば pass=false。issues には、次に描き直すときに直すべき点を日本語で短く（1件40字程度、最大5件）。
問題がなければ pass=true、issues は空。
JSON: {"pass": true, "titleExact": true, "issues": []}`;

export function buildInspectUser(o: { titleMode: TitleMode; title: string; rules: string | null }): string {
  return [
    o.titleMode === 'title'
      ? `【題名（この文字列が一字一句そのまま入っていること。titleExact に一致したかを入れる）】「${o.title.replace(/[\r\n]+/g, ' ').trim()}」`
      : '【文字】画像に文字は入っていないこと（短い英単語2語までは可）。titleExact は null',
    o.rules ? `【この顧客の画像ルール（禁止事項の確認に使う）】\n${o.rules}` : '',
  ].filter(Boolean).join('\n\n');
}

export type InspectVerdict =
  | { verdict: 'pass'; issues: string[] }
  | { verdict: 'fail'; issues: string[] }
  | { verdict: 'unchecked'; reason: string; issues: string[] };

/**
 * 1枚を検品する。例外は投げない。
 * ★検品できない（画像入力が無い提供元・通信の失敗・出力の形が不正）ときは「未検品」。画像は採用する側に倒す
 */
export async function inspectThumbnail(
  llm: Llm, img: Pick<GeneratedImage, 'bytes' | 'contentType'>, o: { titleMode: TitleMode; title: string; rules: string | null },
): Promise<InspectVerdict> {
  if (typeof llm.vision !== 'function') return { verdict: 'unchecked', reason: 'unsupported', issues: [] };
  try {
    const { data } = await llm.vision({
      tier: 'light',
      label: 'サムネの検品',
      schema: InspectResult,
      maxTokens: 800,
      system: INSPECT_SYSTEM,
      user: buildInspectUser(o),
      images: [{ bytes: img.bytes, mime: img.contentType }],
    });
    const issues = data.issues.map((x) => x.trim()).filter(Boolean).slice(0, 5);
    const titleOk = o.titleMode !== 'title' || data.titleExact === true;
    if (data.pass && titleOk) return { verdict: 'pass', issues: [] };
    if (!titleOk && !issues.some((x) => x.includes('題名'))) issues.unshift('題名の文字が指定と一字一句一致していない');
    return { verdict: 'fail', issues: issues.length ? issues : ['公開に向かない点がある'] };
  } catch (e) {
    const reason = e instanceof LlmError ? (e.kind ?? 'llm') : 'unknown';
    // ★画像・ルール本文はログに出さない（理由の種類だけ）
    log.warn('サムネの検品ができなかったため、未検品として採用します', reason);
    return { verdict: 'unchecked', reason, issues: [] };
  }
}

// ── 記録（監査ログで数える）─────────────────────────────────
/** 描く直前に記録する（成功・失敗にかかわらず数える）。上限の判定はこれで行う */
export const AUDIT_RESERVED = 'thumbnail.reserved';
/** 保存まで済んだ記録（記録用。判定には使わない） */
const AUDIT_ACTION = 'thumbnail.generated';
/** 1回の実行（初回・作り直し）の始まり。1記事の上限はこれで数える（2026-10-26） */
export const AUDIT_RUN = 'thumbnail.run';
/** 検品の結果（結果の種類だけ。画像・本文・指摘の文は入れない） */
export const AUDIT_INSPECTED = 'thumbnail.inspected';

function jstDayStartIso(): string {
  return new Date(`${jstDate()}T00:00:00+09:00`).toISOString();
}

/**
 * ★予約（reserved）と、この変更より前の記録（generated）の多いほうを数える。
 *   この変更以降は1枚ごとに両方が残るので「多いほう」＝予約の数。変更前の記録しかない日・記事でも
 *   数え漏れない（デプロイした日に上限が緩まない）。
 */
async function countMax(db: Db, where: string, binds: unknown[]): Promise<number> {
  const count = async (action: string) => (await db.raw
    .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND ${where}`)
    .bind(action, ...binds)
    .first<{ c: number }>())?.c ?? 0;
  return Math.max(await count(AUDIT_RESERVED), await count(AUDIT_ACTION));
}

export async function countGeneratedToday(db: Db, tenantId: string): Promise<number> {
  return countMax(db, 'tenant_id = ? AND created_at >= ?', [tenantId, jstDayStartIso()]);
}

/**
 * この記事のサムネの「実行（run）」の数（★2026-10-26 から上限はこれで判定する）。
 *   = 実行の記録（thumbnail.run）＋ この変更より前の記録（run を持たない reserved / generated の多いほう）。
 *   変更前は1回の実行ごとに reserved（と generated）が1件ずつだったので、それを1実行として数える
 *   （デプロイした日に、すでに上限に達していた記事の上限が緩まない）。
 */
export async function countRunsForArticle(db: Db, articleId: string): Promise<number> {
  const count = async (action: string, legacyOnly: boolean) => (await db.raw
    .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND target = ?${
      legacyOnly ? ` AND (detail_json IS NULL OR detail_json NOT LIKE '%"run":%')` : ''}`)
    .bind(action, articleId)
    .first<{ c: number }>())?.c ?? 0;
  const runs = await count(AUDIT_RUN, false);
  const legacy = Math.max(await count(AUDIT_RESERVED, true), await count(AUDIT_ACTION, true));
  return runs + legacy;
}

/**
 * この記事のサムネの生成の合計（予約の数。★変更前の記録しかない記事も数え漏らさないよう、
 * 予約と生成の記録の多いほう＝従来の countMax と同じ数え方）。MAX_GENERATIONS_PER_ARTICLE の判定に使う
 */
export async function countGenerationsForArticle(db: Db, articleId: string): Promise<number> {
  return countMax(db, 'target = ?', [articleId]);
}

/** 互換のための別名（呼び出し側の名前を変えない）。中身は実行の数 */
export const countGeneratedForArticle = countRunsForArticle;

// ── 本体 ──────────────────────────────────────────────────
export type ThumbnailOutcome =
  | { status: 'created'; altText: string }
  | { status: 'skipped'; reason: 'no_key' | 'disabled' | 'user_thumbnail' | 'article_limit' | 'daily_limit'; note: string }
  | { status: 'failed'; kind: string; note: string }
  /** 検品で上限まで不合格（画像は保存していない。記事はサムネなしで進める） */
  | { status: 'rejected'; attempts: number; note: string };

export interface ThumbnailDeps {
  db: Db;
  images: ImageStore;
  /** 指示文づくりに使う LLM の設定 */
  llm: LlmConfig;
  /** 未設定なら生成しない */
  openaiKey?: string | null;
  /** 画像を作る口（テスト用の差し替え）。省略時は OpenAI（gpt-image-2） */
  generator?: ImageGenerator;
  /** いまの時刻（ミリ秒）。テストで経過時間を進めるためのもの */
  now?: () => number;
  /** 参考画像のランダム選択に使う乱数（0 以上 1 未満）。テストで固定するためのもの */
  random?: () => number;
}

export const NOTE_NO_KEY =
  'サムネの自動生成は未設定です（OpenAI の API キーを登録すると、サムネを自動で作ります）。ご自身の写真を送ってサムネにすることもできます。';

/**
 * サムネを1枚作って、記事のサムネに指定する。例外は投げない。
 * @param force 作り直し（利用者が押した）。自動生成のオフ設定は無視するが、回数の上限は守る
 */
export const NOTE_ARTICLE_LIMIT =
  `この記事のサムネは、作成${MAX_PER_ARTICLE}回・画像${MAX_GENERATIONS_PER_ARTICLE}枚までの上限に達しました。これ以上は費用が増えるため止めています。ご自身の写真を送ってサムネにしてください。`;
export const NOTE_TOO_SLOW = 'サムネの準備に時間がかかりすぎたため、今回は作りませんでした（記事はそのまま使えます）。少し待って「サムネを作り直す」を押してください。';

export async function ensureThumbnail(
  deps: ThumbnailDeps, articleId: string, opts: { force?: boolean } = {},
): Promise<ThumbnailOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  try {
    if (!deps.openaiKey) return { status: 'skipped', reason: 'no_key', note: NOTE_NO_KEY };

    const settings = await getThumbSettings(db);
    if (!settings.auto && !opts.force) {
      return { status: 'skipped', reason: 'disabled', note: 'サムネの自動生成はオフです。' };
    }

    const article = await db.getArticle(articleId);
    if (!article || !article.body_md) return { status: 'failed', kind: 'no_article', note: '記事が見つかりませんでした。' };

    // 利用者が自分の写真をサムネにしているなら、触らない
    const existing = await db.getEyecatch(articleId);
    if (existing) {
      const src = await db.raw.prepare('SELECT source FROM images WHERE id = ?').bind(existing.id).first<{ source: string }>();
      if ((src?.source ?? 'user') !== 'generated') {
        return { status: 'skipped', reason: 'user_thumbnail', note: 'ご自身の写真がサムネに設定されています。' };
      }
      // ★自動の呼び出しでは、すでにあるものを作り直さない（記事の修正や、処理のやり直しで二重に課金されないため）
      if (!opts.force) return { status: 'created', altText: existing.alt_text ?? '' };
    }

    if ((await countGeneratedForArticle(db, articleId)) >= MAX_PER_ARTICLE
      || (await countGenerationsForArticle(db, articleId)) >= MAX_GENERATIONS_PER_ARTICLE) {
      return { status: 'skipped', reason: 'article_limit', note: NOTE_ARTICLE_LIMIT };
    }
    if ((await countGeneratedToday(db, article.tenant_id)) >= settings.dailyLimit) {
      return { status: 'skipped', reason: 'daily_limit',
        note: `きょうのサムネ自動生成の上限（${settings.dailyLimit}枚）に達しました。あすになるとまた作れます。` };
    }

    // 0. 画像のルール・参考画像（★登録が無ければ null / 空。今までと同じ作り方になる）
    const rules = await getImageRules(db, article.tenant_id, 'thumbnail');
    let refs = await loadReferenceImages(db, deps.images, article.tenant_id);
    // ★ランダム選択: この実行で使う組を1回だけ選ぶ。検品のやり直しでも同じ組を使い続ける（登場キャラが変わって検品がぶれないように）
    const refRandom = refs.length > 0 && await getRefRandom(db);
    if (refRandom) refs = selectRefs(refs, deps.random ?? Math.random);
    const titleMode: TitleMode = rules?.titleMode ?? 'none';
    const inspectOn = Boolean(rules) && (rules!.inspectRetries > 0 || titleMode === 'title');
    const maxAttempts = 1 + (inspectOn ? rules!.inspectRetries : 0);
    const title = article.title ?? '';

    // 1. 指示文
    const context = await db.getActiveContext(article.tenant_id);
    const llm = createLlm(deps.llm);
    // 写真・AI 文中画像の目印は指示文に要らない
    const body = article.body_md.replace(/\[(?:AI)?画像\d+\]/g, '');
    const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 10);
    const excerpt = body.replace(/^#{2,3}\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const plan = await planThumbnail(llm, {
      title,
      metaDescription: article.meta_description ?? '',
      headings, excerpt,
      knowledge: context ? (context.prompt_snippet ?? context.raw_text) : null,
      rules: rules?.body || null,
      refNames: refs.length ? refs.map((r) => r.name) : undefined,
      cast: refRandom,
    }, { titleMode });

    // 指示文づくりだけで時間を使い切った（文章の通信が遅い）なら、描かずに終える（課金も実行の記録もしない）
    if (now() - startedAt > THUMB_RUN_BUDGET_MS) {
      return { status: 'failed', kind: 'timeout', note: NOTE_TOO_SLOW };
    }

    // 2. 描く（課金はここ）。★1枚ごとに直前に予約として数える。この後に失敗しても取り消さない
    const generator = deps.generator ?? new OpenAiImageClient(deps.openaiKey);
    const runId = newId();
    await db.audit(article.tenant_id, AUDIT_RUN, 'system', articleId, 'ok', { run: runId });
    let feedback: string[] = [];
    let adopted: { img: GeneratedImage; prompt: string; attempt: number; inspected: 'off' | 'pass' | 'unchecked' } | null = null;
    let lastIssues: string[] = [];
    let attempts = 0;
    let stopped: 'daily' | 'article' | 'time' | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // ★やり直しの1枚も1日の上限・1記事の合計に数える（初回は上で確認済み）
        if ((await countGeneratedToday(db, article.tenant_id)) >= settings.dailyLimit) { stopped = 'daily'; break; }
        if ((await countGenerationsForArticle(db, articleId)) >= MAX_GENERATIONS_PER_ARTICLE) { stopped = 'article'; break; }
        // ★時間がかかりすぎたら次の1枚は作らない（step の時間切れで、記事ごと止まらないように）
        if (now() - startedAt > THUMB_RUN_BUDGET_MS) { stopped = 'time'; break; }
      }
      const prompt = composeThumbPrompt({
        planPrompt: plan.data.prompt, titleMode, title, hasRefs: refs.length > 0, feedback,
        refNames: refRandom ? refs.map((r) => r.name) : undefined,
      });
      await db.audit(article.tenant_id, AUDIT_RESERVED, 'system', articleId, 'ok', { run: runId, attempt });
      attempts++;
      const img = refs.length ? await generator.edit(prompt, refs) : await generator.generate(prompt);
      if (!inspectOn) { adopted = { img, prompt, attempt, inspected: 'off' }; break; }

      const v = await inspectThumbnail(llm, img, { titleMode, title, rules: rules?.body || null });
      await db.audit(article.tenant_id, AUDIT_INSPECTED, 'system', articleId, 'ok', {
        run: runId, attempt, result: v.verdict, reason: v.verdict === 'unchecked' ? v.reason : null, issues: v.issues.length,
      });
      if (v.verdict !== 'fail') { adopted = { img, prompt, attempt, inspected: v.verdict }; break; }
      lastIssues = v.issues;
      feedback = v.issues;
    }

    if (!adopted) {
      // ★上限まで不合格: 画像は保存しない（前のサムネもそのまま）。記事はサムネなしで進める
      const shown = lastIssues.slice(0, 2).map((x) => x.slice(0, 40)).join('／');
      return {
        status: 'rejected', attempts,
        note: `サムネを${attempts}枚作りましたが、確認で気になる点が残ったため、今回はサムネなしで進めます（記事はそのまま使えます）。` +
          (shown ? `\n気になった点: ${shown}` : '') +
          (stopped === 'daily' ? `\n（きょうのサムネの上限（${settings.dailyLimit}枚）に達したため、作り直しを止めました）` : '') +
          (stopped === 'article' ? `\n（この記事で作れるサムネの合計（${MAX_GENERATIONS_PER_ARTICLE}枚）に達したため、作り直しを止めました）` : '') +
          (stopped === 'time' ? '\n（時間がかかりすぎたため、作り直しを止めました）' : '') +
          '\n「サムネを作り直す」を押すか、ご自身の写真を送ってサムネにしてください。',
      };
    }
    const img = adopted.img;

    // 3. 置いて、登録して、サムネに指定する
    // ★置き場の名前は回数ではなく一意のIDで作る。回数で作ると、変更前の記録と数え方が変わった日に
    //   前のサムネと同じ名前になり、直後の「前のサムネを消す」で今作った画像まで消えてしまう
    const n = newId();
    const key = `gen_${articleId}_${n}`;
    await deps.images.put(key, img.bytes, img.contentType);

    // 前の自動生成サムネは外す（本文の画像に紛れ込ませない）。ユーザーの写真は上で除外済み
    if (existing) {
      await db.raw.prepare('DELETE FROM images WHERE id = ?').bind(existing.id).run();
      await deps.images.delete(existing.r2_key).catch(() => {});
    }
    const id = newId();
    await db.raw.prepare(
      `INSERT INTO images (id, tenant_id, article_id, r2_key, mime_type, size_bytes, line_message_id,
                           alt_text, is_eyecatch, source, gen_prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'generated', ?, ?)`)
      .bind(id, article.tenant_id, articleId, key, img.contentType, img.bytes.byteLength,
        `gen:${articleId}:${n}`, plan.data.altText, adopted.prompt, new Date().toISOString())
      .run();
    await db.audit(article.tenant_id, AUDIT_ACTION, 'system', articleId, 'ok', {
      size: img.size, bytes: img.bytes.byteLength, usage: img.usage,
      run: runId, attempt: adopted.attempt, inspected: adopted.inspected, refs: refs.length, refRandom,
    });
    return { status: 'created', altText: plan.data.altText };
  } catch (e) {
    if (e instanceof ImageGenError) {
      log.warn('サムネの生成に失敗', `${e.kind}: ${e.message}`);
      return { status: 'failed', kind: e.kind, note: e.userMessage };
    }
    if (e instanceof LlmError) {
      log.warn('サムネの指示文づくりに失敗', e.message);
      return { status: 'failed', kind: 'llm', note: `サムネの下ごしらえに失敗しました。${e.userMessage}` };
    }
    log.error('サムネの生成で想定外のエラー', String(e));
    return { status: 'failed', kind: 'unknown', note: 'サムネイルを作れませんでした。もう一度お試しください。' };
  }
}
