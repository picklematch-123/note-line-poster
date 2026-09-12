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

// ── 投稿する場所の表示 ────────────────────────────────
/**
 * ★2026-09-12 に見つかった不具合:
 *   拡張は「連携済みかどうか」だけを見て、
 *   **いつでも「このパソコンから投稿します」「ログイン情報はサーバーに保存されません」**
 *   と表示していた。既定がサーバー投稿に変わった（2026-08-29）あとも直していなかった。
 *
 *   ★とくに後者は**事実と逆**だった。サーバー投稿ではログイン情報を
 *   （暗号化して）保存している。顧客に嘘の説明を見せていたことになる。
 *
 *   投稿する場所は LINE の「投稿設定」でいつでも変わるので、
 *   **覚えている値ではなくサーバーに聞く**。聞けなければ、どちらとも書かない。
 */
describe('投稿する場所の表示', () => {
  /** popup.js を隔離して動かし、画面に出た文字を読む */
  async function render({ mode, linked = true, offline = false }:
    { mode?: string; linked?: boolean; offline?: boolean }) {
    const vm = await import('node:vm');
    const els: Record<string, any> = {};
    const mk = () => ({
      textContent: '', className: '', value: '', hidden: true,
      addEventListener() {}, focus() {},
    });

    const ctx: any = {
      document: { getElementById: (id: string) => (els[id] ??= mk()) },
      chrome: {
        storage: { local: {
          get: async () => linked
            ? { deviceToken: 't', urlname: 'someone', endpoint: 'https://w.example.workers.dev' }
            : { endpoint: 'https://w.example.workers.dev' },
          set: async () => {},
        } },
        runtime: { sendMessage: async () => {} },
        cookies: { getAll: async () => [] },
        permissions: { request: async () => true },
        tabs: { create() {} },
      },
      fetch: async () => {
        if (offline) throw new Error('つながらない');
        return { ok: true, json: async () => ({ ok: true, checks: { execution_mode: mode } }) };
      },
      navigator: { userAgent: 'test' },
      console: { error() {}, warn() {}, log() {} },
      setTimeout, URL,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(popup, ctx);

    await ctx.showLinkState();
    return { text: els['link-text'].textContent as string,
             footer: els['footer-note'].textContent as string };
  }

  it('★サーバー投稿のときは、パソコン依存だと書かない', async () => {
    const { text, footer } = await render({ mode: 'server' });
    expect(text).toContain('サーバーから投稿します');
    expect(text).not.toContain('このパソコンから投稿します');
    expect(footer).toContain('閉じていても投稿されます');
    // ★ここがいちばん大事。保存しているのに「保存されません」と書かないこと
    expect(footer).not.toContain('保存されません');
  });

  it('パソコン投稿のときだけ、そう書く', async () => {
    const { text, footer } = await render({ mode: 'agent' });
    expect(text).toContain('このパソコンから投稿します');
    expect(footer).toContain('保存されません');
  });

  it('★サーバーに聞けないときは、どちらとも書かない', async () => {
    const { text, footer } = await render({ offline: true });
    expect(text).toContain('連携済み');
    expect(text).not.toContain('このパソコンから投稿します');
    expect(text).not.toContain('サーバーから投稿します');
    expect(footer).not.toContain('保存されません');
    expect(footer).toContain('投稿設定');
  });

  it('未連携のときの案内は変えていない', async () => {
    const { text, footer } = await render({ linked: false });
    expect(text).toContain('未連携');
    expect(footer).toContain('パスワードは読み取りません');
  });
});
