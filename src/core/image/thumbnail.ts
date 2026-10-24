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
 */
import { z } from 'zod';
import type { Db } from '../../ports/storage/db';
import type { ImageStore } from '../../ports/storage/images';
import { LlmError, type Llm } from '../../ports/llm/types';
import { createLlm, type LlmConfig } from '../../ports/llm';
import { ImageGenError, OpenAiImageClient } from '../../ports/image/openai';
import { jstDate } from '../../lib/time';
import { newId } from '../../lib/id';
import { log } from '../../lib/mask';

// ── 設定（顧客ごと＝環境ごとに system_flags へ保存）────────────
export const FLAG_AUTO = 'thumb_auto';
export const FLAG_DAILY_LIMIT = 'thumb_daily_limit';

/** 1記事に作れる回数（初回＋作り直し2回）。請求の暴走を防ぐ */
export const MAX_PER_ARTICLE = 3;
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

export interface PlanInput {
  title: string;
  metaDescription: string;
  headings: string[];
  excerpt: string;
  /** ナレッジ（立場・避けること・画風の指定）。無ければ null */
  knowledge: string | null;
}

export function buildPlanUser(i: PlanInput): string {
  return [
    `【記事タイトル】${i.title}`,
    i.metaDescription ? `【要約】${i.metaDescription}` : '',
    i.headings.length ? `【見出し】\n${i.headings.map((h) => `- ${h}`).join('\n')}` : '',
    `【書き出し】${i.excerpt}`,
    i.knowledge ? `【ナレッジ（この人の立場・避けること・画風の指定）】\n${i.knowledge.slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function planThumbnail(llm: Llm, input: PlanInput) {
  return llm.structured({
    tier: 'heavy',
    label: 'サムネの指示文',
    schema: ThumbPlan,
    maxTokens: 1500,
    system: PLAN_SYSTEM,
    user: buildPlanUser(input),
  });
}

// ── 記録（監査ログで数える）─────────────────────────────────
/** 描く直前に記録する（成功・失敗にかかわらず数える）。上限の判定はこれで行う */
export const AUDIT_RESERVED = 'thumbnail.reserved';
/** 保存まで済んだ記録（記録用。判定には使わない） */
const AUDIT_ACTION = 'thumbnail.generated';

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

export async function countGeneratedForArticle(db: Db, articleId: string): Promise<number> {
  return countMax(db, 'target = ?', [articleId]);
}

// ── 本体 ──────────────────────────────────────────────────
export type ThumbnailOutcome =
  | { status: 'created'; altText: string }
  | { status: 'skipped'; reason: 'no_key' | 'disabled' | 'user_thumbnail' | 'article_limit' | 'daily_limit'; note: string }
  | { status: 'failed'; kind: string; note: string };

export interface ThumbnailDeps {
  db: Db;
  images: ImageStore;
  /** 指示文づくりに使う LLM の設定 */
  llm: LlmConfig;
  /** 未設定なら生成しない */
  openaiKey?: string | null;
}

export const NOTE_NO_KEY =
  'サムネの自動生成は未設定です（OpenAI の API キーを登録すると、サムネを自動で作ります）。ご自身の写真を送ってサムネにすることもできます。';

/**
 * サムネを1枚作って、記事のサムネに指定する。例外は投げない。
 * @param force 作り直し（利用者が押した）。自動生成のオフ設定は無視するが、回数の上限は守る
 */
export async function ensureThumbnail(
  deps: ThumbnailDeps, articleId: string, opts: { force?: boolean } = {},
): Promise<ThumbnailOutcome> {
  const { db } = deps;
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

    if ((await countGeneratedForArticle(db, articleId)) >= MAX_PER_ARTICLE) {
      return { status: 'skipped', reason: 'article_limit',
        note: `この記事のサムネは${MAX_PER_ARTICLE}回まで作りました。これ以上は費用が増えるため止めています。ご自身の写真を送ってサムネにしてください。` };
    }
    if ((await countGeneratedToday(db, article.tenant_id)) >= settings.dailyLimit) {
      return { status: 'skipped', reason: 'daily_limit',
        note: `きょうのサムネ自動生成の上限（${settings.dailyLimit}枚）に達しました。あすになるとまた作れます。` };
    }

    // 1. 指示文
    const context = await db.getActiveContext(article.tenant_id);
    const llm = createLlm(deps.llm);
    // 写真・AI 文中画像の目印は指示文に要らない
    const body = article.body_md.replace(/\[(?:AI)?画像\d+\]/g, '');
    const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 10);
    const excerpt = body.replace(/^#{2,3}\s+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const plan = await planThumbnail(llm, {
      title: article.title ?? '',
      metaDescription: article.meta_description ?? '',
      headings, excerpt,
      knowledge: context ? (context.prompt_snippet ?? context.raw_text) : null,
    });

    // 2. 描く（課金はここ）。★直前に予約として数える。この後に失敗しても取り消さない
    const client = new OpenAiImageClient(deps.openaiKey);
    await db.audit(article.tenant_id, AUDIT_RESERVED, 'system', articleId, 'ok');
    const img = await client.generate(plan.data.prompt);

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
        `gen:${articleId}:${n}`, plan.data.altText, plan.data.prompt, new Date().toISOString())
      .run();
    await db.audit(article.tenant_id, AUDIT_ACTION, 'system', articleId, 'ok', {
      size: img.size, bytes: img.bytes.byteLength, usage: img.usage,
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
