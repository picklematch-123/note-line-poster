/**
 * いま使う note セッションを1つ決める。
 *
 * ★入口（LINE / Cron / Workflow）は必ずここを通す。
 *   「どこから Cookie が来るか」を知っているのはこのファイルだけにする。
 *
 * 優先順位:
 *   1. 拡張機能で連携され、D1 に暗号化して保存されたもの（顧客の通常経路）
 *   2. 環境変数（Phase 1 の手動運用。最初の環境と緊急時の逃げ道として残す）
 */
import type { Env } from '../../env';
import type { NoteSession } from '../../ports/publisher/note/client';
import { loadNoteSession, refreshCookieHeader } from './store';
import { filterCookieHeader, hasSessionCookie, parseCookieHeader } from './cookies';
import { DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { log } from '../../lib/mask';
import { resolveMasterKey } from '../setup/masterkey';

export type SessionOrigin = 'extension' | 'env' | 'none';

export interface ResolvedSession {
  session: NoteSession;
  origin: SessionOrigin;
  /** 拡張機能で連携済みか（LINE の案内文を切り替えるのに使う） */
  connected: boolean;
}

/** 環境変数だけで組み立てた見た目上のセッション（未設定なら空文字になる）。 */
function fromEnv(env: Env): NoteSession {
  return {
    cookieHeader: env.NOTE_COOKIE ?? '',
    userAgent: env.NOTE_USER_AGENT ?? '',
    urlname: env.NOTE_URLNAME ?? '',
  };
}

export async function resolveNoteSession(
  env: Env, tenantId = DEFAULT_TENANT_ID,
): Promise<ResolvedSession> {
  try {
    const stored = await loadNoteSession(env.DB, tenantId, (await resolveMasterKey(env)).key);
    if (stored?.cookieHeader) {
      return {
        session: {
          cookieHeader: stored.cookieHeader,
          userAgent: stored.userAgent,
          // urlname は公開URLの組み立てに使う。取り漏れていたら環境変数で補う
          urlname: stored.urlname || env.NOTE_URLNAME || '',
        },
        origin: 'extension',
        connected: true,
      };
    }
  } catch (e) {
    // 保管庫が読めなくても、環境変数で動けるなら止めない
    log.warn('保存済み note セッションの読み出しに失敗', String(e));
  }

  const env_ = fromEnv(env);

  // ★agent モードでは Cookie を保存しないので note_sessions の行が無い。
  //   それでも投稿先のアカウント名（urlname）は要るので、端末の記録から拾う。
  if (!env_.urlname) {
    try {
      const row = await env.DB
        .prepare(`SELECT note_urlname FROM agent_devices
                   WHERE tenant_id = ? AND revoked_at IS NULL AND note_urlname IS NOT NULL
                   ORDER BY last_seen_at DESC LIMIT 1`)
        .bind(tenantId)
        .first<{ note_urlname: string | null }>();
      if (row?.note_urlname) env_.urlname = row.note_urlname;
    } catch (e) {
      log.warn('端末からの urlname 取得に失敗', String(e));
    }
  }

  return {
    session: env_,
    origin: env_.cookieHeader ? 'env' : 'none',
    connected: false,
  };
}

/**
 * note が振り直した Cookie を保存し直す。
 * 保存済みの連携があるときだけ意味を持つ（環境変数運用では何もしない）。
 */
export async function persistRefreshedCookie(
  env: Env, origin: SessionOrigin, cookieHeader: string, tenantId = DEFAULT_TENANT_ID,
): Promise<void> {
  if (origin !== 'extension' || !cookieHeader) return;
  const filtered = filterCookieHeader(cookieHeader);
  // ★セッション本体が落ちた状態で保存すると、次回から確実に投稿できなくなる。
  //   おかしければ保存せず、前の値のまま使い続けるほうが安全。
  if (!hasSessionCookie(parseCookieHeader(filtered))) {
    log.warn('更新後の Cookie にセッションが無いため保存を見送りました');
    return;
  }
  try {
    await refreshCookieHeader(env.DB, tenantId, filtered, (await resolveMasterKey(env)).key);
  } catch (e) {
    log.warn('note セッションの更新保存に失敗', String(e));
  }
}
