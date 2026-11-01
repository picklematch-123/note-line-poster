/**
 * Workflow の step「記事を生成する」の受け止め（★2026-10-24 源蔵 再レビュー「後でよい」・一緒に直すと決めたもの）。
 *
 * 以前は step の中の例外だけを受け止めていた。step そのものが落ちる（10分の時間切れ・やり直しでも同じく固まる）と、
 * 例外が Workflow の外へ抜け、記事は「生成中」のまま止まり、LINE にも何も届かなかった。
 * ここで**どんな失敗でも**「失敗を通知する」経路（別の step で markFailed → LINE に日本語で知らせる）へつなぐ。
 * 「記事を調べる」の受け止め（runResearchSafely と Workflow 側の try/catch）と同じ考え方。
 *
 * ★cloudflare:workers に依存しない形にして、単体テストで実際に動かせるようにしてある。
 */
import type { Db } from '../ports/storage/db';
import type { LineClient } from '../adapters/line/client';
import { log } from '../lib/mask';
import { WITHDRAWN_STATES } from '../core/article/state';
import type { ThumbnailOutcome } from '../core/image/thumbnail';

export interface GenerationFailure {
  ok: false;
  userMessage: string;
}

/** step そのものが落ちたとき（時間切れ・一時的な障害）の文面 */
export const STEP_STOPPED_MESSAGE =
  '記事の生成が途中で止まりました（時間がかかりすぎたか、一時的な障害のためです）。書きかけの内容は残っています。';

/**
 * step を実行し、step そのものが落ちても例外を外へ出さずに「失敗」として返す。
 * step の中の失敗（生成の失敗）は、step の中で GenerationFailure にして返す作り（従来どおり）。
 */
export async function runGenerationStep<R extends { ok: boolean }>(
  run: () => Promise<R>,
): Promise<R | GenerationFailure> {
  try {
    return await run();
  } catch (e) {
    log.error('「記事を生成する」が止まったため、失敗として知らせます', String(e));
    return { ok: false, userMessage: STEP_STOPPED_MESSAGE };
  }
}

/** 失敗を記録し、LINE で知らせる（記事を「生成中」のまま残さない） */
export async function notifyGenerationFailure(
  deps: { db: Pick<Db, 'markFailed'> & Partial<Pick<Db, 'getArticle'>>; line: Pick<LineClient, 'push'> },
  articleId: string, lineUserId: string, userMessage: string,
): Promise<void> {
  // ★生成の最中に「やめる」が押されていた（取りやめ・note に出ている版へ戻した）なら、何もしない。
  //   ここで failed に落とすと、元に戻した公開済みの記事が「失敗」になり一覧から消える（2026-11）
  const current = await deps.db.getArticle?.(articleId);
  if (current && WITHDRAWN_STATES.includes(current.state)) return;
  await deps.db.markFailed(articleId, 'system', { reason: userMessage });
  await deps.line.push(lineUserId, [{
    type: 'text',
    text: `${userMessage}\n\n` +
      'もう一度やってみる場合は、指示をそのまま送ってください。\n' +
      '新しいネタにする場合は「やめる」と送ってください。',
  }]);
}

/** step「サムネイルを作る」そのものが落ちたときの文面（★記事は止めない） */
export const THUMB_STEP_STOPPED_NOTE =
  'サムネの作成が途中で止まりました（時間がかかりすぎたか、一時的な障害のためです）。記事はそのまま使えます。少し待って「サムネを作り直す」を押してください。';

/**
 * step「サムネイルを作る」を実行し、step そのものが落ちても（5分の時間切れ・想定外の例外）
 * 外へ出さずに「失敗」として返す（★2026-10-26 源蔵レビュー必須1。「記事を調べる」の受け止めと同じ考え方）。
 * これが無いと、サムネが固まっただけで例外が Workflow の外へ抜け、プレビューが届かず記事が止まる。
 */
export async function runThumbnailStep(run: () => Promise<ThumbnailOutcome>): Promise<ThumbnailOutcome> {
  try {
    return await run();
  } catch (e) {
    log.error('「サムネイルを作る」が止まったため、サムネなしで続けます', String(e));
    return { status: 'failed', kind: 'step', note: THUMB_STEP_STOPPED_NOTE };
  }
}
