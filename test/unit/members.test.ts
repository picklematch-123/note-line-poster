/**
 * 投稿者（スタッフ）を足したときに、壊れてはいけないこと。
 *
 * ★守っているもの
 *   1. **持ち主だけの操作は、投稿者には開かない**（note連携・設定・持ち主の変更など）
 *   2. **2人で使っても入力が混ざらない**
 *      （A さんの「記事作成」の直後に B さんが送った文章が、A さんのネタにならない）
 *   3. **受付窓口は開けっぱなしにならない**（読めないときは閉じている扱い）
 *   4. **外された投稿者の承認は通らない**
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleOf, canUse, isOwner, OWNER_ONLY_MESSAGE } from '../../src/core/line/access';
import {
  openInvite, peekInvite, closeInvite, INVITE_TTL_SEC, MAX_STAFF,
  savePending, getPending, deletePending, listPending, decideTypedMemberCommand, PENDING_TTL_SEC,
  buildInviteOpened, buildWelcomeStaff, buildStaffAddedNotice,
  buildApprovalRequest, buildWaitingForApproval,
} from '../../src/core/line/members';
import { otherWorkInProgress } from '../../src/core/article/ownership';
import { setMode, getMode, clearMode, normalizeCommand } from '../../src/adapters/line/mode';
import { COMMANDS } from '../../src/adapters/line/commands';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { canPublish, type PolicyContext } from '../../src/core/policy';
import { approve, type ServiceDeps } from '../../src/core/article/service';

// ── 道具 ───────────────────────────────────────────────
function fakeKv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const puts: Array<{ key: string; ttl?: number }> = [];
  return {
    store, puts,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store[k] = v; puts.push({ key: k, ttl: o?.expirationTtl });
    },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, string>; puts: Array<{ key: string; ttl?: number }> };
}

const ROOT = new URL('../../', import.meta.url).pathname;

/** upTo を指定すると、その番号より前のマイグレーションだけを流す（適用前の状態を作るため） */
function migrate(upTo?: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    if (upTo && f >= upTo) continue;
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return db;
}

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) { params = p; return api; },
        async first<T>() { return (db.prepare(sql).get(...(params as [])) as T) ?? null; },
        async run() {
          const r = db.prepare(sql).run(...(params as []));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all<T>() { return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

// ── 1. 立場の判定 ───────────────────────────────────────
describe('立場の判定', () => {
  const STAFF = ['U_staff'];

  it('持ち主・投稿者・部外者を見分ける', () => {
    expect(roleOf('U_owner', 'U_owner', STAFF)).toBe('owner');
    expect(roleOf('U_owner', 'U_staff', STAFF)).toBe('staff');
    expect(roleOf('U_owner', 'U_guest', STAFF)).toBe('guest');
  });

  it('投稿者は使えるが、★持ち主だけの操作はできない', () => {
    expect(canUse('U_owner', 'U_staff', STAFF)).toBe(true);
    expect(isOwner('U_owner', 'U_staff')).toBe(false);
  });

  it('部外者は使えない', () => {
    expect(canUse('U_owner', 'U_guest', STAFF)).toBe(false);
  });

  it('★持ち主が未登録なら、誰でも持ち主扱い（最初の1人が持ち主になるため）', () => {
    expect(roleOf(null, 'U_first')).toBe('owner');
    expect(isOwner(null, 'U_first')).toBe(true);
  });

  it('★空の userId は、投稿者一覧に紛れていても通さない', () => {
    expect(roleOf('U_owner', '', ['', 'U_staff'])).toBe('guest');
  });

  it('投稿者一覧を渡さなければ、これまでどおり持ち主だけ', () => {
    expect(canUse('U_owner', 'U_staff')).toBe(false);
  });

  it('持ち主だけの操作を断る文面に、システムの中身を書かない', () => {
    for (const w of ['note', 'Claude', 'API', 'Cookie']) expect(OWNER_ONLY_MESSAGE).not.toContain(w);
  });
});

// ── 2. 受付窓口 ─────────────────────────────────────────
describe('投稿者の受付窓口', () => {
  it('開けると持ち主の userId を覚え、★10分で消えるように置く', async () => {
    const kv = fakeKv();
    await openInvite(kv, 't1', 'U_owner');
    expect((await peekInvite(kv, 't1'))?.by).toBe('U_owner');
    expect(kv.puts[0].ttl).toBe(INVITE_TTL_SEC);
    expect(INVITE_TTL_SEC).toBeLessThanOrEqual(600);
  });

  it('閉じたら開いていない', async () => {
    const kv = fakeKv();
    await openInvite(kv, 't1', 'U_owner');
    await closeInvite(kv, 't1');
    expect(await peekInvite(kv, 't1')).toBeNull();
  });

  it('★読めないとき・壊れた値のときは「開いていない」に倒す', async () => {
    const broken = { get: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    expect(await peekInvite(broken, 't1')).toBeNull();
    expect(await peekInvite(fakeKv({ 'member:invite:t1': '{壊れた' }), 't1')).toBeNull();
    expect(await peekInvite(fakeKv({ 'member:invite:t1': '{}' }), 't1')).toBeNull();
  });

  it('テナントが違えば窓口も別', async () => {
    const kv = fakeKv();
    await openInvite(kv, 't1', 'U_owner');
    expect(await peekInvite(kv, 't2')).toBeNull();
  });

  it('案内文: 10分・1人だけ・持ち主に知らせる、を伝える', () => {
    const t = buildInviteOpened();
    expect(t).toContain('10分');
    expect(t).toContain('1人');
    expect(t).toContain('お知らせ');
  });

  it('★使い方ページが未設定なら、リンクを出さない（リンク切れを配らない）', () => {
    expect(buildWelcomeStaff('')).not.toContain('http');
    expect(buildWelcomeStaff('https://example.com/manual')).toContain('https://example.com/manual');
  });

  it('持ち主への知らせに、外し方を必ず書く', () => {
    expect(buildStaffAddedNotice('山田')).toContain('山田');
    expect(buildStaffAddedNotice(null)).toContain('投稿者一覧');
  });
});

// ── 3. 入力待ちは人ごと ─────────────────────────────────
describe('入力待ちの状態は人ごとに分かれる', () => {
  it('★A さんの「記事作成」は、B さんには効かない', async () => {
    const kv = fakeKv();
    await setMode(kv, 't1', 'U_owner', { kind: 'article_new' });
    expect(await getMode(kv, 't1', 'U_staff')).toBeNull();
    expect((await getMode(kv, 't1', 'U_owner'))?.kind).toBe('article_new');
  });

  it('B さんが取り消しても、A さんの状態は残る', async () => {
    const kv = fakeKv();
    await setMode(kv, 't1', 'U_owner', { kind: 'ctx_append' });
    await setMode(kv, 't1', 'U_staff', { kind: 'article_new' });
    await clearMode(kv, 't1', 'U_staff');
    expect((await getMode(kv, 't1', 'U_owner'))?.kind).toBe('ctx_append');
  });
});

// ── 4. 投稿者の出し入れ（実際の SQLite で）──────────────
describe('投稿者の登録と削除', () => {
  async function ready() {
    const raw = migrate();
    const db = new Db(asD1(raw));
    await db.getTenant(DEFAULT_TENANT_ID);
    return { raw, db };
  }

  it('登録できる／同じ人は二重に入らない', async () => {
    const { db } = await ready();
    expect(await db.addStaff(DEFAULT_TENANT_ID, 'U_staff', '山田', 'U_owner', MAX_STAFF)).toBe('added');
    expect(await db.addStaff(DEFAULT_TENANT_ID, 'U_staff', '山田', 'U_owner', MAX_STAFF)).toBe('exists');
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).toEqual(['U_staff']);
    expect((await db.listStaff(DEFAULT_TENANT_ID))[0].display_name).toBe('山田');
  });

  it('★上限を超えて増やさない', async () => {
    const { db } = await ready();
    for (let i = 0; i < MAX_STAFF; i++) {
      expect(await db.addStaff(DEFAULT_TENANT_ID, `U_${i}`, null, 'U_owner', MAX_STAFF)).toBe('added');
    }
    expect(await db.addStaff(DEFAULT_TENANT_ID, 'U_extra', null, 'U_owner', MAX_STAFF)).toBe('full');
  });

  it('外せる。2回目は「もういない」', async () => {
    const { db } = await ready();
    await db.addStaff(DEFAULT_TENANT_ID, 'U_staff', null, 'U_owner', MAX_STAFF);
    expect(await db.removeStaff(DEFAULT_TENANT_ID, 'U_staff', 'line:U_owner')).toBe(true);
    expect(await db.removeStaff(DEFAULT_TENANT_ID, 'U_staff', 'line:U_owner')).toBe(false);
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).toEqual([]);
  });

  it('登録と削除を監査ログに残す', async () => {
    const { raw, db } = await ready();
    await db.addStaff(DEFAULT_TENANT_ID, 'U_staff', null, 'U_owner', MAX_STAFF);
    await db.removeStaff(DEFAULT_TENANT_ID, 'U_staff', 'line:U_owner');
    const actions = (raw.prepare("SELECT action FROM audit_logs WHERE action LIKE 'member.%' ORDER BY rowid").all() as Array<{ action: string }>)
      .map((r) => r.action);
    expect(actions).toEqual(['member.added', 'member.removed']);
  });

  it('★表がまだ無い（マイグレーション前）なら空で返し、持ち主の操作を止めない', async () => {
    const raw = migrate('0009');
    const db = new Db(asD1(raw));
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).toEqual([]);
  });
});

// ── 5. 作業中の記事は人ごと ─────────────────────────────
describe('作業中の記事は人ごとに探す', () => {
  const OWNER = { userId: 'U_owner', isOwner: true };
  const STAFF = { userId: 'U_staff', isOwner: false };

  async function ready() {
    const raw = migrate();
    const db = new Db(asD1(raw));
    await db.getTenant(DEFAULT_TENANT_ID);
    return { raw, db };
  }

  it('★投稿者の記事は、持ち主の「作業中」に出てこない（逆も同じ）', async () => {
    const { db } = await ready();
    const staffArticle = await db.createArticle(DEFAULT_TENANT_ID, '投稿者のネタ', 'U_staff');
    expect((await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF))?.id).toBe(staffArticle.id);
    expect(await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, OWNER)).toBeNull();

    const ownerArticle = await db.createArticle(DEFAULT_TENANT_ID, '持ち主のネタ', 'U_owner');
    expect((await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, OWNER))?.id).toBe(ownerArticle.id);
    expect((await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF))?.id).toBe(staffArticle.id);
  });

  it('★担当者が空の古い記事は、持ち主のものとして扱う（投稿者には出さない）', async () => {
    const { db } = await ready();
    const legacy = await db.createArticle(DEFAULT_TENANT_ID, 'この仕組みより前のネタ');   // requested_by = NULL
    expect((await db.findActiveArticle(DEFAULT_TENANT_ID, OWNER))?.id).toBe(legacy.id);
    expect(await db.findActiveArticle(DEFAULT_TENANT_ID, STAFF)).toBeNull();
  });

  it('「修正する」を押した人に担当が移る', async () => {
    const { db } = await ready();
    const a = await db.createArticle(DEFAULT_TENANT_ID, '持ち主のネタ', 'U_owner');
    await db.setRequestedBy(a.id, 'U_staff');
    expect((await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF))?.id).toBe(a.id);
    expect(await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, OWNER)).toBeNull();
  });
});

// ── 6. 承認 ─────────────────────────────────────────────
describe('投稿者の承認', () => {
  function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
    return {
      killSwitchOn: false,
      tenant: { status: 'active', publishEnabled: true, tosAcceptedAt: '2026-08-01T00:00:00.000Z', dailyPostLimit: 0, minIntervalSec: 0 },
      article: { state: 'awaiting_approval', approvedAt: '2026-09-13T00:00:00.000Z', approvedBy: 'U_staff' },
      ownerLineUserId: 'U_owner',
      staffLineUserIds: ['U_staff'],
      todayPublishCount: 0, lastPublishedAt: null, globalRecentCount: 0,
      now: '2026-09-13T00:05:00.000Z',
      ...overrides,
    };
  }

  it('投稿者が承認した記事は公開できる', () => {
    expect(canPublish(ctx()).allowed).toBe(true);
  });

  it('★外された投稿者の承認は通らない', () => {
    expect(canPublish(ctx({ staffLineUserIds: [] })).reason).toBe('wrong_approver');
  });

  it('★承認者が空なら、投稿者一覧があっても通さない', () => {
    expect(canPublish(ctx({
      article: { state: 'awaiting_approval', approvedAt: '2026-09-13T00:00:00.000Z', approvedBy: null },
    })).allowed).toBe(false);
  });

  it('部外者の承認は、これまでどおり通さない', () => {
    expect(canPublish(ctx({
      article: { state: 'awaiting_approval', approvedAt: '2026-09-13T00:00:00.000Z', approvedBy: 'U_guest' },
    })).reason).toBe('wrong_approver');
  });

  it('「公開する」を押せるのは持ち主と投稿者だけ', async () => {
    const touched: string[] = [];
    const deps = {
      db: {
        getArticle: async () => ({ id: 'a1', tenant_id: DEFAULT_TENANT_ID, state: 'awaiting_approval' }),
        updateArticle: async () => { touched.push('update'); },
        audit: async (_t: string, action: string) => { touched.push(action); },
      },
      ownerLineUserId: 'U_owner',
      staffLineUserIds: ['U_staff'],
    } as unknown as ServiceDeps;

    expect((await approve(deps, 'a1', 'U_staff')).allowed).toBe(true);
    const denied = await approve(deps, 'a1', 'U_guest');
    expect(denied.reason).toBe('wrong_approver');
    expect(touched).toEqual(['update', 'publish.denied']);
  });
});

// ── 7. 持ち主の確認（源蔵レビュー条件2）─────────────────
describe('話しかけただけでは投稿者にしない', () => {
  const P = { userId: 'U_new', displayName: '佐藤', invitedBy: 'U_owner', requestedAt: '2026-09-13T00:00:00.000Z' };

  it('確認待ちを保存・取得・削除できる', async () => {
    const kv = fakeKv();
    await savePending(kv, 't1', P);
    expect((await getPending(kv, 't1', 'U_new'))?.displayName).toBe('佐藤');
    expect(kv.puts[0].ttl).toBe(PENDING_TTL_SEC);
    await deletePending(kv, 't1', 'U_new');
    expect(await getPending(kv, 't1', 'U_new')).toBeNull();
  });

  it('★確認待ちの記録がない人は「投稿者にする」の対象にならない', async () => {
    const kv = fakeKv();
    await savePending(kv, 't1', P);
    // ボタンの uid を別人に書き換えても、その人の記録は無い
    expect(await getPending(kv, 't1', 'U_other')).toBeNull();
    expect(await getPending(kv, 't1', '')).toBeNull();
  });

  it('★読めない・壊れている・中身の userId が食い違うときは「確認待ちなし」', async () => {
    const broken = { get: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    expect(await getPending(broken, 't1', 'U_new')).toBeNull();
    expect(await getPending(fakeKv({ 'member:pending:t1:U_new': '{壊れ' }), 't1', 'U_new')).toBeNull();
    const swapped = JSON.stringify({ ...P, userId: 'U_other' });
    expect(await getPending(fakeKv({ 'member:pending:t1:U_new': swapped }), 't1', 'U_new')).toBeNull();
  });

  it('★確認待ちの一覧: 保存した人が出て、承認・却下したら消える（文字での承認に使う）', async () => {
    const kv = fakeKv();
    await savePending(kv, 't1', P);
    await savePending(kv, 't1', { ...P, userId: 'U_2', displayName: '鈴木' });
    await savePending(kv, 't1', P); // 同じ人が二重に並ばない
    expect((await listPending(kv, 't1')).map((p) => p.userId)).toEqual(['U_new', 'U_2']);
    await deletePending(kv, 't1', 'U_new');
    expect((await listPending(kv, 't1')).map((p) => p.userId)).toEqual(['U_2']);
    await deletePending(kv, 't1', 'U_2');
    expect(await listPending(kv, 't1')).toEqual([]);
    expect(kv.store['member:pendings:t1']).toBeUndefined();
    expect(await listPending(kv, 't2')).toEqual([]);
  });

  it('★期限切れで本体が消えた人は、一覧に名前が残っていても対象にしない', async () => {
    const kv = fakeKv();
    await savePending(kv, 't1', P);
    delete kv.store['member:pending:t1:U_new'];
    expect(await listPending(kv, 't1')).toEqual([]);
  });

  it('★一覧が壊れている・読めないときは「確認待ちなし」（誰かを勝手に承認しない）', async () => {
    expect(await listPending(fakeKv({ 'member:pendings:t1': '{壊れ' }), 't1')).toEqual([]);
    expect(await listPending(fakeKv({ 'member:pendings:t1': '"U_new"' }), 't1')).toEqual([]);
    const broken = { get: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    expect(await listPending(broken, 't1')).toEqual([]);
  });

  it('「投稿者にする」「断る」は文字でも承認・却下のコマンドになり、ほかの機能と重ならない', () => {
    for (const [sent, name] of [['投稿者にする', 'memberApprove'], ['断る', 'memberReject']] as const) {
      const hit = Object.entries(COMMANDS).filter(([, re]) => re.test(normalizeCommand(sent))).map(([n]) => n);
      expect(hit).toEqual([name]);
    }
    expect(buildApprovalRequest('佐藤')).toContain('文字で送っても');
  });

  describe('★文字で「投稿者にする」「断る」と送られたときの判断', () => {
    const P2 = { ...P, userId: 'U_2', displayName: '鈴木' };
    const base = { isOwner: true, approving: true, pendings: [P], inviteOpen: false };

    it('持ち主以外は、確認待ちがいても何もしない', () => {
      expect(decideTypedMemberCommand({ ...base, isOwner: false })).toEqual({ kind: 'ignore' });
      expect(decideTypedMemberCommand({ ...base, isOwner: false, approving: false })).toEqual({ kind: 'ignore' });
    });

    it('確認待ちが1人なら、その人を承認／却下する', () => {
      expect(decideTypedMemberCommand(base)).toEqual({ kind: 'approve', userId: 'U_new' });
      expect(decideTypedMemberCommand({ ...base, approving: false })).toEqual({ kind: 'reject', userId: 'U_new' });
    });

    it('★2人以上なら推測で決めず、いちばん古い1人だけを確認に出す（承認も却下もしない）', () => {
      for (const approving of [true, false]) {
        expect(decideTypedMemberCommand({ ...base, approving, pendings: [P, P2] }))
          .toEqual({ kind: 'ask', pending: P, total: 2 });
      }
    });

    it('0人: 「投稿者にする」は案内、「断る」はふつうのメッセージに流す', () => {
      expect(decideTypedMemberCommand({ ...base, pendings: [] })).toEqual({ kind: 'gone' });
      expect(decideTypedMemberCommand({ ...base, pendings: [], inviteOpen: true })).toEqual({ kind: 'not_yet' });
      expect(decideTypedMemberCommand({ ...base, pendings: [], approving: false })).toEqual({ kind: 'ignore' });
    });
  });

  it('持ち主への確認文: 名前と「押すまで何もできない」「断る」を書く', () => {
    const t = buildApprovalRequest('佐藤');
    expect(t).toContain('佐藤');
    expect(t).toContain('押すまで');
    expect(t).toContain('断る');
  });

  it('待っている本人への文面に、システムの中身を書かない', () => {
    for (const w of ['note', 'Claude', 'AI', '記事', '投稿者']) expect(buildWaitingForApproval()).not.toContain(w);
  });

  it('★使い方ページが歓迎文に入っている（リンク切れを配らない）', () => {
    expect(buildWelcomeStaff()).toMatch(/https:\/\/claude\.ai\/code\/artifact\/[0-9a-f-]{36}/);
  });
});

// ── 8. 担当の引き受け（源蔵レビュー 必須条件1）──────────
describe('★別の記事を作業中なら、ほかの記事の担当を引き受けない', () => {
  const STAFF = { userId: 'U_staff', isOwner: false };

  async function ready() {
    const raw = migrate();
    const db = new Db(asD1(raw));
    await db.getTenant(DEFAULT_TENANT_ID);
    return db;
  }

  it('投稿者が自分の記事Sを確認待ちのまま、持ち主の記事Oを直そうとすると断る', async () => {
    // 再現: S が確認待ち → 一覧から O を開いて「修正する」→「タイトルを変えて」「OK」が S に届いていた
    const db = await ready();
    const O = await db.createArticle(DEFAULT_TENANT_ID, '持ち主の記事', 'U_owner');
    const S = await db.createArticle(DEFAULT_TENANT_ID, '投稿者の記事', 'U_staff');
    const mine = await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF);
    expect(otherWorkInProgress(mine, O.id)?.id).toBe(S.id);
  });

  it('自分の作業中の記事を直すのは断らない', async () => {
    const db = await ready();
    const S = await db.createArticle(DEFAULT_TENANT_ID, '投稿者の記事', 'U_staff');
    const mine = await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF);
    expect(otherWorkInProgress(mine, S.id)).toBeNull();
  });

  it('作業中の記事が無ければ、ほかの人の記事を引き受けられる', async () => {
    const db = await ready();
    const O = await db.createArticle(DEFAULT_TENANT_ID, '持ち主の記事', 'U_owner');
    const mine = await db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, STAFF);
    expect(otherWorkInProgress(mine, O.id)).toBeNull();
  });
});

// ── 9. 投稿者一覧の読み込み失敗（源蔵レビュー）─────────
describe('投稿者一覧の読み込みに失敗したとき', () => {
  it('★表が無いとき以外の失敗は、空扱いにせず知らせる（投稿者を締め出さない・上限をすり抜けない）', async () => {
    const failing = { prepare() { throw new Error('D1 is temporarily unavailable'); } } as unknown as D1Database;
    await expect(new Db(failing).listStaffIds(DEFAULT_TENANT_ID)).rejects.toThrow('temporarily unavailable');
  });
});
