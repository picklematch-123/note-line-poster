/**
 * 拡張機能に渡す仕事の受け渡し。
 *
 * ★設計の要点:
 *   ・端末トークンは平文で持たない（ハッシュだけ保存する）
 *   ・仕事は1件ずつ貸し出す（lease）。拾った拡張が落ちても、期限が切れれば別の端末へ回る
 *   ・同じ記事の仕事を二重に積まない（押し間違いで2回投稿されるのを防ぐ）
 */
import type { AgentPlan } from './plan';
import { newId, newToken } from '../../lib/id';
import { nowIso, addSeconds } from '../../lib/time';

/** 貸出期限。これを過ぎたら別の端末が拾える。 */
export const LEASE_SEC = 180;
/** 「拡張がいま動いている」とみなす猶予。 */
export const DEVICE_ONLINE_SEC = 300;

export type JobKind = 'publish' | 'draft';
export type JobState = 'pending' | 'leased' | 'done' | 'failed';

export interface AgentJob {
  id: string;
  tenant_id: string;
  article_id: string;
  kind: JobKind;
  plan_json: string;
  state: JobState;
  attempts: number;
}

export interface DeviceIdentity {
  deviceId: string;
  tenantId: string;
  noteUrlname: string | null;
}

/** トークンは保存しない。照合できる形にだけ変えて持つ。 */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 端末トークンを発行する（連携が成立したときに1回だけ）。
 * ★戻り値の token はこの瞬間しか手に入らない。保存するのは呼び出し側の責任。
 */
export async function issueDeviceToken(
  d1: D1Database, tenantId: string, opts: { label?: string; noteUrlname?: string } = {},
): Promise<{ token: string; deviceId: string }> {
  const token = newToken(32);
  const deviceId = newId();
  await d1
    .prepare(
      `INSERT INTO agent_devices (id, tenant_id, token_hash, label, note_urlname, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(deviceId, tenantId, await hashToken(token), opts.label ?? null,
          opts.noteUrlname ?? null, nowIso(), nowIso())
    .run();
  return { token, deviceId };
}

/** 名乗ってきた端末を確かめる。合っていれば最終接続時刻を更新する。 */
export async function authenticateDevice(d1: D1Database, token: string): Promise<DeviceIdentity | null> {
  if (!token || token.length < 32) return null;
  const row = await d1
    .prepare(
      `SELECT id, tenant_id, note_urlname FROM agent_devices
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await hashToken(token))
    .first<{ id: string; tenant_id: string; note_urlname: string | null }>();
  if (!row) return null;

  await d1.prepare('UPDATE agent_devices SET last_seen_at = ? WHERE id = ?')
    .bind(nowIso(), row.id).run();
  return { deviceId: row.id, tenantId: row.tenant_id, noteUrlname: row.note_urlname };
}

/** そのテナントの拡張が、いま動いていそうか。 */
export async function isAgentOnline(d1: D1Database, tenantId: string): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT last_seen_at FROM agent_devices
        WHERE tenant_id = ? AND revoked_at IS NULL
        ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ last_seen_at: string | null }>();
  if (!row?.last_seen_at) return false;
  return Date.now() - new Date(row.last_seen_at).getTime() < DEVICE_ONLINE_SEC * 1000;
}

/** 連携済みの端末があるか（オンラインかどうかは問わない）。 */
export async function hasDevice(d1: D1Database, tenantId: string): Promise<boolean> {
  const row = await d1
    .prepare('SELECT COUNT(*) AS n FROM agent_devices WHERE tenant_id = ? AND revoked_at IS NULL')
    .bind(tenantId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/** 端末を無効にする（連携解除）。 */
export async function revokeDevices(d1: D1Database, tenantId: string): Promise<number> {
  const res = await d1
    .prepare('UPDATE agent_devices SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL')
    .bind(nowIso(), tenantId)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * 仕事を積む。
 * ★同じ記事の未完了の仕事があれば積み直さない（二重投稿を防ぐ）。
 */
export async function enqueueJob(
  d1: D1Database, tenantId: string, articleId: string, kind: JobKind, plan: AgentPlan,
): Promise<string> {
  const existing = await d1
    .prepare(`SELECT id FROM agent_jobs WHERE article_id = ? AND state IN ('pending','leased')`)
    .bind(articleId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = newId();
  const now = nowIso();
  await d1
    .prepare(
      `INSERT INTO agent_jobs (id, tenant_id, article_id, kind, plan_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, tenantId, articleId, kind, JSON.stringify(plan), now, now)
    .run();
  return id;
}

/**
 * 次の仕事を1件だけ貸し出す。
 * 貸出期限を過ぎたものは、拾った端末が落ちたとみなして回収する。
 */
export async function leaseNextJob(
  d1: D1Database, tenantId: string, deviceId: string,
): Promise<AgentJob | null> {
  const now = nowIso();
  const row = await d1
    .prepare(
      `SELECT id, tenant_id, article_id, kind, plan_json, state, attempts
         FROM agent_jobs
        WHERE tenant_id = ?
          AND (state = 'pending' OR (state = 'leased' AND lease_until < ?))
        ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(tenantId, now)
    .first<AgentJob>();
  if (!row) return null;

  // ★取り合いにならないよう、状態を見ながら1件だけ確保する
  const claimed = await d1
    .prepare(
      `UPDATE agent_jobs
          SET state = 'leased', device_id = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND (state = 'pending' OR (state = 'leased' AND lease_until < ?))`,
    )
    .bind(deviceId, addSeconds(now, LEASE_SEC), now, row.id, now)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return null;

  return { ...row, state: 'leased', attempts: row.attempts + 1 };
}

export async function getJob(d1: D1Database, jobId: string): Promise<(AgentJob & { device_id: string | null }) | null> {
  return d1
    .prepare(`SELECT id, tenant_id, article_id, kind, plan_json, state, attempts, device_id
                FROM agent_jobs WHERE id = ?`)
    .bind(jobId)
    .first<AgentJob & { device_id: string | null }>();
}

export async function finishJob(
  d1: D1Database, jobId: string, outcome: { ok: boolean; result?: unknown; error?: string },
): Promise<void> {
  await d1
    .prepare(
      `UPDATE agent_jobs SET state = ?, result_json = ?, error_message = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      outcome.ok ? 'done' : 'failed',
      outcome.result !== undefined ? JSON.stringify(outcome.result) : null,
      outcome.error?.slice(0, 500) ?? null,
      nowIso(),
      jobId,
    )
    .run();
}

/** 記事に紐づく未完了の仕事を取り消す（「やめる」を押したとき）。 */
export async function cancelJobsForArticle(d1: D1Database, articleId: string): Promise<void> {
  await d1
    .prepare(
      `UPDATE agent_jobs SET state = 'failed', error_message = 'ユーザーが取り消しました', updated_at = ?
        WHERE article_id = ? AND state IN ('pending','leased')`,
    )
    .bind(nowIso(), articleId)
    .run();
}

/** 待っている仕事の件数。 */
export async function pendingJobCount(d1: D1Database, tenantId: string): Promise<number> {
  const row = await d1
    .prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE tenant_id = ? AND state IN ('pending','leased')`)
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
