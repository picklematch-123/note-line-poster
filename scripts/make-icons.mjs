/**
 * 拡張機能のアイコンを作る（PNG を直接書き出す。外部ライブラリなし）。
 *
 * 使い方: node scripts/make-icons.mjs
 * 出力:   extension/icons/icon{16,48,128}.png
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const ACCENT = [0x2c, 0xb6, 0x96];   // note を思わせる緑
const WHITE = [0xff, 0xff, 0xff];
const SS = 4;                         // スーパーサンプリング（縁のギザギザを消す）

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;  // フィルタなし
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // ビット深度
  ihdr[9] = 6;   // カラータイプ RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 角丸四角の内側か。 */
function inRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 「n」の字形の内側か（左の縦棒＋上のアーチ＋右の縦棒）。 */
function inGlyph(x, y, size) {
  const x0 = size * 0.31, x1 = size * 0.69;
  const yTop = size * 0.34, yBottom = size * 0.70;
  const w = size * 0.105;
  const cx = (x0 + x1) / 2;
  const R = (x1 - x0 - w) / 2;
  const cy = yTop + R;

  // 左の縦棒（全高）
  if (x >= x0 && x <= x0 + w && y >= yTop && y <= yBottom) return true;
  // 右の縦棒（アーチの下から）
  if (x >= x1 - w && x <= x1 && y >= cy && y <= yBottom) return true;
  // 上のアーチ
  if (y <= cy) {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= R - w / 2 && d <= R + w / 2) return true;
  }
  return false;
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const radius = size * 0.23;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!inRoundedRect(px, py, size, radius)) continue;
          bg++;
          if (inGlyph(px, py, size)) fg++;
        }
      }
      const total = SS * SS;
      const alpha = Math.round((bg / total) * 255);
      const mix = bg > 0 ? fg / bg : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round(ACCENT[c] * (1 - mix) + WHITE[c] * mix);
      }
      out[i + 3] = alpha;
    }
  }
  return encodePng(size, out);
}

mkdirSync('extension/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`extension/icons/icon${size}.png`, render(size));
  console.log(`extension/icons/icon${size}.png`);
}
