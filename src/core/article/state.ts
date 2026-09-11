/**
 * 記事の状態機械（FSM）。
 * 遷移は必ずこの遷移表を通す。不正な遷移は例外にする。
 */

export const ARTICLE_STATES = [
  'received',          // ネタ受信・画像受付中（デバウンス待ち）
  'generating',        // 記事生成中
  'preview_ready',     // 生成完了・LINE未送信
  'awaiting_approval', // プレビュー送信済み・承認待ち
  'editing',           // 修正指示を反映中
  'blocked',           // ポリシーで待機中（条件回復で自動再開）
  'awaiting_session',  // note セッション失効で待機中
  'awaiting_agent',    // 顧客のブラウザ（拡張）が取りに来るのを待っている
  'saving_draft',      // note へ下書き保存中
  'drafted',           // note に下書きとして保存済み（未公開）
  'publishing',        // note へ投稿中
  'published',         // 完了
  'cancelled',         // ユーザーが取り消し
  'failed',            // 復帰不能な失敗
  'expired',           // 放置されて期限切れ
] as const;

export type ArticleState = (typeof ARTICLE_STATES)[number];

/** 許可された遷移だけを列挙する。ここに無い遷移は起こしてはいけない。 */
const TRANSITIONS: Record<ArticleState, readonly ArticleState[]> = {
  received: ['generating', 'cancelled', 'expired'],
  generating: ['preview_ready', 'failed', 'cancelled', 'expired'],
  preview_ready: ['awaiting_approval', 'failed', 'cancelled', 'expired'],
  awaiting_approval: ['editing', 'blocked', 'publishing', 'saving_draft', 'awaiting_agent', 'cancelled', 'expired'],
  editing: ['awaiting_approval', 'generating', 'saving_draft', 'cancelled', 'failed', 'expired'],
  blocked: ['publishing', 'awaiting_agent', 'cancelled', 'expired', 'awaiting_session'],
  awaiting_session: ['publishing', 'awaiting_agent', 'blocked', 'cancelled', 'expired'],
  // 拡張（顧客のブラウザ）が実行する。実行そのものは向こうで完結するので、
  // ★成功すればここから直接 published / drafted へ進む。
  //   ここに published を入れ忘れると、投稿は成功しているのに
  //   状態を更新できず例外になる（記事が宙に浮く）。
  awaiting_agent: ['published', 'drafted', 'publishing', 'saving_draft',
                   'awaiting_session', 'blocked', 'failed', 'cancelled', 'expired'],
  saving_draft: ['drafted', 'failed', 'awaiting_session', 'awaiting_agent', 'cancelled'],
  // 下書き保存後も、あとから公開したり書き直したりできる
  drafted: ['editing', 'publishing', 'awaiting_agent', 'cancelled', 'expired'],
  publishing: ['published', 'failed', 'awaiting_session', 'awaiting_agent', 'blocked'],
  // 公開済みでも修正して再公開できる（note は記事の上書き更新に対応している）
  published: ['editing'],
  cancelled: [],
  // 再試行するか、あきらめるか
  failed: ['generating', 'cancelled', 'expired'],
  expired: [],
};

/**
 * ★「やめる」はどの作業中状態からでもできなければならない。
 *   ここに穴があると、ボタンを押しても例外で落ちて無反応になり、
 *   記事が片付かずロックが解けなくなる（2026-08-28 の不具合）。
 */
export const MUST_ALLOW_CANCEL: readonly ArticleState[] = [
  'received', 'generating', 'preview_ready', 'awaiting_approval',
  'editing', 'blocked', 'awaiting_session', 'awaiting_agent', 'saving_draft', 'drafted', 'failed',
];

/** 終端状態（もう動かない）。published は修正のため再開できるので含めない。 */
export const TERMINAL_STATES: readonly ArticleState[] = ['cancelled', 'expired'];

export class InvalidTransitionError extends Error {
  constructor(readonly from: ArticleState, readonly to: ArticleState) {
    super(`不正な状態遷移です: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: ArticleState, to: ArticleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 遷移可能かを検証する。不可なら例外を投げる。 */
export function assertTransition(from: ArticleState, to: ArticleState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: ArticleState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** その状態から先へ進む見込みがあるか（Cron の再開対象の判定に使う）。 */
export function isResumable(state: ArticleState): boolean {
  return state === 'blocked' || state === 'awaiting_session' || state === 'awaiting_agent';
}

/**
 * まだ本人の判断を待っている状態か。
 *
 * ★この間は新しい記事を作らせない。
 *   記事を書いている途中に別の記事を書き始めることは実際にはまず無く、
 *   誤って新しい記事が生まれるほうが害が大きいため
 *   （2026-08-28 運用側の判断）。
 *   「公開する」「下書きに保存する」「やめる」のどれかで解放される。
 */
export function needsDecision(state: ArticleState): boolean {
  return (
    state === 'received' ||
    state === 'generating' ||
    state === 'preview_ready' ||
    state === 'awaiting_approval' ||
    state === 'editing' ||
    state === 'failed'
  );
}
