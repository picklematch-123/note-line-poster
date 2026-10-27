/**
 * 管理者（admin。2026-10-27 V7）を足したときに、壊れてはいけないこと。
 *
 * ★守っているもの
 *   1. **管理者は顧客（持ち主）の許可なく増えない**（窓口を開けられるのも、承認できるのも持ち主だけ）
 *   2. **管理者は持ち主を外せない・リセットできない・管理者を出し入れできない**
 *   3. 管理者は、持ち主の力（設定・連携・投稿者の出し入れなど）を使える
 *   4. 管理者の一覧が読めないときは「いない」（権限を増やさない側）
 *   5. 投稿者・ゲストの権限は今までと変わらない
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleOf, canUse, isOwner, hasOwnerPower, OWNER_ONLY_MESSAGE, NOT_OWNER_MESSAGE } from '../../src/core/line/access';
import {
  openInvite, peekInvite, savePending, getPending, listPending, MAX_ADMINS, MAX_STAFF, ADMIN_DESCRIPTION,
  buildInviteOpened, buildWelcomeStaff, buildApprovalRequest,
} from '../../src/core/line/members';
import { COMMANDS } from '../../src/adapters/line/commands';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { signLineBody } from '../../src/adapters/line/signature';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

const ROOT = new URL('../../', import.meta.url).pathname;
const SECRET = 'line-secret-test';

function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return db;
}

function asD1(db: DatabaseSync, failOn?: (sql: string) => boolean): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) { params = p; return api; },
        async first<T>() { if (failOn?.(sql)) throw new Error('D1 の不調（テスト）'); return (db.prepare(sql).get(...(params as [])) as T) ?? null; },
        async run() {
          if (failOn?.(sql)) throw new Error('D1 の不調（テスト）');
          const r = db.prepare(sql).run(...(params as []));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all<T>() { if (failOn?.(sql)) throw new Error('D1 の不調（テスト）'); return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

afterEach(() => vi.restoreAllMocks());

// ── 1. 立場の判定 ───────────────────────────────────────
describe('V7: 立場の判定（roleOf / hasOwnerPower）', () => {
  const members = ['staff1', 'admin1'];
  const adminIds = ['admin1'];

  it('roleOf: 持ち主・管理者・投稿者・ゲスト・持ち主未登録', () => {
    expect(roleOf('owner', 'owner', members, adminIds)).toBe('owner');
    expect(roleOf('owner', 'admin1', members, adminIds)).toBe('admin');
    expect(roleOf('owner', 'staff1', members, adminIds)).toBe('staff');
    expect(roleOf('owner', 'stranger', members, adminIds)).toBe('guest');
    expect(roleOf('owner', '', members, adminIds)).toBe('guest');
    expect(roleOf(null, 'anyone', members, adminIds)).toBe('owner');
    // ★管理者の一覧が空（読めなかった）なら、管理者だった人は投稿者として扱われる（権限が増えない）
    expect(roleOf('owner', 'admin1', members, [])).toBe('staff');
  });

  it('hasOwnerPower: 持ち主と管理者だけ。投稿者・ゲストは false。持ち主未登録なら誰でも', () => {
    expect(hasOwnerPower('owner', adminIds, 'owner')).toBe(true);
    expect(hasOwnerPower('owner', adminIds, 'admin1')).toBe(true);
    expect(hasOwnerPower('owner', adminIds, 'staff1')).toBe(false);
    expect(hasOwnerPower('owner', adminIds, 'stranger')).toBe(false);
    expect(hasOwnerPower('owner', [], 'admin1')).toBe(false);
    expect(hasOwnerPower(null, [], 'anyone')).toBe(true);
  });

  it('isOwner は持ち主だけ（管理者は false）。canUse は持ち主・管理者・投稿者', () => {
    expect(isOwner('owner', 'admin1')).toBe(false);
    expect(isOwner('owner', 'owner')).toBe(true);
    expect(canUse('owner', 'admin1', members, adminIds)).toBe(true);
    expect(canUse('owner', 'staff1', members, adminIds)).toBe(true);
    expect(canUse('owner', 'stranger', members, adminIds)).toBe(false);
  });
});

// ── 2. DB と窓口 ────────────────────────────────────────
describe('V7: 管理者の登録・外し（DB）', () => {
  async function ready(failOn?: (sql: string) => boolean) {
    const sqlite = migrate();
    const db = new Db(asD1(sqlite, failOn));
    await new Db(asD1(sqlite)).ensureTenant();
    return { sqlite, db, ok: new Db(asD1(sqlite)) };
  }

  it('追加・上限2・すでに管理者・投稿者からの昇格。外すと登録ごと消える（投稿者に戻さない）', async () => {
    const { db } = await ready();
    await db.addStaff(DEFAULT_TENANT_ID, 'staff1', 'スタッフ', 'owner', MAX_STAFF);
    expect(await db.addAdmin(DEFAULT_TENANT_ID, 'a1', '担当1', 'owner', MAX_ADMINS)).toBe('added');
    expect(await db.addAdmin(DEFAULT_TENANT_ID, 'a1', '担当1', 'owner', MAX_ADMINS)).toBe('exists');
    expect(await db.addAdmin(DEFAULT_TENANT_ID, 'staff1', null, 'owner', MAX_ADMINS)).toBe('promoted');
    expect(await db.addAdmin(DEFAULT_TENANT_ID, 'a3', '担当3', 'owner', MAX_ADMINS)).toBe('full');
    expect((await db.listAdminIds(DEFAULT_TENANT_ID)).sort()).toEqual(['a1', 'staff1']);
    // 承認できる人（listStaffIds）には管理者も入る
    expect((await db.listStaffIds(DEFAULT_TENANT_ID)).sort()).toEqual(['a1', 'staff1']);
    // ★投稿者の外し方（removeStaff）では管理者は外れない
    expect(await db.removeStaff(DEFAULT_TENANT_ID, 'a1', 'line:admin')).toBe(false);
    expect(await db.removeAdmin(DEFAULT_TENANT_ID, 'staff1', 'line:owner')).toBe(true);
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).toEqual(['a1']);   // 投稿者に戻らず、登録ごと消えた
  });

  it('投稿者の上限は投稿者だけで数える（管理者は別枠）', async () => {
    const { db } = await ready();
    await db.addAdmin(DEFAULT_TENANT_ID, 'a1', null, 'owner', MAX_ADMINS);
    await db.addAdmin(DEFAULT_TENANT_ID, 'a2', null, 'owner', MAX_ADMINS);
    for (let i = 0; i < MAX_STAFF; i++) expect(await db.addStaff(DEFAULT_TENANT_ID, `s${i}`, null, 'owner', MAX_STAFF)).toBe('added');
    expect(await db.addStaff(DEFAULT_TENANT_ID, 's9', null, 'owner', MAX_STAFF)).toBe('full');
  });

  it('★管理者の一覧が読めない（一時障害）ときは空（権限を増やさない側）', async () => {
    const { db, ok } = await ready((sql) => sql.includes("role = 'admin'"));
    await ok.addAdmin(DEFAULT_TENANT_ID, 'a1', null, 'owner', MAX_ADMINS);
    expect(await db.listAdminIds(DEFAULT_TENANT_ID)).toEqual([]);
  });

  it('記録: 追加・外しに actor と role:admin が残る', async () => {
    const { db, sqlite } = await ready();
    await db.addAdmin(DEFAULT_TENANT_ID, 'a1', '担当1', 'owner', MAX_ADMINS);
    await db.removeAdmin(DEFAULT_TENANT_ID, 'a1', 'line:owner');
    const rows = sqlite.prepare(`SELECT action, actor, detail_json FROM audit_logs WHERE action LIKE 'member.admin_%' ORDER BY created_at`).all() as Array<{ action: string; actor: string; detail_json: string }>;
    expect(rows.map((r) => [r.action, r.actor])).toEqual([['member.admin_added', 'line:owner'], ['member.admin_removed', 'line:owner']]);
    for (const r of rows) expect(JSON.parse(r.detail_json).role).toBe('admin');
  });

  it('★窓口・確認待ちは投稿者と別の鍵。片方を開けると、もう片方は閉じる（同時に開かない）', async () => {
    const kv = fakeKv() as unknown as KVNamespace;
    await openInvite(kv, DEFAULT_TENANT_ID, 'owner');
    expect(await peekInvite(kv, DEFAULT_TENANT_ID)).not.toBeNull();
    await openInvite(kv, DEFAULT_TENANT_ID, 'owner', 'admin');
    expect(await peekInvite(kv, DEFAULT_TENANT_ID, 'admin')).not.toBeNull();
    expect(await peekInvite(kv, DEFAULT_TENANT_ID)).toBeNull();
    await savePending(kv, DEFAULT_TENANT_ID, { userId: 'u1', displayName: null, invitedBy: 'owner', requestedAt: '1' }, 'admin');
    expect(await getPending(kv, DEFAULT_TENANT_ID, 'u1')).toBeNull();
    expect(await getPending(kv, DEFAULT_TENANT_ID, 'u1', 'admin')).not.toBeNull();
    expect(await listPending(kv, DEFAULT_TENANT_ID)).toEqual([]);
    expect(await listPending(kv, DEFAULT_TENANT_ID, 'admin')).toHaveLength(1);
  });

  it('コマンドと文言: 「管理者を追加」「管理者にする」。投稿者向けの文面に「管理者」は出ない', () => {
    expect(COMMANDS.adminAdd.test('管理者を追加')).toBe(true);
    expect(COMMANDS.adminApprove.test('管理者にする')).toBe(true);
    expect(COMMANDS.memberAdd.test('管理者を追加')).toBe(false);
    expect(ADMIN_DESCRIPTION).toBe('あなたの代わりに設定を手伝う担当者（提供元など）。いつでも外せます');
    for (const t of [buildWelcomeStaff(), buildApprovalRequest('A'), buildInviteOpened()]) expect(t).not.toContain('管理者');
  });
});

// ── 3. 署名つき webhook を通した結合テスト ─────────────────────
async function webhookEnv(opts: { failPush?: boolean; dbOwner?: boolean } = {}) {
  const sqlite = migrate();
  const d1 = asD1(sqlite);
  const db = new Db(d1);
  await db.ensureTenant();
  await db.addStaff(DEFAULT_TENANT_ID, 'staff1', 'スタッフ', 'owner', MAX_STAFF);
  await db.addAdmin(DEFAULT_TENANT_ID, 'admin1', '運用担当', 'owner', MAX_ADMINS);
  if (opts.dbOwner) await db.resolveOwnerLineUserId(DEFAULT_TENANT_ID, 'owner');
  const replies: Array<{ to: string; body: string }> = [];
  const pushes: Array<{ to: string; body: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/profile/')) return new Response(JSON.stringify({ displayName: decodeURIComponent(u.split('/profile/')[1]) + 'さん' }), { status: 200 });
    if (u.endsWith('/message/reply')) replies.push({ to: '', body: String(init?.body) });
    if (u.endsWith('/message/push')) {
      if (opts.failPush) throw new Error('LINE に届かない（テスト）');
      const b = JSON.parse(String(init?.body));
      pushes.push({ to: b.to, body: String(init?.body) });
    }
    return new Response('{}', { status: 200 });
  });
  const kv = fakeKv();
  const created: unknown[] = [];
  const env = {
    DB: d1, KV: kv, LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't', ...(opts.dbOwner ? {} : { LINE_OWNER_USER_ID: 'owner' }),
    GENERATE: { create: async (p: unknown) => { created.push(p); return { id: 'w' }; } },
  };
  const { handleLineWebhook } = await import('../../src/adapters/line/webhook');
  const send = async (userId: string, ev: { text?: string; postback?: string }) => {
    const event = ev.text !== undefined
      ? { type: 'message', replyToken: 'rt', source: { userId }, message: { id: 'm', type: 'text', text: ev.text } }
      : { type: 'postback', replyToken: 'rt', source: { userId }, postback: { data: ev.postback } };
    const body = JSON.stringify({ events: [event] });
    const pending: Array<Promise<unknown>> = [];
    const res = await handleLineWebhook(new Request('https://x/line/webhook', {
      method: 'POST', body, headers: { 'x-line-signature': await signLineBody(body, SECRET) },
    }), env as never, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as never);
    expect(res.status).toBe(200);
    await Promise.all(pending);
    return replies[replies.length - 1]?.body ?? '';
  };
  return { sqlite, db, kv, env, send, replies, pushes, created };
}

describe('V7: 4者（持ち主・管理者・投稿者・ゲスト）で同じ操作を送る', () => {
  it('★持ち主の力を使う操作: 持ち主・管理者は通る／投稿者は持ち主専用の案内／ゲストは門前払い', async () => {
    const ops: Array<[string, { text?: string; postback?: string }, RegExp]> = [
      ['セットアップのコード', { text: 'セットアップ' }, /セットアップ画面で使うコード/],
      ['AI設定', { text: 'AI設定' }, /調べ方|AI設定/],
      ['サムネ設定', { text: 'サムネ設定' }, /サムネイルの自動生成/],
      ['投稿設定の変更', { postback: 'action=cfg_daily_set&v=3' }, /保存|1日/],
      ['note連携のコード', { text: 'note連携' }, /コード/],
      ['連携解除', { text: '連携解除' }, /連携/],
      ['投稿者の追加', { text: '投稿者を追加' }, /投稿者を追加する受付を始めました/],
      ['投稿者一覧', { text: '投稿者一覧' }, /投稿者/],
    ];
    for (const [label, ev, ok] of ops) {
      for (const who of ['owner', 'admin1']) {
        const { send } = await webhookEnv();
        const r = await send(who, ev);
        expect(r, `${label}（${who}）`).toMatch(ok);
        expect(r, `${label}（${who}）`).not.toContain(OWNER_ONLY_MESSAGE);
      }
      const staff = await webhookEnv();
      expect(await staff.send('staff1', ev), `${label}（投稿者）`).toMatch(/持ち主だけ/);
      const guest = await webhookEnv();
      expect(await guest.send('stranger', ev), `${label}（ゲスト）`).toContain(NOT_OWNER_MESSAGE);
    }
  });

  it('★持ち主だけの操作（リセット・管理者の追加・承認・外し）は、管理者には開かない', async () => {
    const { send, kv, db } = await webhookEnv();
    expect(await send('admin1', { text: '持ち主をリセット' })).toContain(OWNER_ONLY_MESSAGE);
    expect(await send('admin1', { text: '管理者を追加' })).toContain(OWNER_ONLY_MESSAGE);
    expect(kv.store.has(`admin:invite:${DEFAULT_TENANT_ID}`)).toBe(false);
    // 承認待ちを直接作っても、管理者の承認ボタン・文字では登録されない
    await savePending(kv as unknown as KVNamespace, DEFAULT_TENANT_ID, { userId: 'x1', displayName: 'X', invitedBy: 'owner', requestedAt: '1' }, 'admin');
    expect(await send('admin1', { postback: 'action=admin_approve&uid=x1' })).toContain(OWNER_ONLY_MESSAGE);
    expect(await send('admin1', { text: '管理者にする' })).toContain(OWNER_ONLY_MESSAGE);
    expect(await db.listAdminIds(DEFAULT_TENANT_ID)).toEqual(['admin1']);
    // 管理者を外す（確認・実行とも）
    expect(await send('admin1', { postback: 'action=admin_remove&uid=admin1' })).toContain(OWNER_ONLY_MESSAGE);
    expect(await send('admin1', { postback: 'action=admin_remove_yes&uid=admin1' })).toContain(OWNER_ONLY_MESSAGE);
    // 投稿者の外すボタンの uid を管理者に書き換えても、管理者は外れない
    await send('admin1', { postback: 'action=member_remove&uid=admin1' });
    expect(await db.listAdminIds(DEFAULT_TENANT_ID)).toEqual(['admin1']);
  });

  it('★追加の流れ: 持ち主が窓口→ゲストが話しかける→持ち主に承認ボタン→押すまで使えない→承認で管理者', async () => {
    const { send, pushes, db } = await webhookEnv();
    expect(await send('owner', { text: '管理者を追加' })).toContain('管理者を追加する受付を始めました');
    // ゲストが話しかける（窓口が閉じ、持ち主に確認）
    expect(await send('newbie', { text: 'こんにちは' })).toContain('持ち主の方の確認が済むまで');
    const ask = pushes.find((p) => p.to === 'owner')!;
    expect(ask.body).toContain('管理者として登録してほしい');
    expect(ask.body).toContain('action=admin_approve&uid=newbie');
    // 押すまで使えない
    expect(await send('newbie', { text: 'AI設定' })).toContain('持ち主の方の確認が済むまで');
    // 別のゲストは窓口が閉じているので門前払い
    expect(await send('other', { text: 'こんにちは' })).toContain(NOT_OWNER_MESSAGE);
    // 持ち主が承認
    expect(await send('owner', { postback: 'action=admin_approve&uid=newbie' })).toContain('管理者に登録しました');
    expect(pushes.some((p) => p.to === 'newbie' && p.body.includes('管理者として登録しました'))).toBe(true);
    expect((await db.listAdminIds(DEFAULT_TENANT_ID)).sort()).toEqual(['admin1', 'newbie']);
    // 管理者として使える
    expect(await send('newbie', { text: 'セットアップ' })).toContain('セットアップ画面で使うコード');
  });

  it('★文字の「管理者にする」（持ち主だけ）・上限2・既存の投稿者の昇格', async () => {
    const { send, db } = await webhookEnv();
    await send('owner', { text: '管理者を追加' });
    // 既存の投稿者が話しかけた → 管理者の確認待ちに（投稿者のまま待つ）
    await send('staff1', { text: 'こんにちは' });
    expect(await send('owner', { text: '管理者にする' })).toContain('管理者に登録しました（投稿者から変更）');
    expect((await db.listAdminIds(DEFAULT_TENANT_ID)).sort()).toEqual(['admin1', 'staff1']);
    // 上限2に達しているので、窓口を開けない
    expect(await send('owner', { text: '管理者を追加' })).toContain(`管理者は${MAX_ADMINS}人まで`);
  });

  it('★管理者の窓口と投稿者の窓口が混ざらない（管理者の窓口に来た人は投稿者の確認待ちにならない）', async () => {
    const { send, kv } = await webhookEnv();
    await send('owner', { text: '投稿者を追加' });
    await send('owner', { text: '管理者を追加' });   // 投稿者の窓口は閉じる
    expect(kv.store.has(`member:invite:${DEFAULT_TENANT_ID}`)).toBe(false);
    await send('g1', { text: 'こんにちは' });
    expect(await listPending(kv as unknown as KVNamespace, DEFAULT_TENANT_ID)).toEqual([]);
    expect((await listPending(kv as unknown as KVNamespace, DEFAULT_TENANT_ID, 'admin')).map((p) => p.userId)).toEqual(['g1']);
    // 持ち主の文字の「断る」は管理者の確認待ちに効く
    expect(await send('owner', { text: '断る' })).toContain('管理者に登録しませんでした');
  });

  it('管理者は投稿者の受付を開け、承認のお知らせは開けた管理者に届く', async () => {
    const { send, pushes, db } = await webhookEnv();
    await send('admin1', { text: '投稿者を追加' });
    await send('g2', { text: 'こんにちは' });
    expect(pushes.find((p) => p.body.includes('action=member_approve&uid=g2'))?.to).toBe('admin1');
    expect(await send('admin1', { postback: 'action=member_approve&uid=g2' })).toContain('投稿者に登録しました');
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).toContain('g2');
  });

  it('★一覧: 持ち主には管理者が役割つきで並び外すボタンが出る。管理者には管理者が見えない', async () => {
    const owner = await webhookEnv();
    const r1 = await owner.send('owner', { text: '投稿者一覧' });
    expect(r1).toContain('（管理者）');
    expect(r1).toContain('（投稿者）');
    expect(r1).toContain('action=admin_remove&uid=admin1');
    const admin = await webhookEnv();
    const r2 = await admin.send('admin1', { text: '投稿者一覧' });
    expect(r2).not.toContain('管理者');
    expect(r2).not.toContain('admin1');
    expect(r2).toContain('action=member_remove&uid=staff1');
  });

  it('★管理者を外せるのは持ち主だけ（外す前の確認つき）。外すと操作できなくなる', async () => {
    const { send, db } = await webhookEnv();
    expect(await send('owner', { postback: 'action=admin_remove&uid=admin1' })).toContain('管理者から外しますか');
    expect(await send('owner', { postback: 'action=admin_remove_yes&uid=admin1' })).toContain('管理者から外しました');
    expect(await db.listAdminIds(DEFAULT_TENANT_ID)).toEqual([]);
    expect(await send('admin1', { text: 'セットアップ' })).toContain(NOT_OWNER_MESSAGE);
  });

  it('「その他の設定」: 「管理者を追加」は持ち主にだけ出る', async () => {
    const owner = await webhookEnv();
    expect(await owner.send('owner', { text: 'その他の設定' })).toContain('管理者を追加');
    const admin = await webhookEnv();
    const r = await admin.send('admin1', { text: 'その他の設定' });
    expect(r).toContain('投稿者を追加');
    expect(r).not.toContain('管理者');
  });

  it('★記録と通知: 管理者がセットアップのコードを出すと actor・role が残り、持ち主に1行届く。通知が失敗しても止まらない', async () => {
    const { send, sqlite, pushes } = await webhookEnv();
    expect(await send('admin1', { text: 'セットアップ' })).toContain('セットアップ画面で使うコード');
    const row = sqlite.prepare(`SELECT actor, detail_json FROM audit_logs WHERE action = 'setup.code_issued'`).get() as { actor: string; detail_json: string };
    expect(row.actor).toBe('line:admin1');
    expect(JSON.parse(row.detail_json)).toEqual({ role: 'admin' });
    expect(pushes.find((p) => p.to === 'owner')?.body).toContain('運用担当のadmin1さんさんがセットアップを開きました');
    // 持ち主が出したときは知らせない
    const o = await webhookEnv();
    await o.send('owner', { text: 'セットアップ' });
    expect(o.pushes).toHaveLength(0);
    // 通知が失敗しても、コードは届く
    const f = await webhookEnv({ failPush: true });
    expect(await f.send('admin1', { text: 'セットアップ' })).toContain('セットアップ画面で使うコード');
  });

  it('管理者の機密性の高い操作（連携解除・投稿設定・ナレッジの削除）に role:admin が残る', async () => {
    const { send, sqlite, db } = await webhookEnv();
    await db.saveContext(DEFAULT_TENANT_ID, '・一つ目\n・二つ目', null, 'x');
    await send('admin1', { text: '連携解除' });
    await send('admin1', { postback: 'action=cfg_daily_set&v=3' });
    await send('admin1', { postback: 'action=ctx_delete' });
    await send('admin1', { text: '1' });
    const rows = sqlite.prepare(`SELECT action, actor, detail_json FROM audit_logs WHERE actor = 'line:admin1'`).all() as Array<{ action: string; detail_json: string | null }>;
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r.detail_json ? JSON.parse(r.detail_json) : null]));
    expect(byAction['session.disconnected']).toMatchObject({ role: 'admin' });
    expect(byAction['settings.changed']).toMatchObject({ role: 'admin' });
    expect(byAction['knowledge.deleted']).toMatchObject({ role: 'admin' });
  });

  it('回帰: 投稿者は記事を作れる・ゲストは何もできない（今までどおり）', async () => {
    const { send } = await webhookEnv();
    expect(await send('staff1', { text: '記事を作成する' })).not.toContain(OWNER_ONLY_MESSAGE);
    expect(await send('stranger', { text: '記事を作成する' })).toContain(NOT_OWNER_MESSAGE);
    expect(await send('staff1', { text: '持ち主をリセット' })).toContain(OWNER_ONLY_MESSAGE);
    expect(await send('staff1', { text: '管理者を追加' })).toContain(OWNER_ONLY_MESSAGE);
  });
});

// ── V7 追補: /setup の持ち主のリセットは、持ち主が発行したコードでだけ通す ─────────
describe('V7 追補: セットアップのコードに発行した人の立場を記録する', () => {
  async function setupEnv() {
    const { setupRouter } = await import('../../src/adapters/setup/router');
    const { issueSetupCode, SETUP_DONE_KV } = await import('../../src/core/setup/state');
    const sqlite = migrate();
    const d1 = asD1(sqlite);
    const db = new Db(d1);
    await db.ensureTenant();
    await db.resolveOwnerLineUserId(DEFAULT_TENANT_ID, 'owner');
    const kv = fakeKv();
    kv.store.set(SETUP_DONE_KV, new Date().toISOString());
    const env = { DB: d1, KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };
    const post = (path: string, body: Record<string, string>) => {
      const text = new URLSearchParams(body).toString();
      return setupRouter.request(path, {
        method: 'POST', body: text,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(text)) },
      }, env);
    };
    const codeKeys = () => [...kv.store.keys()].filter((k) => k.startsWith('setupcode:'));
    return { db, kv, env, post, codeKeys, issue: (who: 'owner' | 'admin') => issueSetupCode(kv as unknown as KVNamespace, who), setupRouter };
  }

  it('★管理者が発行したコードでは、持ち主のリセットは 403。コードは消費されない', async () => {
    const { db, post, issue, codeKeys } = await setupEnv();
    const { display } = await issue('admin');
    const res = await post('/setup/reset-owner', { code: display });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('持ち主ご本人が『セットアップ』と送って受け取ったコードをお使いください');
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBe('owner');
    expect(codeKeys()).toHaveLength(1);
    // 同じコードで、ほかの操作（投稿のペース）は通る
    expect((await post('/setup/settings', { code: display, daily: '3', interval: '1800' })).status).toBe(200);
    expect(codeKeys()).toHaveLength(0);
  });

  it('持ち主が発行したコードなら、持ち主のリセットが通る', async () => {
    const { db, post, issue } = await setupEnv();
    const { display } = await issue('owner');
    expect((await post('/setup/reset-owner', { code: display })).status).toBe(200);
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBeNull();
  });

  it('立場の記録が無い古い形のコード（発行時刻の文字列だけ）は、持ち主の発行として扱う', async () => {
    const { db, kv, post } = await setupEnv();
    const { issuerOf } = await import('../../src/core/setup/state');
    expect(issuerOf('2026-10-27T00:00:00.000Z')).toBe('owner');
    expect(issuerOf(JSON.stringify({ issuedAt: 'x', issuer: 'admin' }))).toBe('admin');
    expect(issuerOf(JSON.stringify({ issuedAt: 'x', issuer: 'owner' }))).toBe('owner');
    kv.store.set('setupcode:ABCD2345', '2026-10-27T00:00:00.000Z');
    expect((await post('/setup/reset-owner', { code: 'ABCD-2345' })).status).toBe(200);
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBeNull();
  });

  it('LINE から管理者が「セットアップ」と送ると、管理者の立場でコードが記録される（持ち主なら owner）', async () => {
    const a = await webhookEnv();
    await a.send('admin1', { text: 'セットアップ' });
    const stored = [...a.kv.store.entries()].filter(([k]) => k.startsWith('setupcode:')).map(([, v]) => JSON.parse(v));
    expect(stored).toEqual([expect.objectContaining({ issuer: 'admin' })]);
    const o = await webhookEnv();
    await o.send('owner', { text: 'セットアップ' });
    const stored2 = [...o.kv.store.entries()].filter(([k]) => k.startsWith('setupcode:')).map(([, v]) => JSON.parse(v));
    expect(stored2).toEqual([expect.objectContaining({ issuer: 'owner' })]);
  });

  it('画面の「持ち主を変える」に「持ち主ご本人が受け取ったコードが必要です」と出る', async () => {
    const { env, setupRouter } = await setupEnv();
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('持ち主ご本人が受け取ったコードが必要です');
  });

  it('初回（セットアップ前）は今までどおりコード無しで通る（first_run）', async () => {
    const { mayRun } = await import('../../src/core/setup/state');
    const kv = fakeKv() as unknown as KVNamespace;
    expect(await mayRun(kv, null, false, { ownerOnly: true })).toEqual({ allowed: true, reason: 'first_run' });
  });
});


// ── V7 源蔵レビュー（条件付きGO）の対応 ─────────────────────────
describe('V7 源蔵レビュー必須1: 持ち主の登録をやめた直後に、管理者は持ち主にならない', () => {
  it('★リセットの注意文に「管理者がいます」。リセット後に管理者が先に話しかけても持ち主にならない', async () => {
    const { send, db } = await webhookEnv({ dbOwner: true });
    const r = await send('owner', { text: '持ち主をリセット' });
    expect(r).toContain('持ち主の登録をやめました');
    expect(r).toContain('管理者がいます（持ち主ご本人が先に話しかけてください）');
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBeNull();
    expect(await send('admin1', { text: 'セットアップ' })).toContain('持ち主ご本人に、先にこのアカウントへ話しかけてもらってください');
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBeNull();
    // 持ち主ご本人が先に話しかければ持ち主になる
    await send('owner', { text: 'メニュー' });
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBe('owner');
  });

  it('管理者がいない環境は今までどおり（最初に話しかけた人が持ち主になる。注意文に管理者は出ない）', async () => {
    const { send, db } = await webhookEnv({ dbOwner: true });
    await db.removeAdmin(DEFAULT_TENANT_ID, 'admin1', 'test');
    expect(await send('owner', { text: '持ち主をリセット' })).not.toContain('管理者');
    await send('someone', { text: 'こんにちは' });
    expect(await db.getOwnerLineUserId(DEFAULT_TENANT_ID)).toBe('someone');
  });
});

describe('V7 源蔵レビュー必須2: /setup の書き込みに、使ったコードの立場（web:owner / web:admin）が残る', () => {
  async function env() {
    const { setupRouter } = await import('../../src/adapters/setup/router');
    const { issueSetupCode, SETUP_DONE_KV } = await import('../../src/core/setup/state');
    const sqlite = migrate();
    const d1 = asD1(sqlite);
    await new Db(d1).ensureTenant();
    await new Db(d1).resolveOwnerLineUserId(DEFAULT_TENANT_ID, 'owner');
    const kv = fakeKv();
    kv.store.set(SETUP_DONE_KV, new Date().toISOString());
    const e = { DB: d1, KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };
    const post = (path: string, body: Record<string, string>) => {
      const t = new URLSearchParams(body).toString();
      return setupRouter.request(path, { method: 'POST', body: t,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(t)) } }, e);
    };
    const rows = () => sqlite.prepare(`SELECT actor, detail_json FROM audit_logs WHERE action = 'setup.write' ORDER BY created_at`).all() as Array<{ actor: string; detail_json: string }>;
    return { post, rows, sqlite, issue: (who: 'owner' | 'admin') => issueSetupCode(kv as unknown as KVNamespace, who) };
  }

  it('★管理者のコードで投稿のペース・画像のルールを保存すると web:admin・role:admin が残る（本文は入らない）', async () => {
    const { post, rows, sqlite, issue } = await env();
    expect((await post('/setup/settings', { code: (await issue('admin')).display, daily: '3', interval: '1800' })).status).toBe(200);
    expect((await post('/setup/image-rules', { code: (await issue('admin')).display, thumb_body: '社外秘のルール本文' })).status).toBe(200);
    const r = rows();
    expect(r.map((x) => [x.actor, JSON.parse(x.detail_json).role, JSON.parse(x.detail_json).op])).toEqual([
      ['web:admin', 'admin', 'settings'], ['web:admin', 'admin', 'image_rules']]);
    for (const x of r) expect(x.detail_json).not.toContain('社外秘のルール本文');
    // 投稿設定の既存の記録（tenant.settings）にも actor が入る
    expect((sqlite.prepare(`SELECT actor FROM audit_logs WHERE action = 'tenant.settings'`).get() as { actor: string }).actor).toBe('web:admin');
  });

  it('持ち主のコードなら web:owner。持ち主の登録をやめた記録にも残る', async () => {
    const { post, rows, sqlite, issue } = await env();
    expect((await post('/setup/reset-owner', { code: (await issue('owner')).display })).status).toBe(200);
    expect(rows().map((x) => [x.actor, JSON.parse(x.detail_json).op])).toEqual([['web:owner', 'reset_owner']]);
    expect((sqlite.prepare(`SELECT actor FROM audit_logs WHERE action = 'owner.cleared'`).get() as { actor: string }).actor).toBe('web:owner');
  });
});

describe('V7 源蔵レビュー前倒し', () => {
  it('3: addAdmin の上限判定は厳しく読む（読めなければ例外＝登録しない）', async () => {
    const sqlite = migrate();
    const ok = new Db(asD1(sqlite));
    await ok.ensureTenant();
    const failing = new Db(asD1(sqlite, (sql) => sql.includes("role = 'admin'")));
    await expect(failing.addAdmin(DEFAULT_TENANT_ID, 'a1', null, 'owner', MAX_ADMINS)).rejects.toThrow();
    expect(await ok.listAdminIds(DEFAULT_TENANT_ID)).toEqual([]);
  });

  it('4: 管理者が note 連携のコードを出すと role:admin が残り、持ち主に1行届く（失敗しても止まらない）', async () => {
    const { send, sqlite, pushes } = await webhookEnv();
    expect(await send('admin1', { text: 'note連携' })).toMatch(/コード/);
    const row = sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'session.code_issued'`).get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toEqual({ role: 'admin' });
    expect(pushes.find((p) => p.to === 'owner')?.body).toContain('note 連携のコードを出しました');
    const f = await webhookEnv({ failPush: true });
    expect(await f.send('admin1', { text: 'note連携' })).toMatch(/コード/);
    // 持ち主が出したときは知らせない・role も付かない
    const o = await webhookEnv();
    await o.send('owner', { text: 'note連携' });
    expect(o.pushes).toHaveLength(0);
  });

  it('5: 管理者の窓口に既存の投稿者が話しかけたら、承認依頼に「この方は現在、投稿者です」', async () => {
    const { send, pushes } = await webhookEnv();
    await send('owner', { text: '管理者を追加' });
    await send('staff1', { text: 'こんにちは' });
    expect(pushes.find((p) => p.to === 'owner')?.body).toContain('この方は現在、投稿者です');
    const g = await webhookEnv();
    await g.send('owner', { text: '管理者を追加' });
    await g.send('newbie', { text: 'こんにちは' });
    expect(g.pushes.find((p) => p.to === 'owner')?.body).not.toContain('この方は現在、投稿者です');
  });

  it('6: 管理者が投稿者を追加・外したときの記録に role:admin が付く', async () => {
    const { send, sqlite } = await webhookEnv();
    await send('admin1', { text: '投稿者を追加' });
    await send('g9', { text: 'こんにちは' });
    await send('admin1', { postback: 'action=member_approve&uid=g9' });
    await send('admin1', { postback: 'action=member_remove&uid=g9' });
    const added = sqlite.prepare(`SELECT actor, detail_json FROM audit_logs WHERE action = 'member.added' AND detail_json LIKE '%g9%'`).get() as { actor: string; detail_json: string };
    expect(added.actor).toBe('line:admin1');
    expect(JSON.parse(added.detail_json)).toMatchObject({ userId: 'g9', role: 'admin' });
    const removed = sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'member.removed'`).get() as { detail_json: string };
    expect(JSON.parse(removed.detail_json)).toMatchObject({ userId: 'g9', role: 'admin' });
  });

  it('8: 確認待ちでない人の admin_approve（持ち主が押した）は効かない／member_approve に管理者の確認待ちの uid を入れても投稿者にならない', async () => {
    const { send, kv, db } = await webhookEnv();
    expect(await send('owner', { postback: 'action=admin_approve&uid=nobody' })).toContain('期限が切れたか、すでに済んでいます');
    expect(await db.listAdminIds(DEFAULT_TENANT_ID)).toEqual(['admin1']);
    await savePending(kv as unknown as KVNamespace, DEFAULT_TENANT_ID, { userId: 'cand', displayName: 'C', invitedBy: 'owner', requestedAt: '1' }, 'admin');
    expect(await send('owner', { postback: 'action=member_approve&uid=cand' })).toContain('期限が切れたか、すでに済んでいます');
    expect(await db.listStaffIds(DEFAULT_TENANT_ID)).not.toContain('cand');
    expect(await getPending(kv as unknown as KVNamespace, DEFAULT_TENANT_ID, 'cand', 'admin')).not.toBeNull();
  });
});
