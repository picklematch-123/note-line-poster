import { describe, it, expect } from 'vitest';
import { seal, open, generateMasterKey, CryptoConfigError } from '../../src/core/tenant/crypto';
import {
  pickNoteCookies, buildCookieHeader, hasSessionCookie, isUsableUserAgent,
  filterCookieHeader, parseCookieHeader, SESSION_COOKIE,
} from '../../src/core/session/cookies';
import {
  generateCode, normalizeCode, formatCode, issuePairingCode, consumePairingCode,
} from '../../src/core/session/pairing';

// ── 暗号化 ────────────────────────────────────────────
describe('エンベロープ暗号化', () => {
  const key = generateMasterKey();
  const secret = `${SESSION_COOKIE}=abcdef0123456789; note_gql_auth_token=xyz`;

  it('しまったものを元通り取り出せる', async () => {
    const sealed = await seal(secret, key);
    expect(await open(sealed, key)).toBe(secret);
  });

  it('暗号文に平文が残っていない', async () => {
    const sealed = await seal(secret, key);
    const dump = JSON.stringify(sealed);
    expect(dump).not.toContain('abcdef0123456789');
    expect(dump).not.toContain(SESSION_COOKIE);
  });

  it('毎回ちがう暗号文になる（同じ平文でも）', async () => {
    const a = await seal(secret, key);
    const b = await seal(secret, key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('★鍵が違えば開けない（黙って壊れた値を返さない）', async () => {
    const sealed = await seal(secret, key);
    await expect(open(sealed, generateMasterKey())).rejects.toThrow();
  });

  it('★暗号文を書き換えたら開けない（改ざん検知）', async () => {
    const sealed = await seal(secret, key);
    const bytes = atob(sealed.ciphertext).split('');
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    await expect(open({ ...sealed, ciphertext: btoa(bytes.join('')) }, key)).rejects.toThrow();
  });

  it('★鍵が未設定なら暗号化を拒否する（平文で保存させない）', async () => {
    await expect(seal(secret, undefined)).rejects.toThrow(CryptoConfigError);
    await expect(seal(secret, '')).rejects.toThrow(CryptoConfigError);
  });

  it('鍵の長さが違えば理由の分かるエラーを出す', async () => {
    await expect(seal(secret, btoa('short'))).rejects.toThrow(/32バイト/);
    await expect(seal(secret, 'これはbase64ではない###')).rejects.toThrow(CryptoConfigError);
  });
});

// ── Cookie の組み立て ──────────────────────────────────
describe('拡張機能から届いた Cookie', () => {
  const session = { name: SESSION_COOKIE, value: 'sess-value', domain: '.note.com' };

  it('セッション本体を含むヘッダを組み立てる', () => {
    const header = buildCookieHeader([session, { name: 'note_locale', value: 'ja', domain: '.note.com' }]);
    expect(header).toContain(`${SESSION_COOKIE}=sess-value`);
    expect(header).toContain('note_locale=ja');
  });

  it('★計測系の Cookie は預からない', () => {
    const names = pickNoteCookies([
      session,
      { name: '_ga', value: 'x', domain: '.note.com' },
      { name: '_ga_ABC123', value: 'x', domain: '.note.com' },
      { name: '_gid', value: 'x', domain: '.note.com' },
      { name: '_fbp', value: 'x', domain: '.note.com' },
      { name: '_hjSessionUser', value: 'x', domain: '.note.com' },
      { name: 'OptanonConsent', value: 'x', domain: '.note.com' },
    ]).map((c) => c.name);

    expect(names).toEqual([SESSION_COOKIE]);
  });

  it('同名の Cookie は note.com 本体のものを優先する', () => {
    const picked = pickNoteCookies([
      { name: SESSION_COOKIE, value: 'apex', domain: 'note.com' },
      { name: SESSION_COOKIE, value: 'editor', domain: 'editor.note.com' },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].value).toBe('apex');
  });

  it('サブドメインしか無ければそれを使う', () => {
    const picked = pickNoteCookies([{ name: SESSION_COOKIE, value: 'sub', domain: 'editor.note.com' }]);
    expect(picked[0].value).toBe('sub');
  });

  it('★セッション本体が無ければ連携させない', () => {
    expect(hasSessionCookie([{ name: 'note_locale', value: 'ja' }])).toBe(false);
    expect(hasSessionCookie([{ name: SESSION_COOKIE, value: '' }])).toBe(false);
    expect(hasSessionCookie([session])).toBe(true);
  });

  it('壊れた要素が混ざっても落ちない', () => {
    const picked = pickNoteCookies([
      session,
      { name: '', value: 'x' },
      // @ts-expect-error 実際に届く可能性のある壊れた形
      { name: 'broken' },
      // @ts-expect-error 同上
      null,
    ]);
    expect(picked.map((c) => c.name)).toEqual([SESSION_COOKIE]);
  });

  it('User-Agent は空でも長すぎても受け付けない', () => {
    expect(isUsableUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140')).toBe(true);
    expect(isUsableUserAgent('')).toBe(false);
    expect(isUsableUserAgent('short')).toBe(false);
    expect(isUsableUserAgent('x'.repeat(513))).toBe(false);
    expect(isUsableUserAgent(undefined)).toBe(false);
  });
});

// ── 連携コード ────────────────────────────────────────
/** KV の最小の代役。TTL は検証しないので put/get/delete だけで足りる。 */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(k: string, v: string) { store.set(k, v); },
    async get(k: string) { return store.get(k) ?? null; },
    async delete(k: string) { store.delete(k); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('連携コード', () => {
  it('紛らわしい文字（0 O 1 I L）を含まない8文字', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    }
  });

  it('毎回ちがうコードになる', () => {
    const seen = new Set(Array.from({ length: 300 }, () => generateCode()));
    expect(seen.size).toBeGreaterThan(295);
  });

  it('貼り方の揺れ（小文字・全角・空白・ハイフン）を吸収する', () => {
    expect(normalizeCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeCode(' ABCD 2345 ')).toBe('ABCD2345');
    expect(normalizeCode('ＡＢＣＤ－２３４５')).toBe('ABCD2345');
  });

  it('表示はハイフン区切りにする', () => {
    expect(formatCode('ABCD2345')).toBe('ABCD-2345');
  });

  it('発行したコードで連携できる', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    const rec = await consumePairingCode(kv, display);
    expect(rec).toMatchObject({ tenantId: 'tenant_default', lineUserId: 'U_owner' });
  });

  it('★一度使ったコードは二度と使えない', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    expect(await consumePairingCode(kv, display)).not.toBeNull();
    expect(await consumePairingCode(kv, display)).toBeNull();
  });

  it('★合っていないコードは通さない', async () => {
    const kv = fakeKv();
    await issuePairingCode(kv, 'tenant_default', 'U_owner');
    expect(await consumePairingCode(kv, 'ZZZZ-9999')).toBeNull();
    expect(await consumePairingCode(kv, '')).toBeNull();
    expect(await consumePairingCode(kv, 'ABC')).toBeNull();
  });

  it('★失敗しても、他のコードは消えない', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    await consumePairingCode(kv, 'ZZZZ-9999');
    expect(await consumePairingCode(kv, display)).not.toBeNull();
  });

  it('ハイフン無しで打ち写しても通る', async () => {
    const kv = fakeKv();
    const { display } = await issuePairingCode(kv, 'tenant_default', 'U_owner');
    expect(await consumePairingCode(kv, display.replace('-', '').toLowerCase())).not.toBeNull();
  });
});

// ── 投稿のたびに note が振り直す Cookie ───────────────
describe('保存し直す Cookie のならし', () => {
  it('ヘッダ文字列を往復できる', () => {
    const header = `${SESSION_COOKIE}=abc; note_locale=ja`;
    expect(filterCookieHeader(header)).toBe(header);
    expect(parseCookieHeader(header).map((c) => c.name)).toEqual([SESSION_COOKIE, 'note_locale']);
  });

  it('★投稿のたびに計測系 Cookie を溜め込まない', () => {
    const grown = `${SESSION_COOKIE}=abc; _ga=1; _ga_XYZ=2; _hjSession=3; note_locale=ja`;
    expect(filterCookieHeader(grown)).toBe(`${SESSION_COOKIE}=abc; note_locale=ja`);
  });

  it('値に = が含まれていても壊さない（base64 の Cookie）', () => {
    const header = `${SESSION_COOKIE}=aGVsbG8=; other=x`;
    expect(parseCookieHeader(header)[0].value).toBe('aGVsbG8=');
    expect(filterCookieHeader(header)).toContain('aGVsbG8=');
  });

  it('★セッションが落ちたヘッダは、保存前に気づける', () => {
    expect(hasSessionCookie(parseCookieHeader('note_locale=ja; _ga=1'))).toBe(false);
    expect(hasSessionCookie(parseCookieHeader(`${SESSION_COOKIE}=abc`))).toBe(true);
  });

  it('空のヘッダでも落ちない', () => {
    expect(parseCookieHeader('')).toEqual([]);
    expect(filterCookieHeader('')).toBe('');
  });
});
