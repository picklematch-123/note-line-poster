/**
 * 配布する拡張機能が「全員共通の1個」であることを固定する。
 *
 * ★2026-08-30 の事故:
 *   接続先を焼き込む方式だったため、例文の文字列をそのまま渡しても
 *   **エラーにならず成功**し、繋がらない拡張ができあがった。
 *   顧客ごとに作る工程そのものを無くして、間違えようが無いようにした。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}extension/manifest.json`, 'utf8'));
const popup = readFileSync(`${root}extension/popup.js`, 'utf8');
const background = readFileSync(`${root}extension/background.js`, 'utf8');
const packager = readFileSync(`${root}scripts/package-extension.mjs`, 'utf8');

describe('拡張機能の配布物', () => {
  it('★特定の接続先が焼き込まれていない', () => {
    const baked = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i;
    for (const [name, src] of [['popup.js', popup], ['background.js', background]] as const) {
      expect(baked.test(src), `${name} に接続先が埋まっている`).toBe(false);
    }
    expect(JSON.stringify(manifest.host_permissions)).not.toMatch(baked);
  });

  it('常に持つ許可は note だけ（Worker は含めない）', () => {
    expect(manifest.host_permissions).toEqual([
      'https://note.com/*',
      'https://*.note.com/*',
    ]);
  });

  it('★Worker への許可は「必要になったときだけ」もらう', () => {
    // 全サイトへの広い許可を最初から取らない。workers.dev 配下に限る
    expect(manifest.optional_host_permissions).toEqual(['https://*.workers.dev/*']);
    expect(JSON.stringify(manifest.optional_host_permissions)).not.toContain('https://*/*');
  });

  it('★保存ボタンで、その接続先だけの許可を求めている', () => {
    // 許可の要求は利用者の操作からしか出せない。保存ボタンの中にある必要がある
    expect(popup).toContain('chrome.permissions.request');
    expect(popup).toMatch(/new URL\(value\)\.origin/);
  });

  it('必要な権限が落ちていない', () => {
    for (const p of ['cookies', 'storage', 'alarms']) {
      expect(manifest.permissions).toContain(p);
    }
    expect(manifest.manifest_version).toBe(3);
  });

  it('★--url を渡す作り方は、もう受け付けない', () => {
    expect(packager).toContain("--url は使わなくなりました");
  });
});
