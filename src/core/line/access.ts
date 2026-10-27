/**
 * この LINE アカウントを操作してよい人かを決める。
 *
 * ★なぜ要るか（2026-08-31 源蔵レビューの指摘）:
 *   公開・note連携・投稿設定には持ち主チェックがあったが、
 *   **記事の生成とナレッジの書き込みには無かった。**
 *   LINE公式アカウントを友だち追加した第三者が、
 *   ・顧客の Claude の残高を燃やす（記事生成は毎回 API を呼ぶ）
 *   ・ナレッジを汚染する（以後の記事すべてに 影響する）
 *   ができる状態だった。「公開できないから安全」は成り立たない。
 *
 * ★持ち主がまだ決まっていないときは通す。
 *   最初に話しかけた人を持ち主として登録する仕組みのため、
 *   ここで止めると誰も持ち主になれない。
 *
 * ★2026-09-13 投稿者（スタッフ）を追加できるようにした（運用側の判断）。
 *   投稿者にできるのは「記事を作る・直す・公開する」まで。
 *   note 連携・投稿設定の変更・持ち主の変更・投稿者の出し入れ・ナレッジの削除は
 *   持ち主だけに残す（アカウントそのものの安全に関わるため）。
 *
 * ★2026-10-27 V7: 管理者（admin）を足した。運用側（提供元）の担当者など、持ち主の代わりに設定を手伝う人。
 *   持ち主が自分で追加し（承認ボタン）、いつでも外せる。管理者にできるのは「持ち主の力」（hasOwnerPower）のうち、
 *   **持ち主のリセット**と**管理者の出し入れ**を除くすべて。この2つは isOwner（持ち主だけ）で守る
 *   ＝管理者は、管理者を増やせない・持ち主を外せない。
 */

export type Role = 'owner' | 'admin' | 'staff' | 'guest';

/**
 * その人の立場。
 * 持ち主が未登録なら、誰でも「持ち主」扱い（最初の1人が持ち主になる）。
 * @param memberLineUserIds line_members の全員（投稿者＋管理者）
 * @param adminLineUserIds そのうちの管理者（role='admin'）。★読めないときは空で渡す（権限を増やさない側）
 */
export function roleOf(
  ownerLineUserId: string | null | undefined,
  userId: string,
  memberLineUserIds: readonly string[] = [],
  adminLineUserIds: readonly string[] = [],
): Role {
  if (!ownerLineUserId) return 'owner';
  if (!userId) return 'guest';
  if (ownerLineUserId === userId) return 'owner';
  if (adminLineUserIds.includes(userId)) return 'admin';
  if (memberLineUserIds.includes(userId)) return 'staff';
  return 'guest';
}

/** 操作してよいか（持ち主・管理者・投稿者）。持ち主未登録なら誰でも可 */
export function canUse(
  ownerLineUserId: string | null | undefined,
  userId: string,
  memberLineUserIds: readonly string[] = [],
  adminLineUserIds: readonly string[] = [],
): boolean {
  return roleOf(ownerLineUserId, userId, memberLineUserIds, adminLineUserIds) !== 'guest';
}

/**
 * 持ち主だけの操作をしてよいか。持ち主未登録なら誰でも可。
 * ★管理者にも渡さない操作（持ち主のリセット・管理者の出し入れ）にだけ使う。ほかは hasOwnerPower
 */
export function isOwner(ownerLineUserId: string | null | undefined, userId: string): boolean {
  return roleOf(ownerLineUserId, userId) === 'owner';
}

/**
 * 持ち主の力（設定・連携・投稿者の出し入れ・他人の記事の操作など）を使ってよいか＝持ち主または管理者。
 * ★判定はここ1か所。管理者の一覧が読めないときは空で渡す（＝持ち主だけ）
 */
export function hasOwnerPower(
  ownerLineUserId: string | null | undefined,
  adminLineUserIds: readonly string[],
  userId: string,
): boolean {
  const role = roleOf(ownerLineUserId, userId, [], adminLineUserIds);
  return role === 'owner' || role === 'admin';
}

/**
 * 持ち主以外に返す文面。
 * ★何が動いているシステムなのかを説明しない（余計な興味を持たせない）。
 */
export const NOT_OWNER_MESSAGE =
  'このアカウントは持ち主専用です。ご用件がある場合は、直接ご連絡ください。';

/** 投稿者が持ち主だけの操作をしようとしたとき */
export const OWNER_ONLY_MESSAGE =
  'この操作はアカウントの持ち主だけが行えます。必要なときは、持ち主の方にお願いしてください。';
