import { describe, it, expect } from 'vitest';
import { verifyLineSignature, signLineBody } from '../../src/adapters/line/signature';
import { extractJson } from '../../src/ports/llm/anthropic';
import { mask } from '../../src/lib/mask';

const SECRET = 'test_channel_secret_1234567890';
const BODY = JSON.stringify({ events: [{ type: 'message', message: { text: 'こんにちは' } }] });

describe('LINE 署名検証', () => {
  it('正しい署名を受け入れる', async () => {
    const sig = await signLineBody(BODY, SECRET);
    expect(await verifyLineSignature(BODY, sig, SECRET)).toBe(true);
  });

  it('★署名が無ければ拒否する', async () => {
    expect(await verifyLineSignature(BODY, null, SECRET)).toBe(false);
    expect(await verifyLineSignature(BODY, '', SECRET)).toBe(false);
  });

  it('★ボディが1文字でも改ざんされたら拒否する', async () => {
    const sig = await signLineBody(BODY, SECRET);
    expect(await verifyLineSignature(BODY + ' ', sig, SECRET)).toBe(false);
  });

  it('★シークレットが違えば拒否する', async () => {
    const sig = await signLineBody(BODY, SECRET);
    expect(await verifyLineSignature(BODY, sig, 'wrong_secret')).toBe(false);
  });

  it('シークレットが未設定なら拒否する', async () => {
    const sig = await signLineBody(BODY, SECRET);
    expect(await verifyLineSignature(BODY, sig, '')).toBe(false);
  });

  it('Base64 として壊れた署名でも例外を投げずに拒否する', async () => {
    expect(await verifyLineSignature(BODY, '!!!not-base64!!!', SECRET)).toBe(false);
  });

  it('長さの違う署名を拒否する', async () => {
    expect(await verifyLineSignature(BODY, btoa('short'), SECRET)).toBe(false);
  });
});

describe('extractJson', () => {
  it('素の JSON を読む', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('コードフェンス付きでも読む', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前置きが付いていても読む', () => {
    expect(extractJson('はい、結果です:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('JSON が無ければ null', () => {
    expect(extractJson('ただの文章')).toBeNull();
  });

  it('壊れた JSON なら null', () => {
    expect(extractJson('{"a":')).toBeNull();
  });
});

describe('mask（★秘密情報がログに出ないこと）', () => {
  it('note のセッション Cookie を伏せる', () => {
    // Cookie ヘッダごと伏せられる（値が残っていないことが要件）
    const out = mask('Cookie: _note_session_v5=abcdef123456; fp=xyz');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('***');
  });

  it('Cookie ヘッダの形でなくてもセッション値は伏せる', () => {
    const out = mask('session is _note_session_v5=abcdef123456 here');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('_note_session_v5=***');
  });

  it('Claude の API キーを伏せる', () => {
    const out = mask('key is sk-ant-api03-SECRETVALUE12345');
    expect(out).not.toContain('SECRETVALUE12345');
  });

  it('Bearer トークンを伏せる', () => {
    const out = mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('オブジェクト内のアクセストークンを伏せる', () => {
    const out = mask({ access_token: 'super_secret_token_value_12345', name: 'ok' });
    expect(out).not.toContain('super_secret_token_value_12345');
    expect(out).toContain('ok');
  });

  it('秘密でない文字列はそのまま残す', () => {
    expect(mask('記事を公開しました')).toBe('記事を公開しました');
  });
});
