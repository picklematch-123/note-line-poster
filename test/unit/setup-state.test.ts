/**
 * セットアップ画面を「誰がいつ実行してよいか」。
 *
 * ★源蔵レビュー（2026-08-31）の条件3:
 *   初回だけ無認証で通し、以後はワンタイムコードを必須にする。
 *   初回まで塞ぐと、LINE が未接続でコードを受け取れず誰も設定できない。
 */
import { describe, it, expect } from 'vitest';
import {
  mayRun, issueSetupCode, consumeSetupCode, markSetupCompleted, isSetupCompleted, SETUP_DONE_KV,
} from '../../src/core/setup/state';

function fakeKv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, string> };
}

describe('実行してよいかの判定', () => {
  it('初回は、コード無しで通す', async () => {
    const r = await mayRun(fakeKv(), null);
    expect(r).toEqual({ allowed: true, reason: 'first_run' });
  });

  it('★2回目からは、コードが無いと通さない', async () => {
    const kv = fakeKv();
    await markSetupCompleted(kv);
    expect(await mayRun(kv, null)).toEqual({ allowed: false, reason: 'code_required' });
    expect(await mayRun(kv, '   ')).toEqual({ allowed: false, reason: 'code_required' });
  });

  it('★印が無くても、すでに稼働中だと分かっていればコードを要求する', async () => {
    // 動いている環境に /setup が生えたとき、無認証で叩かれないようにする
    const kv = fakeKv();   // 完了の印は無い
    expect(await mayRun(kv, null, true)).toEqual({ allowed: false, reason: 'code_required' });
  });

  it('正しいコードなら通す', async () => {
    const kv = fakeKv();
    await markSetupCompleted(kv);
    const { display } = await issueSetupCode(kv);
    expect(await mayRun(kv, display)).toEqual({ allowed: true, reason: 'valid_code' });
  });

  it('★同じコードは2回使えない', async () => {
    const kv = fakeKv();
    await markSetupCompleted(kv);
    const { display } = await issueSetupCode(kv);
    expect((await mayRun(kv, display)).allowed).toBe(true);
    expect(await mayRun(kv, display)).toEqual({ allowed: false, reason: 'code_invalid' });
  });

  it('でたらめなコードは通さない', async () => {
    const kv = fakeKv();
    await markSetupCompleted(kv);
    for (const bad of ['ABCD-1234', 'x', '', '00000000']) {
      expect((await mayRun(kv, bad)).allowed).toBe(false);
    }
  });

  it('★note 連携のコードでは通らない（用途が違うものを混ぜない）', async () => {
    const kv = fakeKv();
    await markSetupCompleted(kv);
    // note 連携側は pair: の接頭辞。こちらは setupcode:
    kv.store['pair:ABCD2345'] = '{"tenantId":"t"}';
    expect((await mayRun(kv, 'ABCD-2345')).allowed).toBe(false);
  });

  it('★KV が読めないときは、通さない側に倒す', async () => {
    const broken = { get: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    expect(await isSetupCompleted(broken)).toBe(true);   // 完了済み扱い＝コードを要求する
  });

  it('完了の印が残る', async () => {
    const kv = fakeKv();
    expect(await isSetupCompleted(kv)).toBe(false);
    await markSetupCompleted(kv);
    expect(kv.store[SETUP_DONE_KV]).toMatch(/^\d{4}-/);
    expect(await isSetupCompleted(kv)).toBe(true);
  });

  it('コードは見やすい形で出す', async () => {
    const { display, expiresAt } = await issueSetupCode(fakeKv());
    expect(display).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it('コードは1回きり（consume 単体）', async () => {
    const kv = fakeKv();
    const { display } = await issueSetupCode(kv);
    expect(await consumeSetupCode(kv, display)).toBe(true);
    expect(await consumeSetupCode(kv, display)).toBe(false);
  });
});
