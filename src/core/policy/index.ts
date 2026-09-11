/**
 * 投稿ポリシーの単一入口。
 *
 * ★note への公開は、必ずここを通す。迂回路を作らないこと。
 *   LINE / REST / MCP のどの入口から来ても同じ判定を通る。
 *
 * 運用側の判断の4つの安全装置（2026-08-28）:
 *   1. 承認ゲート（承認した本人だけが公開できる）
 *   2. 投稿レート制限（日次上限・連投防止・全体流量）
 *   3. 緊急停止スイッチ（全テナント一括）
 *   4. 利用規約への同意
 */
import { jstDate, secondsBetween, nowIso } from '../../lib/time';
import type { ArticleState } from '../article/state';

export type BlockReason =
  | 'kill_switch'        // 全体停止中
  | 'tenant_suspended'   // テナント停止中
  | 'tenant_paused'      // テナント単位の投稿停止
  | 'tos_not_accepted'   // 規約未同意
  | 'not_approved'       // 未承認
  | 'wrong_approver'     // 承認者が違う
  | 'approval_expired'   // 承認の期限切れ
  | 'daily_limit'        // 日次上限
  | 'too_soon'           // 連投防止
  | 'global_throttle';   // 全体流量

export interface PolicyDecision {
  allowed: boolean;
  reason?: BlockReason;
  /** 顧客にそのまま見せる日本語 */
  userMessage?: string;
  /** 条件回復を待てば通るか（true なら blocked に退避して自動再開する） */
  retryable?: boolean;
  /** 次に試せる時刻（ISO8601） */
  retryAfter?: string;
}

const ALLOW: PolicyDecision = { allowed: true };

export interface PolicyContext {
  /** 全体の緊急停止フラグ（D1 の system_flags が真実、KV がキャッシュ） */
  killSwitchOn: boolean;
  tenant: {
    status: string;
    publishEnabled: boolean;
    tosAcceptedAt: string | null;
    dailyPostLimit: number;
    minIntervalSec: number;
  };
  article: {
    state: ArticleState;
    approvedAt: string | null;
    approvedBy: string | null;
  };
  /** line_channels.owner_line_user_id。承認できる唯一の userId */
  ownerLineUserId: string | null;
  /** 今日すでに投稿した本数（JST基準） */
  todayPublishCount: number;
  /** 直近の投稿時刻（ISO8601、無ければ null） */
  lastPublishedAt: string | null;
  /** 直近60秒の全テナント合計投稿数 */
  globalRecentCount: number;
  /** 全体の流量上限（60秒あたり）。0 で無制限 */
  globalLimitPerMinute?: number;
  /**
   * 公開済み記事の上書き更新か。
   * ★true のときは投稿本数のレート制限を課さない。
   *   note 上に新しい記事が増えるわけではないため、スパム判定の観点で数える必要がない。
   *   ただし承認ゲートと緊急停止は更新でも必ず通す。
   */
  isUpdate?: boolean;
  now?: string;
}

/** 承認の有効期限（24時間）。 */
export const APPROVAL_TTL_SEC = 24 * 60 * 60;
/**
 * 全テナント合計の流量上限（60秒あたり）。0 で無制限。
 * note のサーバーに負担をかけないための自制。
 */
export const DEFAULT_GLOBAL_LIMIT_PER_MINUTE = 3;

/**
 * 公開してよいかを判定する。
 * 判定順序は「安いものから」「影響が大きいものから」の順。
 */
export function canPublish(ctx: PolicyContext): PolicyDecision {
  const now = ctx.now ?? nowIso();

  // 1. 全体の緊急停止（note からクレームが来たときに10秒で全部止めるためのもの）
  if (ctx.killSwitchOn) {
    return {
      allowed: false, reason: 'kill_switch', retryable: true,
      userMessage: 'システムメンテナンスのため投稿を一時停止しています。再開後に自動で投稿します。',
    };
  }

  // 2. テナントの状態
  if (ctx.tenant.status !== 'active') {
    return {
      allowed: false, reason: 'tenant_suspended', retryable: false,
      userMessage: 'アカウントが停止されています。サポートまでご連絡ください。',
    };
  }
  if (!ctx.tenant.publishEnabled) {
    return {
      allowed: false, reason: 'tenant_paused', retryable: true,
      userMessage: '投稿が一時停止に設定されています。設定をご確認ください。',
    };
  }

  // 3. 規約同意（未同意のテナントは一切処理しない）
  if (!ctx.tenant.tosAcceptedAt) {
    return {
      allowed: false, reason: 'tos_not_accepted', retryable: false,
      userMessage: 'ご利用にあたって利用規約への同意が必要です。',
    };
  }

  // 4. ★承認ゲート（迂回不可）
  if (ctx.article.state !== 'awaiting_approval' && ctx.article.state !== 'blocked'
      && ctx.article.state !== 'awaiting_session') {
    return {
      allowed: false, reason: 'not_approved', retryable: false,
      userMessage: 'この記事はまだ公開できる状態ではありません。',
    };
  }
  if (!ctx.article.approvedAt) {
    return {
      allowed: false, reason: 'not_approved', retryable: false,
      userMessage: '公開の承認がされていません。',
    };
  }
  if (ctx.ownerLineUserId && ctx.article.approvedBy !== ctx.ownerLineUserId) {
    return {
      allowed: false, reason: 'wrong_approver', retryable: false,
      userMessage: 'この記事を公開できるのはアカウントの持ち主だけです。',
    };
  }
  if (secondsBetween(ctx.article.approvedAt, now) > APPROVAL_TTL_SEC) {
    return {
      allowed: false, reason: 'approval_expired', retryable: false,
      userMessage: '承認から24時間が経過しました。もう一度ご確認をお願いします。',
    };
  }

  // ここから先は「note に新しい記事が増える」場合だけの制限。
  // 既存記事の上書き更新には課さない。
  if (ctx.isUpdate) return ALLOW;

  // 5. 日次上限（0 以下で無制限）
  //
  // ★これは API 費用の制限ではなく、note アカウントを守るためのもの。
  //   note のクリエイター規約10.1は「スパムと当社が判断した場合」に
  //   予告なくアカウントを停止できると定めており、短時間の連投が
  //   その判定を最も引きやすい。
  //   テナント設定で外せるようにしてあるが、第三者に販売する際は
  //   源蔵レビューの条件（レート自制の明文化）として戻すこと。
  if (ctx.tenant.dailyPostLimit > 0 && ctx.todayPublishCount >= ctx.tenant.dailyPostLimit) {
    return {
      allowed: false, reason: 'daily_limit', retryable: true,
      retryAfter: nextJstMorning(now),
      userMessage: `本日の投稿上限（${ctx.tenant.dailyPostLimit}本）に達しました。明朝9時に自動で投稿します。`,
    };
  }

  // 6. 連投防止（0 以下で無制限）
  if (ctx.tenant.minIntervalSec > 0 && ctx.lastPublishedAt) {
    const elapsed = secondsBetween(ctx.lastPublishedAt, now);
    if (elapsed < ctx.tenant.minIntervalSec) {
      const waitMin = Math.ceil((ctx.tenant.minIntervalSec - elapsed) / 60);
      return {
        allowed: false, reason: 'too_soon', retryable: true,
        retryAfter: new Date(new Date(ctx.lastPublishedAt).getTime() + ctx.tenant.minIntervalSec * 1000).toISOString(),
        userMessage: `前回の投稿から間隔をあけています。約${waitMin}分後に自動で投稿します。`,
      };
    }
  }

  // 7. 全体流量（note のサーバーに負担をかけないための自制。0 で無制限）
  const globalLimit = ctx.globalLimitPerMinute ?? DEFAULT_GLOBAL_LIMIT_PER_MINUTE;
  if (globalLimit > 0 && ctx.globalRecentCount >= globalLimit) {
    return {
      allowed: false, reason: 'global_throttle', retryable: true,
      userMessage: '順番待ちです。まもなく自動で投稿します。',
    };
  }

  return ALLOW;
}

/** 翌朝9時（JST）の ISO8601。日次上限に達したときの再開時刻。 */
export function nextJstMorning(fromIso: string): string {
  const from = new Date(fromIso);
  const jstNow = new Date(from.getTime() + 9 * 60 * 60 * 1000);
  const next = new Date(Date.UTC(
    jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + 1, 9, 0, 0,
  ));
  // JST 9時 = UTC 0時
  return new Date(next.getTime() - 9 * 60 * 60 * 1000).toISOString();
}

/** 今日（JST）の日付キー。publish_log のカウントに使う。 */
export function todayKey(now = nowIso()): string {
  return jstDate(new Date(now));
}
