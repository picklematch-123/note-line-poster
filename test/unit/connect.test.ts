import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleConnectNote, handleConnectPreflight, handleConnectPing } from '../../src/adapters/connect/router';
import { issuePairingCode } from '../../src/core/session/pairing';
import { SESSION_COOKIE } from '../../src/core/session/cookies';
import { generateMasterKey } from '../../src/core/tenant/crypto';
import type { Env } from '../../src/env';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async put(k: string, v: string) { store.set(k, v); },
    async get(k: string) { return store.get(k) ?? null; },
    async delete(k: string) { store.delete(k); },
  } as unknown as KVNamespace;
}

/**
 * D1 の代役。
 * ここに INSERT が届いたら「検証を素通りした」ということなので、全部記録する。
 */
function fakeDb(mode: 'server' | 'agent' = 'server') {
  const calls: string[] = [];
  const tenant = {
    id: 'tenant_default', status: 'active', publish_enabled: 1,
    tos_accepted_at: '2026-08-01T00:00:00.000Z', daily_post_limit: 0, min_interval_sec: 0,
    execution_mode: mode, agent_fallback: 0,
  };
  const make = (sql: string) => {
    const stmt = {
      bind: () => stmt,
      first: async () => (/FROM tenants/i.test(sql) ? tenant : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt;
  };
  return {
    calls,
    prepare: (sql: string) => { calls.push(sql); return make(sql); },
    batch: async () => { calls.push('BATCH'); return []; },
  } as unknown as D1Database & { calls: string[] };
}

function env(kv: KVNamespace, db = fakeDb()): Env {
  return {
    DB: db,
    KV: kv,
    MASTER_KEY_V1: generateMasterKey(),
    LINE_CHANNEL_ACCESS_TOKEN: 'dummy',
  } as unknown as Env;
}

function post(body: unknown, origin = 'chrome-extension://abcdefghijklmnop'): Request {
  return new Request('https://example.com/connect/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
}

const validCookies = [{ name: SESSION_COOKIE, value: 'sess-abc', domain: '.note.com' }];

beforeEach(() => { vi.restoreAllMocks(); });

describe('連携エンドポイント — 入口の守り', () => {
  it('★コードが無ければ note に一切アクセスしない', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await handleConnectNote(
      post({ code: 'ZZZZ9999', cookies: validCookies, userAgent: UA }), env(fakeKv()));

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect((await res.json() as any).message).toContain('note連携');
  });

  it('★期限切れ・使用済みのコードも同じく通さない', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const e = env(kv);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: { id: 1, urlname: 'me', nickname: '私' } }), { status: 200 }));

    await handleConnectNote(post({ code: display, cookies: validCookies, userAgent: UA }), e);
    const second = await handleConnectNote(post({ code: display, cookies: validCookies, userAgent: UA }), e);
    expect(second.status).toBe(401);
  });

  it('形が違うリクエストは 400 で断る', async () => {
    for (const body of [{}, { code: 'ABCD2345' }, { code: 'ABCD2345', cookies: [], userAgent: UA }]) {
      const res = await handleConnectNote(post(body), env(fakeKv()));
      expect(res.status).toBe(400);
    }
  });

  it('★セッション Cookie が無ければ、コードが正しくても保存しない', async () => {
    const kv = fakeKv();
    const db = fakeDb();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const spy = vi.spyOn(globalThis, 'fetch');

    const res = await handleConnectNote(
      post({ code: display, cookies: [{ name: 'note_locale', value: 'ja' }], userAgent: UA }),
      env(kv, db));

    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toContain('ログイン');
    expect(spy).not.toHaveBeenCalled();
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(false);
  });

  it('User-Agent が取れていなければ断る', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const res = await handleConnectNote(
      post({ code: display, cookies: validCookies, userAgent: 'x' }), env(kv));
    expect(res.status).toBe(400);
  });

  it('★note で通らない Cookie は保存しない（連携できたのに投稿できない、を作らない）', async () => {
    const kv = fakeKv();
    const db = fakeDb();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: 'auth', message: 'unauthorized' } }), { status: 401 }));

    const res = await handleConnectNote(
      post({ code: display, cookies: validCookies, userAgent: UA }), env(kv, db));

    expect(res.status).toBe(400);
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(false);
  });

  it('★暗号化鍵が無いときは、平文で保存せずに断る', async () => {
    const kv = fakeKv();
    const db = fakeDb();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const e = { ...env(kv, db), MASTER_KEY_V1: undefined } as Env;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: { id: 1, urlname: 'me', nickname: '私' } }), { status: 200 }));

    const res = await handleConnectNote(post({ code: display, cookies: validCookies, userAgent: UA }), e);

    expect(res.status).toBe(503);
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(false);
  });
});

describe('連携エンドポイント — 正常系', () => {
  it('note で通ることを確かめてから暗号化して保存する', async () => {
    const kv = fakeKv();
    const db = fakeDb();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const seen: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push(url);
      if (url.includes('note.com/api/v2/current_user')) {
        return new Response(JSON.stringify({ data: { id: 42, urlname: 'someone', nickname: 'お客さま' } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });  // LINE への push
    });

    const res = await handleConnectNote(
      post({ code: display, cookies: validCookies, userAgent: UA }), env(kv, db));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, urlname: 'someone', nickname: 'お客さま' });

    // 保存より先に疎通確認していること
    expect(seen[0]).toContain('current_user');
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(true);
    // 結果は LINE にも届く（拡張の画面を閉じても分かるように）
    expect(seen.some((u) => u.includes('api.line.me'))).toBe(true);
  });
});

describe('CORS', () => {
  it('拡張機能のオリジンをそのまま許可する', () => {
    const res = handleConnectPreflight(new Request('https://example.com/connect/note', {
      method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://abcdefghijklmnop');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('疎通確認に答える', async () => {
    const res = handleConnectPing(new Request('https://example.com/connect/ping'));
    expect((await res.json() as any).ok).toBe(true);
  });
});

describe('★実行方式による預かり方の違い', () => {
  const validCookiesLocal = [{ name: SESSION_COOKIE, value: 'sess-abc', domain: '.note.com' }];

  async function connectWith(mode: 'server' | 'agent') {
    const kv = fakeKv();
    const db = fakeDb(mode);
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('current_user')) {
        return new Response(JSON.stringify({ data: { id: 1, urlname: 'someone', nickname: 'お客さま' } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await handleConnectNote(
      post({ code: display, cookies: validCookiesLocal, userAgent: UA }), env(kv, db));
    return { res, db, body: await res.json() as any };
  }

  it('agent では Cookie を預からない（投稿は顧客のブラウザが行うため）', async () => {
    const { res, db, body } = await connectWith('agent');
    expect(res.status).toBe(200);
    expect(body.executesLocally).toBe(true);
    expect(body.deviceToken).toBeTruthy();
    // ★暗号化して保存する処理そのものが走らない
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(false);
    // 端末は登録される
    expect(db.calls.some((c) => /INSERT INTO agent_devices/.test(c))).toBe(true);
  });

  it('server では従来どおり暗号化して預かる', async () => {
    const { res, db, body } = await connectWith('server');
    expect(res.status).toBe(200);
    expect(body.executesLocally).toBe(false);
    expect(db.calls.some((c) => /INSERT INTO tenant_secrets/.test(c))).toBe(true);
  });

  it('★どちらの方式でも、端末トークンは応答にしか現れない', async () => {
    const { db, body } = await connectWith('agent');
    const token = body.deviceToken as string;
    expect(token.length).toBeGreaterThanOrEqual(64);
    // SQL に平文のトークンが混ざっていない（保存されるのはハッシュ）
    expect(db.calls.join('\n')).not.toContain(token);
  });
});
