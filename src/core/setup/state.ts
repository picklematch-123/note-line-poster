/**
 * セットアップ画面（/setup）を、誰がいつ実行してよいかを決める。
 *
 * ★源蔵レビュー（2026-08-31）の条件3:
 *   「書き込み系は初回成功後はワンタイムコード必須」。
 *
 * ★なぜ初回だけ無認証でよいか:
 *   配備した直後は LINE がまだ繋がっておらず、コードを受け取る手段が無い。
 *   ここでコードを要求すると、誰もセットアップできなくなる。
 *   一度成功すれば LINE が繋がるので、以後はコードを配れる。
 *
 * ★なぜ note 連携のコードを使い回さないか:
 *   用途が違うコードが互いに通ると、片方を手に入れた人が
 *   もう片方もできてしまう。**接頭辞を分けて別物にする。**
 */
import { generateCode, normalizeCode, formatCode, CODE_LENGTH } from '../session/pairing';
import { nowIso, addSeconds } from '../../lib/time';

/** セットアップが一度でも成功したかの目印 */
export const SETUP_DONE_KV = 'setup:completed_at';

/** セットアップ用コードの置き場所（note 連携の `pair:` とは別物） */
const codeKey = (code: string) => `setupcode:${code}`;

/** コードの有効時間。手元で貼るだけなので短くてよい */
export const SETUP_CODE_TTL_SEC = 600;

export async function isSetupCompleted(kv: KVNamespace): Promise<boolean> {
  try {
    return !!(await kv.get(SETUP_DONE_KV));
  } catch {
    // ★読めないときは「未完了」ではなく「完了済み」に倒す。
    //   間違えて無認証で通すより、いったん止まるほうが安全
    return true;
  }
}

export async function markSetupCompleted(kv: KVNamespace): Promise<void> {
  await kv.put(SETUP_DONE_KV, nowIso());
}

export interface IssuedSetupCode {
  display: string;
  expiresAt: string;
}

/** セットアップ用の使い捨てコードを発行する（LINE から持ち主だけが呼ぶ） */
export async function issueSetupCode(kv: KVNamespace): Promise<IssuedSetupCode> {
  const code = generateCode();
  const issuedAt = nowIso();
  await kv.put(codeKey(code), issuedAt, { expirationTtl: SETUP_CODE_TTL_SEC });
  return { display: formatCode(code), expiresAt: addSeconds(issuedAt, SETUP_CODE_TTL_SEC) };
}

/** コードを使う。使えたら即座に消す（1回きり） */
export async function consumeSetupCode(kv: KVNamespace, input: string): Promise<boolean> {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) return false;

  const found = await kv.get(codeKey(code));
  if (!found) return false;
  await kv.delete(codeKey(code));
  return true;
}

export type RunPermission =
  | { allowed: true; reason: 'first_run' | 'valid_code' }
  | { allowed: false; reason: 'code_required' | 'code_invalid' };

/**
 * いま書き込みを実行してよいか。
 *
 * @param code 画面で入力されたコード（初回は空でよい）
 * @param alreadySetUp 印が無くても「もう設定済み」と分かっている場合に true。
 *   ★すでに稼働している環境（note と連携済みなど）を、
 *   印が無いというだけで無認証に開けてしまわないための逃さない口。
 */
export async function mayRun(
  kv: KVNamespace, code: string | null, alreadySetUp = false,
): Promise<RunPermission> {
  if (!alreadySetUp && !(await isSetupCompleted(kv))) return { allowed: true, reason: 'first_run' };

  if (!code?.trim()) return { allowed: false, reason: 'code_required' };
  return (await consumeSetupCode(kv, code))
    ? { allowed: true, reason: 'valid_code' }
    : { allowed: false, reason: 'code_invalid' };
}
