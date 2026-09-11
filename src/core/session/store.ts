/**
 * note セッションの保管庫（D1 + 暗号化）。
 *
 * ★Cookie は必ず暗号化して置く。MASTER_KEY_V1 が無いときは保存しない
 *   （平文で置くくらいなら連携を断る、という判断）。
 */
import type { NoteSession } from '../../ports/publisher/note/client';
import { seal, open, type Sealed } from '../tenant/crypto';
import { newId } from '../../lib/id';
import { nowIso, addSeconds } from '../../lib/time';
import { log } from '../../lib/mask';

/** note のセッション寿命の見立て（実測でおおよそ30日）。 */
export const SESSION_LIFETIME_SEC = 30 * 24 * 60 * 60;

export type SessionStatus = 'active' | 'expiring' | 'expired';

export interface StoredSession extends NoteSession {
  status: SessionStatus;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  connectedAt: string;
}

interface SecretRow {
  id: string;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  dek_iv: string;
  key_version: number;
}

interface SessionRow {
  id: string;
  note_urlname: string | null;
  cookies_ref: string;
  user_agent: string;
  status: SessionStatus;
  last_verified_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * 連携を保存する（既存があれば置き換える）。
 * 古い Cookie は残さない。持ち続ける理由が無く、残せば漏洩面積が増えるだけ。
 */
export async function saveNoteSession(
  d1: D1Database,
  tenantId: string,
  session: NoteSession,
  masterKey: string | undefined,
): Promise<void> {
  const sealed = await seal(session.cookieHeader, masterKey);
  const now = nowIso();
  const secretId = newId();

  const existing = await d1
    .prepare('SELECT id, cookies_ref FROM note_sessions WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ id: string; cookies_ref: string }>();

  const statements: D1PreparedStatement[] = [
    d1.prepare(
      `INSERT INTO tenant_secrets
         (id, tenant_id, kind, ciphertext, iv, wrapped_dek, dek_iv, key_version, last_4, created_at)
       VALUES (?, ?, 'note_cookies', ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(secretId, tenantId, sealed.ciphertext, sealed.iv, sealed.wrappedDek, sealed.dekIv, sealed.keyVersion, now),
  ];

  if (existing) {
    statements.push(
      d1.prepare(
        `UPDATE note_sessions
            SET note_urlname = ?, cookies_ref = ?, user_agent = ?, status = 'active',
                last_verified_at = ?, expires_at = ?, notified_at = NULL, updated_at = ?
          WHERE tenant_id = ?`,
      ).bind(session.urlname, secretId, session.userAgent, now, addSeconds(now, SESSION_LIFETIME_SEC), now, tenantId),
      d1.prepare('DELETE FROM tenant_secrets WHERE id = ?').bind(existing.cookies_ref),
    );
  } else {
    statements.push(
      d1.prepare(
        `INSERT INTO note_sessions
           (id, tenant_id, note_urlname, cookies_ref, user_agent, status,
            last_verified_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).bind(newId(), tenantId, session.urlname, secretId, session.userAgent, now,
             addSeconds(now, SESSION_LIFETIME_SEC), now, now),
    );
  }

  await d1.batch(statements);
  log.info('note セッションを保存しました', { tenantId, urlname: session.urlname });
}

/** 保存済みの連携を読む。無ければ null（呼び出し側が環境変数へ落ちる）。 */
export async function loadNoteSession(
  d1: D1Database,
  tenantId: string,
  masterKey: string | undefined,
): Promise<StoredSession | null> {
  const row = await d1
    .prepare(
      `SELECT id, note_urlname, cookies_ref, user_agent, status, last_verified_at, expires_at, created_at
         FROM note_sessions WHERE tenant_id = ?`,
    )
    .bind(tenantId)
    .first<SessionRow>();
  if (!row) return null;

  const secret = await d1
    .prepare('SELECT id, ciphertext, iv, wrapped_dek, dek_iv, key_version FROM tenant_secrets WHERE id = ?')
    .bind(row.cookies_ref)
    .first<SecretRow>();
  if (!secret) {
    log.warn('note セッションの暗号文が見つかりません', { tenantId });
    return null;
  }

  const sealed: Sealed = {
    ciphertext: String(secret.ciphertext),
    iv: String(secret.iv),
    wrappedDek: String(secret.wrapped_dek),
    dekIv: String(secret.dek_iv),
    keyVersion: secret.key_version,
  };

  let cookieHeader: string;
  try {
    cookieHeader = await open(sealed, masterKey);
  } catch (e) {
    // 鍵を入れ替えた・鍵が壊れた場合。黙って壊れた値を使わない
    log.error('note セッションの復号に失敗しました', String(e));
    return null;
  }

  return {
    cookieHeader,
    userAgent: row.user_agent,
    urlname: row.note_urlname ?? '',
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    expiresAt: row.expires_at,
    connectedAt: row.created_at,
  };
}

/**
 * note が再発行した Cookie で置き換える。
 * ★note はリクエストのたびにセッションを振り直すので、保存し直さないと
 *   実際より早く寿命が尽きたように見える。連携の持ちに直結する。
 */
export async function refreshCookieHeader(
  d1: D1Database, tenantId: string, cookieHeader: string, masterKey: string | undefined,
): Promise<void> {
  const row = await d1
    .prepare('SELECT cookies_ref FROM note_sessions WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ cookies_ref: string }>();
  if (!row) return;

  const sealed = await seal(cookieHeader, masterKey);
  const now = nowIso();
  await d1.batch([
    d1.prepare(
      `UPDATE tenant_secrets
          SET ciphertext = ?, iv = ?, wrapped_dek = ?, dek_iv = ?, key_version = ?, rotated_at = ?
        WHERE id = ?`,
    ).bind(sealed.ciphertext, sealed.iv, sealed.wrappedDek, sealed.dekIv, sealed.keyVersion, now, row.cookies_ref),
    d1.prepare(
      `UPDATE note_sessions SET last_verified_at = ?, status = 'active', updated_at = ? WHERE tenant_id = ?`,
    ).bind(now, now, tenantId),
  ]);
}

/** 死活監視の結果を書き戻す。 */
export async function markSessionStatus(
  d1: D1Database, tenantId: string, status: SessionStatus,
): Promise<void> {
  const now = nowIso();
  await d1
    .prepare(
      `UPDATE note_sessions
          SET status = ?, last_verified_at = CASE WHEN ? = 'active' THEN ? ELSE last_verified_at END,
              updated_at = ?
        WHERE tenant_id = ?`,
    )
    .bind(status, status, now, now, tenantId)
    .run();
}

/** 連携を解除する（Cookie を捨てる）。 */
export async function disconnectNoteSession(d1: D1Database, tenantId: string): Promise<boolean> {
  const row = await d1
    .prepare('SELECT cookies_ref FROM note_sessions WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ cookies_ref: string }>();
  if (!row) return false;

  await d1.batch([
    d1.prepare('DELETE FROM note_sessions WHERE tenant_id = ?').bind(tenantId),
    d1.prepare('DELETE FROM tenant_secrets WHERE id = ?').bind(row.cookies_ref),
  ]);
  return true;
}
