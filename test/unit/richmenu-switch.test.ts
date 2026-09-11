/**
 * メニューの出し分け。
 *
 * ★狙い（2026-08-31 運用側の判断）:
 *   セットアップ中は「セットアップ」「note連携」の2つだけ出し、
 *   note と繋がったら通常の3ボタンへ自動で切り替える。
 *   連携が切れたら、セットアップ用に戻す（押すだけで復旧できるように）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { menuFor } from '../../src/core/line/richmenu';
import setupMenu from '../../assets/richmenu-setup.json';
import normalMenu from '../../assets/richmenu.json';
import { COMMANDS } from '../../src/adapters/line/commands';

const root = new URL('../../', import.meta.url).pathname;
const setupImage = `${root}assets/richmenu-setup.png`;

describe('どちらのメニューを出すか', () => {
  it('note と繋がっていなければ、セットアップ用', () => {
    expect(menuFor(false)).toBe('setup');
  });

  it('繋がっていれば、通常', () => {
    expect(menuFor(true)).toBe('normal');
  });
});

describe('セットアップ用メニューの定義', () => {
  it('LINE が受け付けるサイズになっている', () => {
    expect(setupMenu.size).toEqual({ width: 2500, height: 843 });
  });

  it('ボタンが2つある', () => {
    expect(setupMenu.areas).toHaveLength(2);
  });

  it('★ボタンが画像を隙間なく2等分している', () => {
    const sorted = [...setupMenu.areas].sort((a, b) => a.bounds.x - b.bounds.x);
    let x = 0;
    for (const a of sorted) {
      expect(a.bounds.x, '隙間や重なりがある').toBe(x);
      expect(a.bounds.y).toBe(0);
      expect(a.bounds.height).toBe(setupMenu.size.height);
      x += a.bounds.width;
    }
    expect(x, '横幅を使い切っていない').toBe(setupMenu.size.width);
  });

  it('★通常メニューと名前が別物（片付けで取り違えない）', () => {
    expect(setupMenu.name).not.toBe(normalMenu.name);
  });

  for (const area of setupMenu.areas) {
    const label = area.action.text;
    it(`「${label}」が対応する機能に届く`, () => {
      const hit = Object.entries(COMMANDS).filter(([, re]) => re.test(label));
      expect(hit.length, `${label} に反応する機能が ${hit.length} 個`).toBe(1);
    });
  }
});

// ★画像はこれから用意する（オーナー が作成）。
//   置かれたら、この検査が自動的に効き始める。
describe.skipIf(!existsSync(setupImage))('セットアップ用メニューの画像', () => {
  it('★画像の大きさが定義と一致している', () => {
    const buf = readFileSync(setupImage);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect({ width, height }).toEqual(setupMenu.size);
  });

  it('★LINE の上限（1MB）に収まっている', () => {
    expect(statSync(setupImage).size).toBeLessThanOrEqual(1024 * 1024);
  });
});
