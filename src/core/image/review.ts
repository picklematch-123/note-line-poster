/**
 * AI が作った文中画像を、公開前に人が見たか（2026-10-24 源蔵レビュー P3 必須3）。
 *
 * ★なぜ要るか: プレビュー（LINE）には画像そのものは出ない。「公開する」は画像を一度も見ないまま押せた。
 *   「公開前に人が見る」は、文字・人物・画風・記事に無い料理などを止める最後の砦の前提なので、仕組みで守る。
 *
 * 聞くのは一度だけ:
 *  - 本文に AI 画像が1枚でも入っている（画像ができている番号が本文にある）
 *  - その記事を一度も note に保存していない（下書き保存・公開のどちらもしていない＝note_id が無い）
 *  - まだ「このまま公開する」を押していない（ai_images_confirmed_at が NULL）
 */
import type { Db, ArticleRow } from '../../ports/storage/db';
import { listPlacedGeneratedImages } from '../article/links';
import { nowIso } from '../../lib/time';

/** 純関数版（判定を1か所にまとめる） */
export function shouldAskAiImageReview(
  a: Pick<ArticleRow, 'note_id' | 'ai_images_confirmed_at'>, placedAiImages: number,
): boolean {
  if (placedAiImages <= 0) return false;
  if (a.note_id) return false;               // 下書き保存（または公開）済み＝note の画面で見られた
  if (a.ai_images_confirmed_at) return false; // 「このまま公開する」を押した
  return true;
}

export async function needsAiImageReview(db: Db, a: ArticleRow | null): Promise<boolean> {
  if (!a?.body_md) return false;
  // 先に安い判定（D1 を余計に読まない）
  if (!shouldAskAiImageReview(a, 1)) return false;
  return shouldAskAiImageReview(a, (await listPlacedGeneratedImages(db, a)).length);
}

/** 「このまま公開する」を押した印 */
export async function markAiImagesConfirmed(db: Db, articleId: string): Promise<void> {
  await db.updateArticle(articleId, { ai_images_confirmed_at: nowIso() });
}
