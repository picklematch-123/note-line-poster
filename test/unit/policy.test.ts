import { describe, it, expect } from 'vitest';
import { canPublish, nextJstMorning, APPROVAL_TTL_SEC, type PolicyContext } from '../../src/core/policy';

const NOW = '2026-08-28T05:00:00.000Z'; // JST 14:00

/** 「全部OK」の状態を作り、テストごとに一箇所だけ壊す。 */
function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    killSwitchOn: false,
    tenant: {
      status: 'active',
      publishEnabled: true,
      tosAcceptedAt: '2026-08-01T00:00:00.000Z',
      dailyPostLimit: 3,
      minIntervalSec: 1800,
    },
    article: {
      state: 'awaiting_approval',
      approvedAt: '2026-08-28T04:55:00.000Z',
      approvedBy: 'U_owner',
    },
    ownerLineUserId: 'U_owner',
    todayPublishCount: 0,
    lastPublishedAt: null,
    globalRecentCount: 0,
    now: NOW,
    ...overrides,
  };
}

describe('canPublish — 正常系', () => {
  it('すべて満たしていれば許可する', () => {
    expect(canPublish(ctx())).toEqual({ allowed: true });
  });

  it('blocked からの再開も許可する（条件が回復した場合）', () => {
    expect(canPublish(ctx({ article: { ...ctx().article, state: 'blocked' } })).allowed).toBe(true);
  });

  it('awaiting_session からの再開も許可する', () => {
    expect(canPublish(ctx({ article: { ...ctx().article, state: 'awaiting_session' } })).allowed).toBe(true);
  });
});

describe('canPublish — ★承認ゲート（迂回不可）', () => {
  it('未承認なら拒否する', () => {
    const d = canPublish(ctx({ article: { state: 'awaiting_approval', approvedAt: null, approvedBy: null } }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('not_approved');
    expect(d.retryable).toBe(false);
  });

  it('★オーナー以外が承認しても拒否する', () => {
    const d = canPublish(ctx({ article: { ...ctx().article, approvedBy: 'U_someone_else' } }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('wrong_approver');
  });

  it('承認から24時間を過ぎたら拒否する', () => {
    const d = canPublish(ctx({
      article: { ...ctx().article, approvedAt: '2026-08-27T04:00:00.000Z' },
    }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('approval_expired');
  });

  it('24時間ちょうど手前なら許可する（境界値）', () => {
    const approvedAt = new Date(new Date(NOW).getTime() - (APPROVAL_TTL_SEC - 60) * 1000).toISOString();
    expect(canPublish(ctx({ article: { ...ctx().article, approvedAt } })).allowed).toBe(true);
  });

  it('生成中など、承認待ち以外の状態からは公開できない', () => {
    for (const state of ['received', 'generating', 'preview_ready', 'editing', 'published'] as const) {
      const d = canPublish(ctx({ article: { ...ctx().article, state } }));
      expect(d.allowed, `state=${state}`).toBe(false);
      expect(d.reason).toBe('not_approved');
    }
  });
});

describe('canPublish — ★緊急停止スイッチ', () => {
  it('全体停止中はすべて拒否する', () => {
    const d = canPublish(ctx({ killSwitchOn: true }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('kill_switch');
    // 顧客の作業を無駄にしないので、あとで自動再開する
    expect(d.retryable).toBe(true);
  });

  it('停止は他のどの条件よりも優先される', () => {
    const d = canPublish(ctx({ killSwitchOn: true, article: { state: 'awaiting_approval', approvedAt: null, approvedBy: null } }));
    expect(d.reason).toBe('kill_switch');
  });
});

describe('canPublish — レート制限', () => {
  it('日次上限に達したら拒否し、翌朝に再開予定を返す', () => {
    const d = canPublish(ctx({ todayPublishCount: 3 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('daily_limit');
    expect(d.retryable).toBe(true);
    expect(d.retryAfter).toBeTruthy();
    expect(d.userMessage).toContain('3本');
  });

  it('上限の1本手前なら許可する（境界値）', () => {
    expect(canPublish(ctx({ todayPublishCount: 2 })).allowed).toBe(true);
  });

  it('前回投稿から30分未満なら拒否する', () => {
    const d = canPublish(ctx({ lastPublishedAt: '2026-08-28T04:45:00.000Z' })); // 15分前
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('too_soon');
    expect(d.retryable).toBe(true);
    expect(d.userMessage).toContain('分後');
  });

  it('30分ちょうど経過していれば許可する（境界値）', () => {
    expect(canPublish(ctx({ lastPublishedAt: '2026-08-28T04:30:00.000Z' })).allowed).toBe(true);
  });

  it('全体流量を超えたら順番待ちにする', () => {
    const d = canPublish(ctx({ globalRecentCount: 3 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('global_throttle');
    expect(d.retryable).toBe(true);
  });
});

describe('canPublish — テナントと規約', () => {
  it('停止中のテナントは拒否（復帰不可）', () => {
    const d = canPublish(ctx({ tenant: { ...ctx().tenant, status: 'suspended' } }));
    expect(d.reason).toBe('tenant_suspended');
    expect(d.retryable).toBe(false);
  });

  it('テナント単位の投稿停止は復帰可能な拒否', () => {
    const d = canPublish(ctx({ tenant: { ...ctx().tenant, publishEnabled: false } }));
    expect(d.reason).toBe('tenant_paused');
    expect(d.retryable).toBe(true);
  });

  it('★規約未同意なら一切処理しない', () => {
    const d = canPublish(ctx({ tenant: { ...ctx().tenant, tosAcceptedAt: null } }));
    expect(d.reason).toBe('tos_not_accepted');
    expect(d.retryable).toBe(false);
  });
});

describe('nextJstMorning', () => {
  it('翌朝9時(JST) = 翌日0時(UTC) を返す', () => {
    expect(nextJstMorning('2026-08-28T05:00:00.000Z')).toBe('2026-08-29T00:00:00.000Z');
  });

  it('JST深夜でも正しく翌朝を指す', () => {
    // 2026-08-28T16:00Z = JST 8/29 01:00 → 翌朝は 8/30 09:00 JST
    expect(nextJstMorning('2026-08-28T16:00:00.000Z')).toBe('2026-08-30T00:00:00.000Z');
  });
});

describe('★レート制限の無効化（テスト・自己責任運用のため）', () => {
  // これらの制限は API 費用ではなく note アカウントを守るためのもの。
  // 設定で外せるが、第三者に販売する際は戻すこと（源蔵レビューの条件）。

  it('日次上限を 0 にすると何本でも投稿できる', () => {
    const d = canPublish(ctx({
      tenant: { ...ctx().tenant, dailyPostLimit: 0 },
      todayPublishCount: 999,
    }));
    expect(d.allowed).toBe(true);
  });

  it('最小間隔を 0 にすると連投できる', () => {
    const d = canPublish(ctx({
      tenant: { ...ctx().tenant, minIntervalSec: 0 },
      lastPublishedAt: NOW, // 直前に投稿していても通る
    }));
    expect(d.allowed).toBe(true);
  });

  it('全体流量を 0 にすると順番待ちしない', () => {
    const d = canPublish(ctx({ globalRecentCount: 999, globalLimitPerMinute: 0 }));
    expect(d.allowed).toBe(true);
  });

  it('全体流量は設定値で変えられる', () => {
    expect(canPublish(ctx({ globalRecentCount: 5, globalLimitPerMinute: 10 })).allowed).toBe(true);
    expect(canPublish(ctx({ globalRecentCount: 5, globalLimitPerMinute: 3 })).allowed).toBe(false);
  });

  it('★制限を外しても、承認ゲートと緊急停止は必ず効く', () => {
    const noLimits = {
      tenant: { ...ctx().tenant, dailyPostLimit: 0, minIntervalSec: 0 },
      globalLimitPerMinute: 0,
      todayPublishCount: 999,
      lastPublishedAt: NOW,
      globalRecentCount: 999,
    };

    // 未承認は通さない
    expect(canPublish(ctx({
      ...noLimits,
      article: { state: 'awaiting_approval', approvedAt: null, approvedBy: null },
    })).reason).toBe('not_approved');

    // 承認者が違えば通さない
    expect(canPublish(ctx({
      ...noLimits,
      article: { ...ctx().article, approvedBy: 'U_someone_else' },
    })).reason).toBe('wrong_approver');

    // 緊急停止は最優先で効く
    expect(canPublish(ctx({ ...noLimits, killSwitchOn: true })).reason).toBe('kill_switch');
  });
});
