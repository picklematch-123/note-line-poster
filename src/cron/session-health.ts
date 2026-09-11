/**
 * note セッションの死活監視（毎日 09:00 JST）。
 *
 * 失効を先に検知して顧客に再接続を促す。
 * 「承認したのに投稿されず、数日後に気づく」を絶対に作らないための仕組み。
 */
import type { Env } from '../env';
import { NoteClient } from '../ports/publisher/note/client';
import { LineClient } from '../adapters/line/client';
import { Db, DEFAULT_TENANT_ID } from '../ports/storage/db';
import { resolveNoteSession, persistRefreshedCookie } from '../core/session/resolve';
import { markSessionStatus } from '../core/session/store';
import { buildSessionExpired } from '../adapters/line/messages/connect';
import { log } from '../lib/mask';
import { switchTo } from '../core/line/richmenu';

export async function sessionHealth(env: Env): Promise<void> {
  const db = new Db(env.DB);
  const { session, origin } = await resolveNoteSession(env);

  // そもそも一度も連携していないなら、毎朝せっつく意味がない
  if (origin === 'none') {
    log.info('note セッション未設定のため死活監視をスキップ');
    return;
  }

  const client = new NoteClient(session);
  const alive = await client.isAlive();
  log.info('note セッション死活監視', { alive, origin });
  await db.audit(DEFAULT_TENANT_ID, 'session.check', 'cron', null, alive ? 'ok' : 'error');

  if (origin === 'extension') {
    await markSessionStatus(env.DB, DEFAULT_TENANT_ID, alive ? 'active' : 'expired');
    // 生きているなら、note が振り直した Cookie を保存し直して寿命を無駄にしない
    if (alive) await persistRefreshedCookie(env, origin, client.latestCookieHeader);
  }

  const ownerId = env.LINE_OWNER_USER_ID || (await db.getOwnerLineUserId(DEFAULT_TENANT_ID));
  if (alive) return;

  // ★連携が切れたので、メニューを「セットアップ用」に戻す。
  //   「note連携」ボタンが出ていないと、顧客は毎回文字を打つことになる。
  //   押すだけで復旧できる状態を保つ（2026-08-31 運用側の判断）。
  //   ★通知の1日1回制限より前に置く。通知済みでもメニューは正しくしておきたい
  await switchTo(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV, 'setup');

  if (!ownerId) return;

  // ★同じ通知を毎朝送らない。1日1回に抑える
  if (await alreadyNotifiedToday(env)) return;
  await stampNotified(env);

  const waiting = await countAwaitingSession(env);
  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV);
  await line.push(ownerId, [buildSessionExpired(waiting)]);
}

async function countAwaitingSession(env: Env): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE tenant_id = ? AND state = 'awaiting_session'`)
    .bind(DEFAULT_TENANT_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function alreadyNotifiedToday(env: Env): Promise<boolean> {
  const row = await env.DB
    .prepare('SELECT notified_at FROM note_sessions WHERE tenant_id = ?')
    .bind(DEFAULT_TENANT_ID)
    .first<{ notified_at: string | null }>();
  if (!row?.notified_at) return false;
  return Date.now() - new Date(row.notified_at).getTime() < 20 * 60 * 60 * 1000;
}

async function stampNotified(env: Env): Promise<void> {
  await env.DB
    .prepare('UPDATE note_sessions SET notified_at = ? WHERE tenant_id = ?')
    .bind(new Date().toISOString(), DEFAULT_TENANT_ID)
    .run();
}
