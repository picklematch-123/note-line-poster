import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { COMMANDS } from '../../src/adapters/line/commands';
import { normalizeCommand } from '../../src/adapters/line/mode';

// リッチメニューは配布する全員で同じものを使う。
// ★画像・ボタンの定義・コマンド判定の3つがずれると、
//   「押しても無反応」になる。しかも押した人にしか分からない。
//   ここでずれを止める。

const menu = JSON.parse(readFileSync(new URL('../../assets/richmenu.json', import.meta.url), 'utf8'));
const image = readFileSync(new URL('../../assets/richmenu.png', import.meta.url));

describe('リッチメニューの定義', () => {
  it('LINE が受け付けるサイズになっている', () => {
    // 2500x843 は LINE の規定サイズのひとつ（コンパクト）
    expect(menu.size).toEqual({ width: 2500, height: 843 });
  });

  it('★画像の大きさが定義と一致している', () => {
    // PNG のヘッダから幅と高さを読む（16バイト目から幅・高さが4バイトずつ）
    expect(image.subarray(1, 4).toString()).toBe('PNG');
    expect(image.readUInt32BE(16)).toBe(menu.size.width);
    expect(image.readUInt32BE(20)).toBe(menu.size.height);
  });

  it('★画像が LINE の上限（1MB）に収まっている', () => {
    expect(image.length).toBeLessThan(1024 * 1024);
  });

  it('ボタンが3つある', () => {
    expect(menu.areas).toHaveLength(3);
  });

  it('★ボタンが画像を隙間なく3等分している', () => {
    const sorted = [...menu.areas].sort((a, b) => a.bounds.x - b.bounds.x);
    let expectedX = 0;
    for (const area of sorted) {
      expect(area.bounds.x, '前のボタンと隙間なく続いていること').toBe(expectedX);
      expect(area.bounds.y).toBe(0);
      expect(area.bounds.height).toBe(menu.size.height);
      expectedX += area.bounds.width;
    }
    expect(expectedX, '右端まで覆っていること').toBe(menu.size.width);
  });
});

describe('★ボタンの文言とコマンド判定が噛み合っている', () => {
  // どのボタンが、どの機能に繋がるべきか。画像の並び（左→中→右）と同じ順。
  const expected: Array<{ x: number; command: keyof typeof COMMANDS; label: string }> = [
    { x: 0, command: 'newArticle', label: '記事作成（左）' },
    { x: 833, command: 'knowledge', label: 'ナレッジ（中央）' },
    { x: 1667, command: 'articleList', label: '過去記事一覧（右）' },
  ];

  for (const { x, command, label } of expected) {
    it(`${label} が反応する`, () => {
      const area = menu.areas.find((a: { bounds: { x: number } }) => a.bounds.x === x);
      expect(area, `x=${x} のボタンが定義されていること`).toBeTruthy();

      const sent = area.action.text as string;
      // 実際の経路と同じように、文字コードの揺れをならしてから判定する
      expect(COMMANDS[command].test(normalizeCommand(sent)),
        `「${sent}」が ${command} に届くこと`).toBe(true);
    });
  }

  it('★1つのボタンが複数の機能に反応しない', () => {
    for (const area of menu.areas) {
      const cmd = normalizeCommand(area.action.text);
      const hit = Object.entries(COMMANDS).filter(([, re]) => re.test(cmd)).map(([name]) => name);
      expect(hit, `「${area.action.text}」が反応する機能`).toHaveLength(1);
    }
  });

  it('★GUI で作り直しても効くよう、文字コードの揺れを吸収している', () => {
    // LINE公式アカウントマネージャーで入力すると、見た目が同じでも
    // 中黒や英数字の文字コードが変わることがある
    const variants: Record<string, string[]> = {
      '過去記事一覧・修正': ['過去記事一覧･修正', '過去記事一覧・修正', '過去記事一覧 ・ 修正'],
      '記事を作成する': ['記事を作成する', ' 記事を作成する '],
    };
    for (const [original, list] of Object.entries(variants)) {
      const area = menu.areas.find((a: { action: { text: string } }) => a.action.text === original);
      expect(area, `${original} のボタンがあること`).toBeTruthy();
      for (const v of list) {
        expect(normalizeCommand(v), `「${v}」がならされること`).toBe(normalizeCommand(original));
      }
    }
  });
});
