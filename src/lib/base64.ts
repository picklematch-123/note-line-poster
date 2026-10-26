/**
 * バイト列 → base64（画像を LLM の画像入力に渡すとき用）。
 * ★Workers には Buffer が無いので btoa を使う。大きい画像でも引数の上限に当たらないよう、少しずつ文字列にする
 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
