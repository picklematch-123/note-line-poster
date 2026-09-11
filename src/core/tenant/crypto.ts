/**
 * エンベロープ暗号化（AES-256-GCM）。
 *
 * ★note のセッション Cookie を D1 に置くための最低条件。
 *   平文で持つと、D1 のバックアップやダンプが流出しただけで
 *   顧客の note アカウントを他人が操作できる状態になる。
 *
 * 仕組み:
 *   平文 → DEK（毎回ランダムな32バイト鍵）で暗号化
 *   DEK  → KEK（環境変数 MASTER_KEY_V1）で暗号化して一緒に保存
 * 鍵を入れ替えるときは wrapped_dek だけ再暗号化すればよく、本体に触らずに済む。
 */

/** 暗号文と、それを開くのに必要な材料一式。すべて base64。 */
export interface Sealed {
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  dekIv: string;
  keyVersion: number;
}

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoConfigError';
  }
}

const IV_BYTES = 12;   // GCM の推奨値
const KEY_BYTES = 32;  // AES-256

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 新しいマスター鍵を作る（`wrangler secret put MASTER_KEY_V1` に貼る値）。 */
export function generateMasterKey(): string {
  const b = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(b);
  return toB64(b);
}

async function importKek(masterKey: string | undefined): Promise<CryptoKey> {
  if (!masterKey) {
    throw new CryptoConfigError(
      'MASTER_KEY_V1 が設定されていません。暗号化できないため、この操作は実行できません。',
    );
  }
  let raw: Uint8Array;
  try {
    raw = fromB64(masterKey.trim());
  } catch {
    throw new CryptoConfigError('MASTER_KEY_V1 が base64 ではありません。');
  }
  if (raw.length !== KEY_BYTES) {
    throw new CryptoConfigError(`MASTER_KEY_V1 は32バイトである必要があります（現在 ${raw.length} バイト）。`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** 平文をしまう。 */
export async function seal(plaintext: string, masterKey: string | undefined, keyVersion = 1): Promise<Sealed> {
  const kek = await importKek(masterKey);

  const dekRaw = randomBytes(KEY_BYTES);
  const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['encrypt']);

  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, dek, new TextEncoder().encode(plaintext));

  const dekIv = randomBytes(IV_BYTES);
  const wrappedDek = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dekIv }, kek, dekRaw);

  return {
    ciphertext: toB64(ciphertext),
    iv: toB64(iv),
    wrappedDek: toB64(wrappedDek),
    dekIv: toB64(dekIv),
    keyVersion,
  };
}

/** しまった平文を取り出す。鍵が違えば例外になる（黙って壊れたデータを返さない）。 */
export async function open(sealed: Sealed, masterKey: string | undefined): Promise<string> {
  const kek = await importKek(masterKey);

  const dekRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.dekIv) }, kek, fromB64(sealed.wrappedDek));
  const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['decrypt']);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv) }, dek, fromB64(sealed.ciphertext));
  return new TextDecoder().decode(plain);
}
