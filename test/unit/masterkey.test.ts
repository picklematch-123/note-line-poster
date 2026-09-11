/**
 * 暗号化のマスター鍵の扱い。
 *
 * ★ここを間違えると、顧客の note 連携が全部読めなくなる（つなぎ直しが必要になる）。
 *   源蔵レビュー（2026-08-31）の条件:
 *   「既存があれば絶対に上書きしない」＋「連携済みなら生成そのものを拒否」
 */
import { describe, it, expect } from 'vitest';
import { resolveMasterKey, ensureMasterKey, MASTER_KEY_KV } from '../../src/core/setup/masterkey';

/** KV の代わり。put された値を覚えておく。 */
function fakeKv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, string> };
}

describe('鍵の取り出し', () => {
  it('環境変数があれば、それを最優先する（既存の運用を壊さない）', async () => {
    const KV = fakeKv({ [MASTER_KEY_KV]: 'kv-key' });
    const r = await resolveMasterKey({ MASTER_KEY_V1: 'env-key', KV });
    expect(r).toEqual({ key: 'env-key', source: 'env' });
  });

  it('環境変数が無ければ KV から読む', async () => {
    const KV = fakeKv({ [MASTER_KEY_KV]: 'kv-key' });
    const r = await resolveMasterKey({ KV });
    expect(r).toEqual({ key: 'kv-key', source: 'kv' });
  });

  it('どこにも無ければ none', async () => {
    const r = await resolveMasterKey({ KV: fakeKv() });
    expect(r.key).toBeUndefined();
    expect(r.source).toBe('none');
  });

  it('空文字や空白だけの設定は「無い」とみなす', async () => {
    const r = await resolveMasterKey({ MASTER_KEY_V1: '   ', KV: fakeKv() });
    expect(r.source).toBe('none');
  });
});

describe('鍵を用意する', () => {
  it('何も無ければ作って KV に入れる', async () => {
    const KV = fakeKv();
    const r = await ensureMasterKey({ KV }, false);
    expect(r).toMatchObject({ ok: true, created: true, source: 'kv' });
    expect(KV.store[MASTER_KEY_KV]).toMatch(/^[A-Za-z0-9+/]+=*$/);   // base64
  });

  it('★すでに KV にあるものは書き換えない', async () => {
    const KV = fakeKv({ [MASTER_KEY_KV]: 'already-here' });
    const r = await ensureMasterKey({ KV }, false);
    expect(r).toMatchObject({ ok: true, created: false });
    expect(KV.store[MASTER_KEY_KV]).toBe('already-here');
  });

  it('★環境変数にあるときは KV に書かない', async () => {
    const KV = fakeKv();
    const r = await ensureMasterKey({ MASTER_KEY_V1: 'env-key', KV }, false);
    expect(r).toMatchObject({ ok: true, created: false, source: 'env' });
    expect(KV.store[MASTER_KEY_KV]).toBeUndefined();
  });

  it('★連携済みなのに鍵が無いときは、作らずに止まる', async () => {
    // ここで作ると、保存済みの Cookie が永久に復号できなくなる。
    // 「気づかないまま壊れる」より「止まって人に気づかせる」を選ぶ。
    const KV = fakeKv();
    const r = await ensureMasterKey({ KV }, true);
    expect(r).toEqual({ ok: false, reason: 'would_break_existing' });
    expect(KV.store[MASTER_KEY_KV]).toBeUndefined();
  });

  it('KV が使えないときは、その旨を返す（黙って進まない）', async () => {
    const KV = { get: async () => null, put: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    const r = await ensureMasterKey({ KV }, false);
    expect(r).toEqual({ ok: false, reason: 'kv_unavailable' });
  });

  it('★2回続けて呼んでも、鍵は変わらない', async () => {
    const KV = fakeKv();
    await ensureMasterKey({ KV }, false);
    const first = KV.store[MASTER_KEY_KV];
    await ensureMasterKey({ KV }, false);
    expect(KV.store[MASTER_KEY_KV]).toBe(first);
  });
});
