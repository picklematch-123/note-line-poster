/**
 * 連携コード（ペアリングコード）。
 *
 * 拡張機能から届いたリクエストが「本人のものか」を確かめるための唯一の手段。
 * ログイン画面もパスワードも作らずに済ませるため、次の形にしている:
 *
 *   1. LINE で「note連携」と送る（＝すでに本人確認済みの経路）
 *   2. Worker が使い捨てのコードを発行して LINE に返す
 *   3. 顧客が拡張機能にそのコードを貼る
 *   4. Worker はコードが合っていれば Cookie を受け取り、コードを即座に捨てる
 *
 * ★コードは1回きり・15分で消える・オーナーの LINE にしか出さない。
 */
import { nowIso, addSeconds } from '../../lib/time';

/** 使い捨てコードの寿命（秒）。貼り付けるだけなので短くてよい。 */
export const PAIRING_TTL_SEC = 900;

/**
 * 紛らわしい文字（0/O、1/I/l）を外した英数字。
 * LINE から手で打ち写す人がいる前提で選ぶ。
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;

export interface PairingRecord {
  tenantId: string;
  lineUserId: string;
  issuedAt: string;
}

export interface IssuedPairing {
  /** 表示用（XXXX-XXXX） */
  display: string;
  expiresAt: string;
}

/** 偏りのない乱数でコードを作る。 */
export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH * 2);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; out.length < CODE_LENGTH && i < bytes.length; i++) {
    // 剰余の偏りを避けるため、割り切れない値は捨てる
    if (bytes[i] >= 256 - (256 % ALPHABET.length)) continue;
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.padEnd(CODE_LENGTH, ALPHABET[0]);
}

/**
 * 入力されたコードをならす。
 * 顧客はハイフン付きで見ているので、貼り方の揺れ（空白・小文字・全角）を吸収する。
 */
export function normalizeCode(input: string): string {
  return input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/** 見せる形にする。 */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const key = (code: string) => `pair:${code}`;

/** コードを発行して KV に置く。 */
export async function issuePairingCode(
  kv: KVNamespace, tenantId: string, lineUserId: string,
): Promise<IssuedPairing> {
  const code = generateCode();
  const record: PairingRecord = { tenantId, lineUserId, issuedAt: nowIso() };
  await kv.put(key(code), JSON.stringify(record), { expirationTtl: PAIRING_TTL_SEC });
  return {
    display: formatCode(code),
    expiresAt: addSeconds(record.issuedAt, PAIRING_TTL_SEC),
  };
}

/**
 * コードを使う。使えたら即座に消す（1回きり）。
 * ★消してから処理する。「Cookie の検証に失敗したのでコードは残す」にすると、
 *   総当たりの手がかりを渡すことになる。
 */
export async function consumePairingCode(
  kv: KVNamespace, input: string,
): Promise<PairingRecord | null> {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) return null;

  const raw = await kv.get(key(code));
  if (!raw) return null;
  await kv.delete(key(code));

  try {
    return JSON.parse(raw) as PairingRecord;
  } catch {
    return null;
  }
}
