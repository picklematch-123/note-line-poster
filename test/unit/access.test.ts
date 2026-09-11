/**
 * 持ち主以外を締め出せているか。
 *
 * ★2026-08-31 源蔵レビューで判明した穴:
 *   公開・連携・設定には持ち主チェックがあったのに、
 *   **記事の生成とナレッジの書き込みには無かった。**
 *   友だち追加した第三者が、顧客の Claude の残高を燃やし、
 *   ナレッジを汚染できる状態だった。
 */
import { describe, it, expect } from 'vitest';
import { canUse, NOT_OWNER_MESSAGE } from '../../src/core/line/access';

describe('操作してよい人の判定', () => {
  it('持ち主なら通す', () => {
    expect(canUse('U_owner', 'U_owner')).toBe(true);
  });

  it('★持ち主以外は通さない', () => {
    expect(canUse('U_owner', 'U_stranger')).toBe(false);
  });

  it('★持ち主が決まっていなければ通す（最初の1人が持ち主になるため）', () => {
    // ここで止めると、誰も持ち主になれず永久に使えなくなる
    expect(canUse(null, 'U_first')).toBe(true);
    expect(canUse(undefined, 'U_first')).toBe(true);
    expect(canUse('', 'U_first')).toBe(true);
  });

  it('別人の空文字やゆらぎを通さない', () => {
    expect(canUse('U_owner', '')).toBe(false);
    expect(canUse('U_owner', 'u_owner')).toBe(false);   // 大文字小文字は別物
    expect(canUse('U_owner', 'U_owner ')).toBe(false);  // 前後の空白も別物
  });

  it('断り文句に、システムの中身を書かない', () => {
    // 余計な興味を持たせない。何が動いているかを教えない
    for (const word of ['note', 'Claude', 'AI', '記事', 'ナレッジ']) {
      expect(NOT_OWNER_MESSAGE).not.toContain(word);
    }
  });
});
