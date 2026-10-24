import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { COMMANDS } from '../../src/adapters/line/commands';
import { normalizeCommand } from '../../src/adapters/line/mode';
import { MENU_IMAGE_FILES, menuImageUrl } from '../../src/core/line/richmenu';

// リッチメニューは配布する全員で同じものを使う。
// ★画像・ボタンの定義・コマンド判定の3つがずれると、
//   「押しても無反応」になる。しかも押した人にしか分からない。
//   ここでずれを止める。

const menu = JSON.parse(readFileSync(new URL('../../assets/richmenu.json', import.meta.url), 'utf8'));
// ★いまのコードが使う画像は版付きの名前（v2）。旧名は古いコードのために旧デザインのまま残す
const image = readFileSync(new URL('../../assets/richmenu-v2.png', import.meta.url));
const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

describe('リッチメニューの定義', () => {
  it('LINE が受け付けるサイズになっている', () => {
    // 2500x1686 は LINE の規定サイズのひとつ（ラージ・6区画）
    expect(menu.size).toEqual({ width: 2500, height: 1686 });
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

  it('ボタンが6つある（3列×2段）', () => {
    expect(menu.areas).toHaveLength(6);
  });

  it('★ボタンが画像を隙間なく6等分している', () => {
    // 段ごとに、左から隙間なく右端まで覆っていること
    for (const y of [0, 843]) {
      const row = menu.areas.filter((a: { bounds: { y: number } }) => a.bounds.y === y)
        .sort((a: { bounds: { x: number } }, b: { bounds: { x: number } }) => a.bounds.x - b.bounds.x);
      expect(row, `y=${y} の段に3つ`).toHaveLength(3);
      let expectedX = 0;
      for (const area of row) {
        expect(area.bounds.x, '前のボタンと隙間なく続いていること').toBe(expectedX);
        expect(area.bounds.height).toBe(843);
        expectedX += area.bounds.width;
      }
      expect(expectedX, '右端まで覆っていること').toBe(menu.size.width);
    }
  });
});

describe('★画像の版（Public の main から取るため、新旧を別の名前で並べる）', () => {
  // 2026-10 P4-2 源蔵レビュー必須1:
  //   同じ名前のまま中身を差し替えると、新しいコードと古い画像（または逆）の組み合わせで
  //   LINE に断られ、画像の無いメニューが残る。
  it('★Worker が取りに行く URL は v2 の名前', () => {
    expect(MENU_IMAGE_FILES.normal).toBe('richmenu-v2.png');
    expect(MENU_IMAGE_FILES.setup).toBe('richmenu-setup-v2.png');
    expect(menuImageUrl('normal')).toBe('https://raw.githubusercontent.com/e-pei/note-line-poster-template/main/assets/richmenu-v2.png');
    expect(menuImageUrl('setup')).toBe('https://raw.githubusercontent.com/e-pei/note-line-poster-template/main/assets/richmenu-setup-v2.png');
  });

  it('★URL が指すファイルが手元の assets にある（配布物にそのまま入る）', () => {
    for (const name of Object.values(MENU_IMAGE_FILES)) {
      expect(existsSync(new URL(`../../assets/${name}`, import.meta.url)), `assets/${name}`).toBe(true);
    }
  });

  it('★旧名の通常メニュー画像は旧デザイン（2500×843・3ボタン）のまま残っている', () => {
    // 古いコードは richmenu.png を 2500×843 の定義に載せる。新しい画像で上書きすると、
    // まだ更新していない環境のメニュー作り直しが壊れる
    const old = readFileSync(new URL('../../assets/richmenu.png', import.meta.url));
    expect(pngSize(old)).toEqual({ width: 2500, height: 843 });
    expect(old.length).toBeLessThan(1024 * 1024);
    expect(old.equals(image), '旧名の画像が v2 と同じ中身になっている').toBe(false);
  });
});

describe('★ボタンの文言とコマンド判定が噛み合っている', () => {
  // どのボタンが、どの機能に繋がるべきか。画像の並び（左→中→右）と同じ順。
  const expected: Array<{ x: number; y: number; command: keyof typeof COMMANDS; label: string }> = [
    { x: 0, y: 0, command: 'newArticle', label: '記事を作る（上段左）' },
    { x: 833, y: 0, command: 'articleList', label: '過去記事（上段中央）' },
    { x: 1667, y: 0, command: 'knowledge', label: 'ナレッジ（上段右）' },
    { x: 0, y: 843, command: 'aiSettings', label: 'AI設定（下段左）' },
    { x: 833, y: 843, command: 'settings', label: '投稿設定（下段中央）' },
    { x: 1667, y: 843, command: 'moreSettings', label: 'その他（下段右）' },
  ];

  for (const { x, y, command, label } of expected) {
    it(`${label} が反応する`, () => {
      const area = menu.areas.find((a: { bounds: { x: number; y: number } }) => a.bounds.x === x && a.bounds.y === y);
      expect(area, `x=${x}, y=${y} のボタンが定義されていること`).toBeTruthy();

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
