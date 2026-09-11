/**
 * 「サーバーが叩くか、顧客のブラウザに叩かせるか」の分岐と、その結果の反映。
 *
 * ★ここが blast radius（1件の巻き添えがどこまで広がるか）を決める。
 *   agent なら note から見た出どころは顧客本人になり、影響はその1人に閉じる。
 *
 * ★既定は server（0008 の決定）。パソコンを開いていなくても投稿できることを優先した。
 *   1顧客 = 1環境で配るので、server でも Cookie・レート制限・障害は顧客ごとに独立する。
 *   ただし Workers の出口IPは Cloudflare の共有レンジで、環境を分けても分かれない。
 *   そこまで分けたい顧客だけが agent を選ぶ（LINE「投稿設定」→「投稿する場所」）。
 */
import type { ServiceDeps } from '../article/service';
import { NoteApiError } from '../../ports/publisher/note/client';
import { buildPlan } from './plan';
import { enqueueJob, isAgentOnline, hasDevice, cancelJobsForArticle, type AgentJob, type JobKind } from './jobs';
import { nowIso } from '../../lib/time';
import { log } from '../../lib/mask';

export type Dispatch =
  | { mode: 'server' }
  | { mode: 'agent'; jobId: string; online: boolean }
  /** agent なのに端末が1台も繋がっていない。連携をやり直してもらうしかない */
  | { mode: 'no_device' };

/**
 * 公開（または下書き保存）の実行先を決める。
 * ★ポリシー判定（承認ゲート・レート制限・緊急停止）は呼ぶ前に必ず通しておくこと。
 */
export async function dispatchPublish(
  deps: ServiceDeps, articleId: string, kind: JobKind,
): Promise<Dispatch> {
  const article = await deps.db.getArticle(articleId);
  if (!article) throw new Error('記事が見つかりません');

  const tenant = await deps.db.getTenant(article.tenant_id);
  if (tenant.execution_mode !== 'agent') return { mode: 'server' };

  const d1 = deps.db.raw;

  if (!(await hasDevice(d1, article.tenant_id))) {
    // 代行が許されているなら、サーバーで出す（既定では許されていない）
    if (tenant.agent_fallback) {
      log.warn('拡張が未連携のためサーバーで代行します', { articleId });
      return { mode: 'server' };
    }
    return { mode: 'no_device' };
  }

  const online = await isAgentOnline(d1, article.tenant_id);
  if (!online && tenant.agent_fallback) {
    log.warn('拡張が応答しないためサーバーで代行します', { articleId });
    return { mode: 'server' };
  }

  const plan = await buildPlan(deps, article, kind);
  const jobId = await enqueueJob(d1, article.tenant_id, articleId, kind, plan);
  await deps.db.setState(articleId, article.state, 'awaiting_agent', 'system', { jobId, kind });
  await deps.db.audit(article.tenant_id, 'agent.enqueued', 'system', articleId, 'ok', { kind, online });

  return { mode: 'agent', jobId, online };
}

/** 「やめる」で仕事も引き上げる。拡張が拾う前に消しておく。 */
export async function withdrawJobs(deps: ServiceDeps, articleId: string): Promise<void> {
  await cancelJobsForArticle(deps.db.raw, articleId);
}

export interface AgentSuccess {
  articleId: string;
  kind: JobKind;
  url: string | null;
  editUrl: string | null;
  isUpdate: boolean;
}

/**
 * 拡張が実行し終えた結果を記事に反映する。
 * ★note から読み戻せない情報（本文HTML・noteのID）は必ずここで保存する。
 */
export async function applyAgentSuccess(
  deps: ServiceDeps, job: AgentJob, vars: Record<string, unknown>, noteUrlname: string | null,
): Promise<AgentSuccess> {
  const article = await deps.db.getArticle(job.article_id);
  if (!article) throw new Error('記事が見つかりません');

  const noteId = String(vars.note_id ?? article.note_id ?? '');
  const noteKey = String(vars.note_key ?? article.note_key ?? '');
  if (!noteId || !noteKey) throw new Error('note の記事IDを受け取れませんでした');

  const isUpdate = Boolean(article.note_id && article.note_key);
  const plan = JSON.parse(job.plan_json) as { steps: Array<{ id: string; json?: { free_body?: string; body?: string } }> };
  // 拡張が差し替えた後の本文が正。手順書から取り出して保存する
  const finalHtml = renderFinalHtml(plan, vars);

  if (job.kind === 'publish') {
    const url = noteUrlname ? `https://note.com/${noteUrlname}/n/${noteKey}` : `https://note.com/n/${noteKey}`;
    await deps.db.updateArticle(job.article_id, {
      body_html: finalHtml,
      note_id: noteId,
      note_key: noteKey,
      note_url: url,
      published_at: nowIso(),
    });
    await deps.db.setState(job.article_id, article.state, 'published', 'agent', { url, isUpdate });
    // 上書き更新は投稿本数に数えない（note 上の記事は増えていない）
    if (!isUpdate) await deps.db.recordPublish(article.tenant_id, job.article_id);
    await deps.db.audit(article.tenant_id, isUpdate ? 'publish.updated' : 'publish.ok', 'agent', job.article_id, 'ok', { url });
    log.info('拡張経由で note へ公開しました', { articleId: job.article_id, url });
    return { articleId: job.article_id, kind: job.kind, url, editUrl: null, isUpdate };
  }

  await deps.db.updateArticle(job.article_id, {
    body_html: finalHtml, note_id: noteId, note_key: noteKey,
  });
  await deps.db.setState(job.article_id, article.state, 'drafted', 'agent');
  await deps.db.audit(article.tenant_id, 'draft.saved', 'agent', job.article_id, 'ok');
  return {
    articleId: job.article_id, kind: job.kind, url: null,
    editUrl: `https://editor.note.com/notes/${noteKey}/edit/`, isUpdate,
  };
}

/** 手順書の本文に、拡張が取り込んだ画像URLを差し込んで最終形にする。 */
function renderFinalHtml(
  plan: { steps: Array<{ id: string; json?: { free_body?: string; body?: string } }> },
  vars: Record<string, unknown>,
): string {
  const step = plan.steps.find((s) => s.id === 'publish') ?? plan.steps.find((s) => s.id === 'draft_save');
  const html = step?.json?.free_body ?? step?.json?.body ?? '';
  return html.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, key) =>
    vars[key] !== undefined ? String(vars[key]) : whole);
}

export interface AgentFailure {
  articleId: string;
  /** 顧客にそのまま見せてよい日本語 */
  userMessage: string;
  /** note の連携切れなら true（つなぎ直せば再開できる） */
  needsReconnect: boolean;
}

/** 拡張が失敗を持ち帰ったときの後始末。 */
export async function applyAgentFailure(
  deps: ServiceDeps, job: AgentJob, error: { status?: number; code?: string; message?: string },
): Promise<AgentFailure> {
  const article = await deps.db.getArticle(job.article_id);
  if (!article) throw new Error('記事が見つかりません');

  const status = error.status ?? 0;
  const needsReconnect = status === 401 || status === 403 || error.code === 'auth';

  await deps.db.updateArticle(job.article_id, {
    error_code: error.code || (status ? String(status) : 'agent_error'),
    error_message: (error.message ?? '').slice(0, 500),
  });

  if (needsReconnect) {
    await deps.db.setState(job.article_id, article.state, 'awaiting_session', 'agent');
    await deps.db.audit(article.tenant_id, 'publish.blocked', 'agent', job.article_id, 'error', { reason: 'auth' });
    return {
      articleId: job.article_id,
      userMessage: 'note のログインが切れていました。\nお手数ですが note.com にログインし直してから、もう一度お試しください。',
      needsReconnect: true,
    };
  }

  // 混み合っているだけなら、条件が戻ったときに Cron が拾えるようにしておく
  if (status === 429 || status >= 500) {
    await deps.db.setState(job.article_id, article.state, 'blocked', 'agent');
    return {
      articleId: job.article_id,
      userMessage: 'note 側が混み合っているようです。しばらくしてから自動で投稿し直します。',
      needsReconnect: false,
    };
  }

  await deps.db.markFailed(job.article_id, 'agent', { status, code: error.code });
  await deps.db.audit(article.tenant_id, 'publish.failed', 'agent', job.article_id, 'error', { status, code: error.code });
  return {
    articleId: job.article_id,
    userMessage: new NoteApiError(status, error.code ?? '', `note への投稿に失敗しました（${error.message ?? status}）`).userMessage,
    needsReconnect: false,
  };
}
