import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { checkPolicy, publishArticle, PolicyBlockedError, type ServiceDeps } from '../../src/core/article/service';
import { retryBlocked } from '../../src/cron/retry-blocked';
import type { Env } from '../../src/env';

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); databases.splice(0).forEach((db) => db.close()); });

function asD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let params: unknown[] = [];
    const api = {
      bind(...values: unknown[]) { params = values; return api; },
      async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
      async run() { const result = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return api;
  } } as unknown as D1Database;
}

async function waiting(detail: unknown = { reason: 'daily_limit', retryAfter: '2026-10-08T00:00:00.000Z' }) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T14:00:00.000Z')); // JST 23時に承認
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  }
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  const article = await db.createArticle(DEFAULT_TENANT_ID, 'テスト記事');
  await db.updateArticle(article.id, { state: 'awaiting_approval', approved_at: '2026-10-07T14:00:00.000Z', approved_by: 'owner' });
  await db.setState(article.id, 'awaiting_approval', 'blocked', 'line:owner', detail);
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
  const deps = { db, ownerLineUserId: 'owner', llmApiKey: '', noteSession: { cookieHeader: '', userAgent: '', urlname: 'test' }, images: { get: async () => null } } as unknown as ServiceDeps;
  const env = { DB: db.raw, KV: kv, LINE_OWNER_USER_ID: 'owner', NOTE_URLNAME: 'test', ANTHROPIC_API_KEY: '', LINE_CHANNEL_ACCESS_TOKEN: '' } as Env;
  return { db, article, deps, env };
}

describe('日次上限待機の予約時刻', () => {
  it('JST0時に本数がリセットされても、Cronはnoteへの投稿を試みない', async () => {
    const { env } = await waiting();
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z')); // マレーシア23時 / JST0時
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => { calls.push(String(url)); return new Response('{}', { status: 401 }); });
    await retryBlocked(env);
    expect(calls).toEqual([]);
  });

  it('JST9時ちょうどからCronがnoteへの投稿を試みる', async () => {
    const { env } = await waiting();
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => { calls.push(String(url)); return new Response('{}', { status: 401 }); });
    await retryBlocked(env);
    expect(calls.some((url) => url.includes('note.com/api/v2/current_user'))).toBe(true);
  });

  it('publishArticleから直接呼んでもJST8:59の公開を拒否する', async () => {
    const { deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-07T23:59:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(publishArticle(deps, article.id)).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it('修正前に作られた予約時刻なしの待機も、待機開始日の翌JST9時まで出さない', async () => {
    const { deps, article } = await waiting({ reason: 'daily_limit' });
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    expect(await checkPolicy(deps, article.id)).toMatchObject({ allowed: false, reason: 'daily_limit', retryAfter: '2026-10-08T00:00:00.000Z' });
  });

  it('日付が変わるたびに予約を翌日にずらさない', async () => {
    const { deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    expect((await checkPolicy(deps, article.id)).retryAfter).toBe('2026-10-08T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    expect((await checkPolicy(deps, article.id)).allowed).toBe(true);
  });
  it('9時に再び日次上限へ達していたら、次の翌朝を保存して次の0時にも守る', async () => {
    const { db, deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    for (let i = 0; i < 3; i++) await db.recordPublish(DEFAULT_TENANT_ID, article.id);
    expect((await checkPolicy(deps, article.id)).retryAfter).toBe('2026-10-09T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-08T15:00:00.000Z'));
    // 再承認しても保存された予定を迂回しない（24時間TTLの影響を分離）
    await db.updateArticle(article.id, { approved_at: '2026-10-08T14:00:00.000Z' });
    expect(await checkPolicy(deps, article.id)).toMatchObject({ allowed: false, retryAfter: '2026-10-09T00:00:00.000Z' });
  });

  it('別の停止理由のイベントが増えても、日次上限の予約を忘れない', async () => {
    const { db, deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    await db.logEvent(article.id, 'blocked', 'blocked', 'system', { reason: 'kill_switch' });
    expect((await checkPolicy(deps, article.id)).retryAfter).toBe('2026-10-08T00:00:00.000Z');
  });

  it('再接続待ちに移っても日次上限の予約を忘れない', async () => {
    const { db, deps, article } = await waiting();
    await db.setState(article.id, 'blocked', 'awaiting_session', 'system');
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    expect((await checkPolicy(deps, article.id)).allowed).toBe(false);
  });

  it('予約よりも承認者チェックを優先する', async () => {
    const { deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z'));
    expect((await checkPolicy({ ...deps, ownerLineUserId: 'different-owner' }, article.id)).reason).toBe('wrong_approver');
  });

  it('待機しても24時間の承認期限を延長しない', async () => {
    const { deps, article } = await waiting();
    vi.setSystemTime(new Date('2026-10-08T14:01:00.000Z'));
    expect((await checkPolicy(deps, article.id)).reason).toBe('approval_expired');
  });

  it('保存された連投間隔の予定も尊重する', async () => {
    const { db, deps, article } = await waiting({ reason: 'too_soon', retryAfter: '2026-10-07T14:30:00.000Z' });
    vi.setSystemTime(new Date('2026-10-07T14:29:00.000Z'));
    expect((await checkPolicy(deps, article.id)).reason).toBe('too_soon');
    vi.setSystemTime(new Date('2026-10-07T14:30:00.000Z'));
    expect((await checkPolicy(deps, article.id)).allowed).toBe(true);
    expect(await db.getPublishWait(article.id)).not.toBeNull();
  });

  it('再接続待ちから新たに日次上限へ達した場合も翌朝の予定を保存する', async () => {
    const { db, deps, article } = await waiting();
    await db.setState(article.id, 'blocked', 'awaiting_session', 'system');
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    for (let i = 0; i < 3; i++) await db.recordPublish(DEFAULT_TENANT_ID, article.id);
    expect((await checkPolicy(deps, article.id)).retryAfter).toBe('2026-10-09T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-08T15:00:00.000Z'));
    await db.updateArticle(article.id, { approved_at: '2026-10-08T14:00:00.000Z' });
    expect(await checkPolicy(deps, article.id)).toMatchObject({ allowed: false, retryAfter: '2026-10-09T00:00:00.000Z' });
  });

});
