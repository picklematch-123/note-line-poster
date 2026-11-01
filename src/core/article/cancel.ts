/**
 * 「やめる」の中身（記事を取りやめるか、修正を取りやめて元に戻すか）。
 *
 * ★2026-11 顧客環境の不具合: 公開済みの記事を「修正する」で開き、途中で「やめる」を押すと、
 *   記事ごと取りやめ（cancelled）になり、過去記事一覧から消えていた（note 上は公開されたまま）。
 *   一度 note に出た記事（公開済み・下書き保存済み）の修正をやめたときは、
 *   記事を取りやめにせず、修正を始める前の状態と中身に戻す。新しく作っている記事は従来どおり取りやめ。
 *
 * ★戻す中身（控え）は、修正を始めたとき（published / drafted → editing）の状態記録（article_events.detail_json）に持つ。
 *   テーブルを増やさない（配布済みの各環境にマイグレーションを流さずに済む）。
 *   控えが無い古い記事（この仕組みより前に修正を始めたもの）は、状態だけ戻す。
 */
import type { ArticleRow, Db } from '../../ports/storage/db';
import { REVERTIBLE_STATES, type ArticleState } from './state';

/** 修正を始めたときの記録に付ける印 */
export const REOPEN_REASON = 'reopen';

/** 控えに残す列（note に出ている版の中身。生成で書き換わるものすべて） */
const SNAPSHOT_KEYS = [
  'title', 'body_md', 'body_html', 'meta_description', 'hashtags_json', 'keywords_json',
  'outline_json', 'image_alts_json', 'research_json', 'revision_instruction',
] as const;

export type RevertSnapshot = Partial<Pick<ArticleRow, (typeof SNAPSHOT_KEYS)[number]>>;

/** 修正を始める前の中身を控えにする */
export function snapshotOf(a: ArticleRow): RevertSnapshot {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_KEYS) out[k] = a[k] ?? null;
  return out as RevertSnapshot;
}

/** 控えとして読める形か（壊れた記録・古い記録を中身の復元に使わない） */
function parseSnapshot(detailJson: string | null): RevertSnapshot | null {
  if (!detailJson) return null;
  try {
    const d = JSON.parse(detailJson) as { reason?: unknown; restore?: unknown };
    if (d.reason !== REOPEN_REASON || !d.restore || typeof d.restore !== 'object') return null;
    const src = d.restore as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of SNAPSHOT_KEYS) {
      if (!(k in src)) continue;
      const v = src[k];
      if (v === null || typeof v === 'string') out[k] = v;
    }
    // 本文が無い控えは使わない（空の記事に戻してしまうため）
    return typeof out.body_md === 'string' && out.body_md.length > 0 ? (out as RevertSnapshot) : null;
  } catch {
    return null;
  }
}

/**
 * 戻り先（published / drafted）。null なら note に出ていない記事＝取りやめにする。
 * ★記録（最後に note の状態を離れたとき）を優先し、無ければ列から推し量る。
 */
export function revertTargetOf(
  a: Pick<ArticleRow, 'state' | 'published_at' | 'note_key' | 'note_id'>,
  lastExit: { from_state: ArticleState } | null,
): 'published' | 'drafted' | null {
  if (!REVERTIBLE_STATES.includes(a.state)) return null;
  if (lastExit && (lastExit.from_state === 'published' || lastExit.from_state === 'drafted')) return lastExit.from_state;
  if (a.published_at && a.note_key) return 'published';
  if (a.note_key && a.note_id) return 'drafted';
  return null;
}

export type CancelOutcome =
  | { kind: 'cancelled' }
  | { kind: 'reverted'; to: 'published' | 'drafted'; contentRestored: boolean; agentInFlight?: boolean }
  | { kind: 'not_found' };

/**
 * 「やめる」を実行する。note に出ている記事の修正なら元に戻し、そうでなければ取りやめにする。
 * ★拡張に渡した仕事の引き上げ（withdrawJobs）は呼び出し側で先に行うこと。
 * ★走っている生成（Workflow）は、終わるときに状態を確かめて結果を捨てる（core/article/service.ts の generateArticle）。
 */
export async function revertOrCancel(
  deps: { db: Pick<Db, 'getArticle' | 'getLastExitFromNote' | 'updateArticle' | 'setState'> },
  articleId: string, actor: string,
): Promise<CancelOutcome> {
  const a = await deps.db.getArticle(articleId);
  if (!a) return { kind: 'not_found' };

  const lastExit = REVERTIBLE_STATES.includes(a.state) ? await deps.db.getLastExitFromNote(articleId) : null;
  const target = revertTargetOf(a, lastExit);
  if (!target) {
    await deps.db.setState(articleId, a.state, 'cancelled', actor);
    return { kind: 'cancelled' };
  }

  // ★控えが使えるのは、最後に note の状態を離れたのが「修正を始めた」ときだけ（それ以外は中身が変わっていない）
  const snapshot = lastExit && lastExit.to_state === 'editing' ? parseSnapshot(lastExit.detail_json) : null;
  await deps.db.updateArticle(articleId, {
    ...(snapshot ?? {}),
    // 修正中に付けた承認は捨てる（次に公開するときは改めて承認がいる）
    approved_at: null,
    approved_by: null,
  });
  await deps.db.setState(articleId, a.state, target, actor, { reason: 'revert', contentRestored: Boolean(snapshot) });
  // ★拡張（顧客のブラウザ）に渡した仕事は、すでに受け取られて note へ送られた後かもしれない。
  //   その場合の返事では「前のまま」と断言しない（2026-11 源蔵レビュー推奨）
  return { kind: 'reverted', to: target, contentRestored: Boolean(snapshot), agentInFlight: a.state === 'awaiting_agent' };
}

/** 「やめる」の返事 */
export function cancelReplyText(o: CancelOutcome): string {
  if (o.kind === 'reverted') {
    if (o.agentInFlight) {
      return '修正を取りやめました。\n\nパソコンの Chrome がすでに note への送信を始めていた場合は、書き直した内容が反映されていることがあります。' +
        'note 側の記事をご確認ください。';
    }
    return o.to === 'published'
      ? '修正を取りやめました。note の記事は前のまま公開されています。\n\nもう一度直したいときは、過去記事一覧から「修正する」を押してください。'
      : '修正を取りやめました。note の下書きは前のまま残っています（公開はされていません）。\n\nもう一度直したいときは、過去記事一覧から「修正する」を押してください。';
  }
  if (o.kind === 'not_found') return 'その記事が見つかりませんでした。';
  return 'この記事は取りやめました。';
}

/**
 * 「公開する」を押したが、まだ公開できない（書き直しの最中）ときの返事。null なら公開の手続きへ進めてよい。
 * ★古いプレビューの「公開する」を、書き直しの最中に押したときに出る。
 *   以前は policy の「まだ公開できる状態ではありません」だけで、何が起きているか分からなかった。
 */
export function notReadyToPublishMessage(state: ArticleState | undefined): string | null {
  switch (state) {
    case 'received':
    case 'generating':
    case 'preview_ready':
      return 'いま書き直しています。できあがったらプレビューをお送りするので、届いたプレビューから「公開する」を押してください。';
    case 'editing':
      return 'この記事はいま修正中です。直したいところを文章で送ってください。\n\n' +
        'できあがったプレビューから「公開する」を押せます。修正をやめる場合は「やめる」と送ってください。';
    default:
      return null;
  }
}
