/**
 * 記事一覧を、note の実態に合わせる。
 *
 * ★なぜ必要か:
 *   note の画面から記事を消しても、こちらの記録は「公開済み」のまま残る。
 *   その結果、一覧に**もう存在しない記事**が並び、開くと 404 になる。
 *
 * ★安全側の作り:
 *   note に問い合わせられなかったときは**何もしない**。
 *   「取得に失敗した」を「記事が無くなった」と取り違えると、
 *   生きている記事まで一覧から消してしまう。
 */
import type { Db } from '../../ports/storage/db';
import { fetchPublishedKeys } from '../../ports/publisher/note/public';
import { log } from '../../lib/mask';

export interface ReconcileResult {
  /** note 上に無いと分かって、一覧から外した件数 */
  removed: number;
  /** note に問い合わせできたか（false なら何も変えていない） */
  checked: boolean;
}

/**
 * 公開済みとして記録している記事のうち、note 上にもう無いものに印を付ける。
 *
 * 下書きは note の公開一覧に出てこないため、ここでは判定できない（触らない）。
 */
export async function reconcilePublished(
  db: Db, tenantId: string, urlname: string | null | undefined,
): Promise<ReconcileResult> {
  if (!urlname) return { removed: 0, checked: false };

  const rows = await db.listPublishedNoteKeys(tenantId);
  if (rows.length === 0) return { removed: 0, checked: false };

  // ★探しているキーを渡す。全部見つかれば途中で打ち切ってくれる（問い合わせ回数を減らす）
  const known = new Set(rows.map((r) => r.note_key).filter((k): k is string => !!k));
  const live = await fetchPublishedKeys(urlname, known);
  // ★取得できなかったとき（通信失敗・上限で打ち切り）は触らない。
  //   「読めなかった」を「消えた」と取り違えると、生きている記事を隠してしまう
  if (!live) return { removed: 0, checked: false };

  // ★note 側が1件も返さなかったときは判断しない。
  //   アカウントの引っ越しや一時的な不調で全消ししてしまう事故を防ぐ。
  if (live.size === 0) {
    log.warn('note の公開記事が0件だったため、突き合わせを見送りました', { tenantId });
    return { removed: 0, checked: false };
  }

  const gone = rows.filter((r) => r.note_key && !live.has(r.note_key)).map((r) => r.id);
  if (gone.length === 0) return { removed: 0, checked: true };

  await db.markRemovedFromNote(gone);
  log.info('note 上に無い記事を一覧から外しました', { tenantId, count: gone.length });
  return { removed: gone.length, checked: true };
}
