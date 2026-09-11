import { describe, it, expect } from 'vitest';
import {
  parse, parseHeadings, move, swap, remove, renumber, normalize, fill,
} from '../../src/core/article/placeholders';

const MD = [
  'リード文です。',
  '',
  '## 見出し1',
  '',
  '[画像1]',
  '',
  '本文A。',
  '',
  '## 見出し2',
  '',
  '本文B。',
  '',
  '## 見出し3',
  '',
  '[画像2]',
  '',
  '本文C。',
].join('\n');

describe('parseHeadings', () => {
  it('h2/h3 を行番号つきで拾う', () => {
    const h = parseHeadings(MD);
    expect(h.map((x) => x.text)).toEqual(['見出し1', '見出し2', '見出し3']);
    expect(h[0].level).toBe(2);
  });

  it('見出しが無ければ空配列', () => {
    expect(parseHeadings('ただの本文')).toEqual([]);
  });

  it('# (h1) は拾わない', () => {
    expect(parseHeadings('# タイトル')).toEqual([]);
  });
});

describe('parse', () => {
  it('プレースホルダを直前の見出しつきで拾う', () => {
    const p = parse(MD);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ index: 1, heading: '見出し1', headingIndex: 0 });
    expect(p[1]).toMatchObject({ index: 2, heading: '見出し3', headingIndex: 2 });
  });

  it('見出しより前にある画像は heading=null', () => {
    const p = parse('[画像1]\n\n## 見出し');
    expect(p[0].heading).toBeNull();
    expect(p[0].headingIndex).toBe(-1);
  });

  it('プレースホルダが無ければ空配列', () => {
    expect(parse('本文だけ')).toEqual([]);
  });
});

describe('move', () => {
  it('画像2 を見出し1（index 0）の下へ移動する', () => {
    const out = move(MD, 2, 0);
    const p = parse(out);
    expect(p.find((x) => x.index === 2)?.heading).toBe('見出し1');
    // 元の位置には残っていない
    expect(out.split('[画像2]')).toHaveLength(2);
  });

  it('画像1 を見出し2（index 1）の下へ移動する', () => {
    const out = move(MD, 1, 1);
    expect(parse(out).find((x) => x.index === 1)?.heading).toBe('見出し2');
  });

  it('範囲外の見出し番号は最後の見出しの下に置く', () => {
    const out = move(MD, 1, 99);
    expect(parse(out).find((x) => x.index === 1)?.heading).toBe('見出し3');
  });

  it('存在しない画像番号は例外', () => {
    expect(() => move(MD, 9, 0)).toThrow('[画像9] は本文にありません');
  });

  it('移動しても本文は失われない', () => {
    const out = move(MD, 2, 0);
    for (const t of ['リード文です。', '本文A。', '本文B。', '本文C。', '## 見出し2']) {
      expect(out).toContain(t);
    }
  });
});

describe('swap', () => {
  it('2つの位置が入れ替わる', () => {
    const out = swap(MD, 1, 2);
    const p = parse(out);
    expect(p.find((x) => x.index === 2)?.heading).toBe('見出し1');
    expect(p.find((x) => x.index === 1)?.heading).toBe('見出し3');
  });

  it('存在しない番号は例外', () => {
    expect(() => swap(MD, 1, 9)).toThrow();
  });
});

describe('remove', () => {
  it('指定した番号だけ消える', () => {
    const out = remove(MD, 1);
    expect(out).not.toContain('[画像1]');
    expect(out).toContain('[画像2]');
    expect(out).toContain('本文A。');
  });
});

describe('renumber', () => {
  it('出現順に振り直す', () => {
    expect(renumber('[画像5] あ [画像3] い [画像9]')).toBe('[画像1] あ [画像2] い [画像3]');
  });
});

describe('normalize', () => {
  it('画像が多いときは末尾の見出し下に足す', () => {
    const out = normalize(MD, 4);
    expect(parse(out).map((p) => p.index)).toEqual([1, 2, 3, 4]);
  });

  it('画像が少ないときは余分を削る', () => {
    const out = normalize(MD, 1);
    expect(parse(out).map((p) => p.index)).toEqual([1]);
  });

  it('枚数が一致しているならそのまま', () => {
    expect(parse(normalize(MD, 2)).map((p) => p.index)).toEqual([1, 2]);
  });

  it('画像0枚ならプレースホルダは全部消える', () => {
    expect(parse(normalize(MD, 0))).toEqual([]);
  });

  it('見出しが無い本文でも足せる', () => {
    const out = normalize('ただの本文', 2);
    expect(parse(out).map((p) => p.index)).toEqual([1, 2]);
  });
});

describe('fill', () => {
  it('URL を figure/img に差し替える', () => {
    const out = fill('[画像1]', { 1: 'https://example.com/a.png' });
    expect(out).toBe('<figure><img src="https://example.com/a.png"></figure>');
  });

  it('URL が無い番号は削除される', () => {
    expect(fill('あ[画像1]い', {})).toBe('あい');
  });

  it('alt テキストを入れる（note は alt を保持する）', () => {
    const out = fill('[画像1]', { 1: 'https://x/a.png' }, { '1': '焼き鳥屋の店内' });
    expect(out).toBe('<figure><img src="https://x/a.png" alt="焼き鳥屋の店内"></figure>');
  });

  it('alt が無ければ alt 属性を出さない', () => {
    expect(fill('[画像1]', { 1: 'a.png' })).not.toContain('alt=');
  });

  it('alt に引用符が入っても壊れない', () => {
    const out = fill('[画像1]', { 1: 'a.png' }, { '1': '"特製"のタレ & 炭火' });
    expect(out).toContain('alt="&quot;特製&quot;のタレ &amp; 炭火"');
  });

  it('複数を正しく差し替える', () => {
    const out = fill('[画像1]\n[画像2]', { 1: 'a.png', 2: 'b.png' });
    expect(out).toContain('src="a.png"');
    expect(out).toContain('src="b.png"');
  });
});
