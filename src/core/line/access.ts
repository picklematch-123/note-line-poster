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
 */

export type Role = 'owner' | 'staff' | 'guest';

/**
 * その人の立場。
 * 持ち主が未登録なら、誰でも「持ち主」扱い（最初の1人が持ち主になる）。
 */
export function roleOf(
  ownerLineUserId: string | null | undefined,
  userId: string,
  staffLineUserIds: readonly string[] = [],
): Role {
  if (!ownerLineUserId) return 'owner';
  if (!userId) return 'guest';
  if (ownerLineUserId === userId) return 'owner';
  if (staffLineUserIds.includes(userId)) return 'staff';
  return 'guest';
}

/** 操作してよいか（持ち主か投稿者）。持ち主未登録なら誰でも可 */
export function canUse(
  ownerLineUserId: string | null | undefined,
  userId: string,
  staffLineUserIds: readonly string[] = [],
): boolean {
  return roleOf(ownerLineUserId, userId, staffLineUserIds) !== 'guest';
}

/** 持ち主だけの操作をしてよいか。持ち主未登録なら誰でも可 */
export function isOwner(ownerLineUserId: string | null | undefined, userId: string): boolean {
  return roleOf(ownerLineUserId, userId) === 'owner';
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
