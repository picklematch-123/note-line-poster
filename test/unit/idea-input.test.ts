import { describe, expect, it } from 'vitest';
import { countIdeaGraphemes, validateIdeaLength } from '../../src/core/line/idea-input';

describe('記事ネタの入力長', () => {
  it('結合文字と絵文字を1文字として数え、3〜500文字だけ受け付ける', () => {
    expect(countIdeaGraphemes('e\u0301👨‍👩‍👧‍👦🇯🇵')).toBe(3);
    expect(validateIdeaLength('👨‍👩‍👧‍👦🇯🇵👍🏽')).toEqual({ valid: true, count: 3 });
    expect(validateIdeaLength('👨‍👩‍👧‍👦🇯🇵')).toEqual({ valid: false, count: 2 });
    expect(validateIdeaLength('👍🏽'.repeat(500))).toEqual({ valid: true, count: 500 });
    expect(validateIdeaLength('👍🏽'.repeat(501))).toEqual({ valid: false, count: 501 });
  });
});
