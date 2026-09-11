/**
 * 配布用の拡張機能をつくる。
 *
 *   node scripts/package-extension.mjs
 *
 * ★接続先は焼き込まない。**全員に同じ zip を配る。**
 *   顧客は拡張の設定画面で自分のURLを1回入れるだけ。
 *
 * ★なぜ焼き込みをやめたか（2026-08-30 実際に事故った）:
 *   `--url` に例文をそのまま渡しても**エラーにならず成功してしまう**ため、
 *   気づかないまま「繋がらない拡張」ができあがっていた。
 *   顧客ごとに作る工程そのものを無くせば、この間違いは起こらない。
 *
 *   アクセス許可は manifest の optional_host_permissions（workers.dev 配下）に置き、
 *   保存ボタンを押したときに**入力された1つの接続先だけ**を要求する。
 */
import { readFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'extension');
const OUT = resolve(ROOT, 'dist/note-connect');

if (process.argv.includes('--url')) {
  console.error('✗ --url は使わなくなりました。全員に同じ zip を配ります。');
  console.error('  接続先は、拡張を入れたあと「接続先の設定」から入力してください。');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

execFileSync('zip', ['-qr', 'note-connect.zip', 'note-connect', '-x', '*.DS_Store'], {
  cwd: resolve(ROOT, 'dist'),
});

// ★配りものに特定の環境が混ざっていないか、できあがったものを読み返して確かめる
const manifest = JSON.parse(readFileSync(resolve(OUT, 'manifest.json'), 'utf8'));
const baked = [
  ...manifest.host_permissions ?? [],
  readFileSync(resolve(OUT, 'background.js'), 'utf8'),
  readFileSync(resolve(OUT, 'popup.js'), 'utf8'),
].join('\n');

// ★探すのは「実在するホスト名の形をしたURL」だけ。
//   案内文に出てくる `〇〇.workers.dev` のような説明文には反応させない
const bakedUrl = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(baked);
if (bakedUrl) {
  console.error(`✗ 特定の接続先が混ざっています: ${bakedUrl[0]}`);
  console.error('  焼き込みは行わない方針です（全員に同じものを配ります）。');
  process.exit(1);
}

console.log('dist/note-connect.zip を作成しました（全員共通）');
console.log(`  version: ${manifest.version}`);
console.log(`  常に許可: ${(manifest.host_permissions ?? []).join(', ')}`);
console.log(`  必要時に許可: ${(manifest.optional_host_permissions ?? []).join(', ')}`);
