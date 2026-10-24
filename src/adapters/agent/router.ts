/**
 * 拡張機能（顧客のブラウザ）とのやり取り。
 *
 *   POST /agent/poll        仕事をひとつ受け取る
 *   POST /agent/result      実行結果を返す
 *   GET  /agent/asset/{id}  手順書で使う画像を取りに来る
 *
 * ★認証は端末トークン1本。連携時に発行し、ハッシュだけを保存している。
 * ★ここでは note を一切叩かない。叩くのは顧客のブラウザ。
 */
import { llmConfigFromEnv } from '../../ports/llm';
import { z } from 'zod';
import type { Env } from '../../env';
import { Db, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { KvImageStore } from '../../ports/storage/images';
import { authenticateDevice, leaseNextJob, getJob, finishJob } from '../../core/agent/jobs';
import { applyAgentSuccess, applyAgentFailure } from '../../core/agent/dispatch';
import { planAssetIds } from '../../core/agent/plan';
import type { ServiceDeps } from '../../core/article/service';
import { LineClient, text } from '../line/client';
import { log } from '../../lib/mask';

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin?.startsWith('chrome-extension://') ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

export function handleAgentPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

/** リクエストから端末トークンを取り出す（ヘッダ優先）。 */
function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ── 仕事を受け取る ───────────────────────────────────
export async function handleAgentPoll(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('origin');
  const device = await authenticateDevice(env.DB, bearer(req));
  if (!device) return json({ ok: false, message: '連携が切れています。LINE で「note連携」からやり直してください。' }, 401, origin);

  const job = await leaseNextJob(env.DB, device.tenantId, device.deviceId);
  if (!job) return json({ ok: true, job: null }, 200, origin);

  log.info('拡張へ仕事を渡しました', { jobId: job.id, kind: job.kind });
  return json({
    ok: true,
    job: { id: job.id, kind: job.kind, plan: JSON.parse(job.plan_json) },
  }, 200, origin);
}

// ── 実行結果を受け取る ───────────────────────────────
const ResultBody = z.object({
  jobId: z.string().min(1).max(64),
  ok: z.boolean(),
  vars: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  error: z.object({
    message: z.string().max(1000).optional(),
    status: z.number().optional(),
    code: z.string().max(64).optional(),
    stepId: z.string().max(64).optional(),
  }).optional(),
});

export async function handleAgentResult(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('origin');
  const device = await authenticateDevice(env.DB, bearer(req));
  if (!device) return json({ ok: false, message: '連携が切れています。' }, 401, origin);

  let body: z.infer<typeof ResultBody>;
  try {
    body = ResultBody.parse(await req.json());
  } catch {
    return json({ ok: false, message: '送信内容が正しくありません。' }, 400, origin);
  }

  const job = await getJob(env.DB, body.jobId);
  // ★他人の仕事の結果を書き込ませない
  if (!job || job.tenant_id !== device.tenantId) {
    return json({ ok: false, message: 'その仕事は見つかりません。' }, 404, origin);
  }
  if (job.state === 'done' || job.state === 'failed') {
    return json({ ok: true, message: 'すでに処理済みです。' }, 200, origin);
  }

  const db = new Db(env.DB);
  const deps = {
    db,
    llm: llmConfigFromEnv(env),
    noteSession: { cookieHeader: '', userAgent: '', urlname: device.noteUrlname ?? '' },
    ownerLineUserId: env.LINE_OWNER_USER_ID || (await db.getOwnerLineUserId(device.tenantId)),
    // ★投稿者が承認した記事も、拡張経由で出せるようにする
    staffLineUserIds: await db.listStaffIds(device.tenantId),
    images: new KvImageStore(env.KV),
  } satisfies ServiceDeps;

  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV);
  const owner = deps.ownerLineUserId;

  try {
    if (body.ok) {
      const done = await applyAgentSuccess(deps, job, body.vars ?? {}, device.noteUrlname);
      await finishJob(env.DB, job.id, { ok: true, result: { url: done.url, noteKey: done.editUrl } });
      if (owner) {
        await line.push(owner, [text(
          done.kind === 'publish'
            ? `${done.isUpdate ? '記事を更新しました' : '公開しました'}。\n${done.url}`
            : `note に下書きとして保存しました。公開はされていません。\n\n${done.editUrl}\n\n新しい記事を作れる状態になりました。`,
        )]).catch(() => {});
      }
      return json({ ok: true, url: done.url }, 200, origin);
    }

    const failure = await applyAgentFailure(deps, job, body.error ?? {});
    await finishJob(env.DB, job.id, { ok: false, error: body.error?.message });
    if (owner) await line.push(owner, [text(failure.userMessage)]).catch(() => {});
    return json({ ok: true }, 200, origin);
  } catch (e) {
    log.error('拡張の結果反映で例外', String(e));
    await finishJob(env.DB, job.id, { ok: false, error: String(e) });
    return json({ ok: false, message: '結果を保存できませんでした。' }, 500, origin);
  }
}

// ── 手順書で使う画像 ─────────────────────────────────
export async function handleAgentAsset(req: Request, env: Env, imageId: string): Promise<Response> {
  const origin = req.headers.get('origin');
  const device = await authenticateDevice(env.DB, bearer(req));
  if (!device) return json({ ok: false, message: '連携が切れています。' }, 401, origin);

  // ★自分のテナントの画像しか渡さない
  const row = await env.DB
    .prepare('SELECT id, tenant_id, r2_key, mime_type FROM images WHERE id = ?')
    .bind(imageId)
    .first<{ id: string; tenant_id: string; r2_key: string; mime_type: string }>();
  if (!row || row.tenant_id !== device.tenantId) {
    return json({ ok: false, message: '画像が見つかりません。' }, 404, origin);
  }

  // ★いま貸し出している手順書に出てくる画像だけを渡す（総当たりで抜かれないように）
  const allowed = await isAssetInLeasedJob(env, device.tenantId, imageId);
  if (!allowed) return json({ ok: false, message: 'この画像は対象外です。' }, 403, origin);

  const stored = await new KvImageStore(env.KV).get(row.r2_key);
  if (!stored) return json({ ok: false, message: '画像の実体がありません。' }, 404, origin);

  return new Response(stored.bytes, {
    status: 200,
    headers: {
      'Content-Type': stored.contentType || row.mime_type || 'image/png',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

async function isAssetInLeasedJob(env: Env, tenantId: string, imageId: string): Promise<boolean> {
  const rows = await env.DB
    .prepare(`SELECT plan_json FROM agent_jobs WHERE tenant_id = ? AND state = 'leased'`)
    .bind(tenantId)
    .all<{ plan_json: string }>();
  for (const r of rows.results ?? []) {
    try {
      if (planAssetIds(JSON.parse(r.plan_json)).includes(imageId)) return true;
    } catch { /* 壊れた手順書は無視 */ }
  }
  return false;
}

export { DEFAULT_TENANT_ID };
