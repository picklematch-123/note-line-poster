/**
 * LINE Webhook の署名検証。
 *
 * ★これを通らないリクエストは絶対に処理しないこと。
 *   Webhook URL は推測可能なので、署名検証だけが「LINE から来た」ことの保証になる。
 *
 * @line/bot-sdk は Node 依存が重く Workers で不安定なため、Web Crypto で自前実装する。
 */

/** タイミング攻撃を避けるための定数時間比較。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * X-Line-Signature を検証する。
 * @param body リクエストボディの生文字列（パース前のもの）
 * @param signature X-Line-Signature ヘッダの値（Base64）
 * @param channelSecret チャネルシークレット
 */
export async function verifyLineSignature(
  body: string,
  signature: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!signature || !channelSecret) return false;

  const expected = base64ToBytes(signature);
  if (!expected) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return timingSafeEqual(mac, expected);
}

/** テストやデバッグ用に署名を作る。 */
export async function signLineBody(body: string, channelSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
