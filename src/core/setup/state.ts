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

/**
 * コードを発行した人の立場（2026-10-27 V7）。
 * ★持ち主のリセット（/setup/reset-owner）は、持ち主が発行したコードでだけ通す（管理者は持ち主を外せない）
 */
export type SetupCodeIssuer = 'owner' | 'admin';

/**
 * セットアップ用の使い捨てコードを発行する（LINE から持ち主・管理者が呼ぶ）。
 * 値は `{"issuedAt": …, "issuer": "owner"|"admin"}`（V7 から。以前は発行時刻の文字列だけ）
 */
export async function issueSetupCode(kv: KVNamespace, issuer: SetupCodeIssuer = 'owner'): Promise<IssuedSetupCode> {
  const code = generateCode();
  const issuedAt = nowIso();
  await kv.put(codeKey(code), JSON.stringify({ issuedAt, issuer }), { expirationTtl: SETUP_CODE_TTL_SEC });
  return { display: formatCode(code), expiresAt: addSeconds(issuedAt, SETUP_CODE_TTL_SEC) };
}

/**
 * 保存された値から、発行した人の立場を読む。
 * ★立場の記録が無い古い形（発行時刻の文字列だけ）は「持ち主」として扱う。
 *   V7 より前は持ち主しかコードを出せなかったので事実と合う。しかも10分で消える
 */
export function issuerOf(stored: string): SetupCodeIssuer {
  try {
    const v = JSON.parse(stored) as { issuer?: unknown };
    if (v && typeof v === 'object') return v.issuer === 'admin' ? 'admin' : 'owner';
  } catch { /* 古い形（ISO の文字列） */ }
  return 'owner';
}

/** コードの立場を見る（消費しない）。無い・形が違えば null */
async function peekSetupCode(kv: KVNamespace, input: string): Promise<{ key: string; issuer: SetupCodeIssuer } | null> {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) return null;
  const found = await kv.get(codeKey(code));
  return found ? { key: codeKey(code), issuer: issuerOf(found) } : null;
}

/** コードを使う。使えたら即座に消す（1回きり） */
export async function consumeSetupCode(kv: KVNamespace, input: string): Promise<boolean> {
  const found = await peekSetupCode(kv, input);
  if (!found) return false;
  await kv.delete(found.key);
  return true;
}

export type RunPermission =
  /** issuer: 使ったコードを発行した人の立場（valid_code のときだけ）。監査ログの actor に使う */
  | { allowed: true; reason: 'first_run'; issuer?: undefined }
  | { allowed: true; reason: 'valid_code'; issuer: SetupCodeIssuer }
  | { allowed: false; reason: 'code_required' | 'code_invalid' | 'owner_code_required' };

/**
 * いま書き込みを実行してよいか。
 *
 * @param code 画面で入力されたコード（初回は空でよい）
 * @param alreadySetUp 印が無くても「もう設定済み」と分かっている場合に true。
 *   ★すでに稼働している環境（note と連携済みなど）を、
 *   印が無いというだけで無認証に開けてしまわないための逃さない口。
 * @param opts.ownerOnly true = 持ち主が発行したコードでだけ通す（持ち主のリセット）。
 *   管理者のコードなら owner_code_required で断り、**コードは消費しない**（管理者のコードを無駄にしない）
 */
export async function mayRun(
  kv: KVNamespace, code: string | null, alreadySetUp = false, opts: { ownerOnly?: boolean } = {},
): Promise<RunPermission> {
  if (!alreadySetUp && !(await isSetupCompleted(kv))) return { allowed: true, reason: 'first_run' };

  if (!code?.trim()) return { allowed: false, reason: 'code_required' };
  const found = await peekSetupCode(kv, code);
  if (!found) return { allowed: false, reason: 'code_invalid' };
  if (opts.ownerOnly && found.issuer !== 'owner') return { allowed: false, reason: 'owner_code_required' };
  await kv.delete(found.key);
  return { allowed: true, reason: 'valid_code', issuer: found.issuer };
}

/** /setup の書き込みを記録するときの actor（web:owner / web:admin / web:first_run） */
export function webActor(p: Extract<RunPermission, { allowed: true }>): string {
  return p.reason === 'first_run' ? 'web:first_run' : `web:${p.issuer}`;
}
