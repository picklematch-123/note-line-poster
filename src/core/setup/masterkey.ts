/**
 * 暗号化のマスター鍵（KEK）を1か所で決める。
 *
 * ★なぜ必要になったか:
 *   ブラウザだけで配備できるようにした結果、Deploy 画面の入力欄は
 *   「書いた項目が全部必須」になる。顧客に32バイトのランダム値は作れないので、
 *   鍵を入力欄から外した。代わりに**配備後にこちらで作る**。
 *
 * ★置き場所は KV。D1（暗号文の置き場）とは別のストアなので、
 *   「D1 だけが漏れても復号できない」という性質は保たれる。
 *   ただし **Worker のシークレットよりは弱い**（KV は読み取り権限があれば読める）。
 *   環境変数に入っていれば、そちらを優先する。
 *
 * ★源蔵レビュー（2026-08-31）の条件:
 *   「既存があれば絶対に上書きしない」＋「連携済みなら生成そのものを拒否」。
 *   KV には排他制御が無いため、鍵を作り直すと
 *   **保存済みの note 連携が全部復号できなくなる**（顧客はつなぎ直しになる）。
 */
import { generateMasterKey } from '../tenant/crypto';
import { log } from '../../lib/mask';

/** KV に置くときのキー。他の用途と混ざらないよう専用の接頭辞を付ける。 */
export const MASTER_KEY_KV = 'secret:master_key_v1';

export type KeySource = 'env' | 'kv' | 'none';

export interface ResolvedMasterKey {
  key: string | undefined;
  source: KeySource;
}

/** いま使う鍵を決める。環境変数が最優先（既存の運用を壊さない）。 */
export async function resolveMasterKey(env: {
  MASTER_KEY_V1?: string; KV: KVNamespace;
}): Promise<ResolvedMasterKey> {
  const fromEnv = env.MASTER_KEY_V1?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };

  try {
    const fromKv = (await env.KV.get(MASTER_KEY_KV))?.trim();
    if (fromKv) return { key: fromKv, source: 'kv' };
  } catch (e) {
    log.warn('KV からマスター鍵を読めませんでした', String(e));
  }
  return { key: undefined, source: 'none' };
}

export type EnsureResult =
  | { ok: true; source: KeySource; created: boolean }
  /** 既に note と連携済みなのに鍵が見つからない。作ると復号できなくなるので作らない */
  | { ok: false; reason: 'would_break_existing' }
  | { ok: false; reason: 'kv_unavailable' };

/**
 * 鍵が無ければ作る。**あるものは絶対に書き換えない。**
 *
 * @param hasStoredSession 保存済みの note 連携があるか。
 *   ある状態で鍵が読めないなら、それは「鍵を失った」ということ。
 *   ここで新しい鍵を作ると、**保存済みの暗号文が永久に読めなくなる**。
 *   黙って作り直さず、人が気づける形で止める。
 */
export async function ensureMasterKey(
  env: { MASTER_KEY_V1?: string; KV: KVNamespace },
  hasStoredSession: boolean,
): Promise<EnsureResult> {
  const found = await resolveMasterKey(env);
  if (found.key) return { ok: true, source: found.source, created: false };

  if (hasStoredSession) {
    log.warn('鍵が見当たらないのに連携済みの記録があるため、鍵の作成を見送りました');
    return { ok: false, reason: 'would_break_existing' };
  }

  const fresh = generateMasterKey();
  try {
    await env.KV.put(MASTER_KEY_KV, fresh);
    // ★書いたあとに読み直す。同時に叩かれたときは、先に入ったほうを使う。
    //   KV に排他制御が無いので、これが「上書きしない」に一番近い形になる。
    const settled = (await env.KV.get(MASTER_KEY_KV))?.trim();
    if (settled && settled !== fresh) {
      log.warn('同時に鍵が作られたため、先に保存されたほうを使います');
    }
    return { ok: true, source: 'kv', created: true };
  } catch (e) {
    log.warn('KV に鍵を保存できませんでした', String(e));
    return { ok: false, reason: 'kv_unavailable' };
  }
}
