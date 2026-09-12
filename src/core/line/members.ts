/**
 * 投稿者（スタッフ）を迎え入れる窓口。
 *
 * ★やり方（2026-09-13 運用側の判断）:
 *   持ち主が「投稿者を追加」と送ると、10分間だけ窓口が開く。
 *   その間に**持ち主以外で最初に話しかけた1人**が投稿者になり、窓口は閉じる。
 *   ユーザーIDを手で転記させないため（持ち主の登録と同じ考え方）。
 *
 * ★窓口を開けっぱなしにしない理由:
 *   友だち追加しただけの第三者が、たまたま話しかけて投稿者になる事故を防ぐ。
 *   さらに、登録したら**持ち主に必ず名前つきで知らせる**。違う人なら外せる。
 *
 * ★話しかけただけでは投稿者にしない（2026-09-13 源蔵レビュー条件2）。
 *   窓口の間はリッチメニューを1回押しただけでも「話しかけた」になる。
 *   お客さまが友だちに入っていると、事故が現実に起きる。
 *   → 持ち主に「この人を投稿者にする／断る」を送り、**持ち主が押すまで使えない**。
 *   同時に2人が話しかけた場合も、表示名を自由に変えた人が紛れた場合も、ここで止まる。
 */
import { log } from '../../lib/mask';

/** 窓口が開いている時間 */
export const INVITE_TTL_SEC = 600;

/** 投稿者の上限（持ち主は数えない）。うっかり増えすぎないための歯止め */
export const MAX_STAFF = 5;

/**
 * 投稿者向けの使い方ページ。
 * ★空なら案内文にリンクを出さない（リンク切れを配らないため）。
 */
export const STAFF_MANUAL_URL = 'https://claude.ai/code/artifact/f39c3d14-435f-4c55-8804-37f0e06ca36b';

const inviteKey = (tenantId: string) => `member:invite:${tenantId}`;

export interface Invite {
  /** 窓口を開けた持ち主 */
  by: string;
  openedAt: string;
}

export async function openInvite(kv: KVNamespace, tenantId: string, by: string): Promise<void> {
  const invite: Invite = { by, openedAt: new Date().toISOString() };
  await kv.put(inviteKey(tenantId), JSON.stringify(invite), { expirationTtl: INVITE_TTL_SEC });
}

/**
 * 開いている窓口を返す。
 * ★読めないときは「開いていない」に倒す。間違えて誰かを投稿者にするより安全。
 */
export async function peekInvite(kv: KVNamespace, tenantId: string): Promise<Invite | null> {
  try {
    const raw = await kv.get(inviteKey(tenantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Invite>;
    return parsed.by ? { by: parsed.by, openedAt: parsed.openedAt ?? '' } : null;
  } catch (e) {
    log.warn('投稿者の受付状態を読めませんでした', String(e));
    return null;
  }
}

export async function closeInvite(kv: KVNamespace, tenantId: string): Promise<void> {
  await kv.delete(inviteKey(tenantId)).catch(() => {});
}

// ── 持ち主の確認待ち ─────────────────────────────────────

/** 持ち主が気づいて押すまでの猶予 */
export const PENDING_TTL_SEC = 24 * 60 * 60;

const pendingKey = (tenantId: string, userId: string) => `member:pending:${tenantId}:${userId}`;

export interface PendingMember {
  userId: string;
  displayName: string | null;
  /** 窓口を開けた持ち主 */
  invitedBy: string;
  requestedAt: string;
}

export async function savePending(kv: KVNamespace, tenantId: string, pending: PendingMember): Promise<void> {
  await kv.put(pendingKey(tenantId, pending.userId), JSON.stringify(pending), { expirationTtl: PENDING_TTL_SEC });
}

/**
 * 確認待ちを返す。
 * ★読めないときは「確認待ちは無い」に倒す。持ち主の「投稿者にする」は、ここに記録がある人にしか効かない。
 */
export async function getPending(kv: KVNamespace, tenantId: string, userId: string): Promise<PendingMember | null> {
  if (!userId) return null;
  try {
    const raw = await kv.get(pendingKey(tenantId, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingMember>;
    return parsed.userId === userId && parsed.invitedBy
      ? { userId, displayName: parsed.displayName ?? null, invitedBy: parsed.invitedBy, requestedAt: parsed.requestedAt ?? '' }
      : null;
  } catch (e) {
    log.warn('投稿者の確認待ちを読めませんでした', String(e));
    return null;
  }
}

export async function deletePending(kv: KVNamespace, tenantId: string, userId: string): Promise<void> {
  if (!userId) return;
  await kv.delete(pendingKey(tenantId, userId)).catch(() => {});
}

// ── 文面 ───────────────────────────────────────────────

/** 持ち主が窓口を開けたとき */
export function buildInviteOpened(): string {
  return '投稿者を追加する受付を始めました。\n\n' +
    '★これから10分以内に、追加したい人に\n' +
    '　このアカウントへ何か1通送ってもらってください。\n' +
    '　（「こんにちは」など、何でも大丈夫です）\n\n' +
    '最初に送ってきた1人について、あなたに確認のお知らせが届きます。\n' +
    '「投稿者にする」を押すと登録されます。\n' +
    '★受付は、その1人が送ってきた時点で閉じます。人違いで「断る」を押したときは、\n' +
    '　もう一度「投稿者を追加」と送ってください。\n\n' +
    '※ 投稿者にできるのは「記事を作る・直す・公開する」までです。\n' +
    '　note との連携や投稿の設定は、これまでどおりあなただけが変えられます。';
}

/** 投稿者になった人へ */
export function buildWelcomeStaff(manualUrl = STAFF_MANUAL_URL): string {
  return '投稿者として登録しました。\n' +
    'このアカウントで、記事を作って note に投稿できます。\n\n' +
    '画面の下のメニューから「記事作成」を押して始めてください。' +
    (manualUrl ? `\n\n▼ 使い方はこちら\n${manualUrl}` : '');
}

/** 持ち主へ（この人を投稿者にしてよいか） */
export function buildApprovalRequest(displayName: string | null): string {
  return `「${displayName ?? '名前を取得できなかった方'}」から、投稿者として登録してほしいと届きました。\n\n` +
    '★その人の LINE の名前が、追加したい方の名前と同じか確かめてから押してください。\n' +
    '　（名前は誰でも変えられます。心配なら本人に、いま送ったか聞いてください）\n\n' +
    '追加したかった人なら「投稿者にする」を押してください。\n' +
    '★心当たりが無ければ「断る」を押してください。押すまで、この人は何もできません。';
}

/** 確認を待っている本人へ。★システムの中身は書かない */
export function buildWaitingForApproval(): string {
  return '受け付けました。持ち主の方の確認が済むまで、少しお待ちください。';
}

/** 持ち主へ（登録した） */
export function buildStaffAddedNotice(displayName: string | null): string {
  return `「${displayName ?? '名前を取得できなかった方'}」を投稿者に登録しました。\n` +
    'ご本人に使い方のご案内を送りました。\n\n' +
    '外したくなったら、「投稿者一覧」と送ってください。';
}
