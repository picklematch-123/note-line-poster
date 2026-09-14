/**
 * 記事生成ワークフロー。
 *
 * LINE は「ネタ → 画像を何枚か」の順で届くので、最後のメッセージから
 * 少し待ってから生成を始める（デバウンス）。Workers は sleep できないため
 * Workflows の step.sleep を使う。
 *
 * step 単位で永続化されるので、途中で失敗しても最初からやり直さない。
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { Db } from '../ports/storage/db';
import { LineClient } from '../adapters/line/client';
import { buildPreview } from '../adapters/line/messages/preview';
import { generateArticle, markAwaitingApproval } from '../core/article/service';
import { LlmError } from '../ports/llm/anthropic';
import { KvImageStore } from '../ports/storage/images';
import { resolveNoteSession } from '../core/session/resolve';
import { log } from '../lib/mask';

import { DEFAULT_TENANT_ID } from '../ports/storage/db';
import { AnthropicLlm } from '../ports/llm/anthropic';
import { analyzeContext } from '../core/generation/pipeline';
import { listEntries } from '../core/generation/context';
import { applyKnowledgeDigest } from '../core/knowledge/apply';
import { buildKnowledgeSaved, buildKnowledgeOrganizeFailed } from '../adapters/line/messages/knowledge';

export interface ArticleParams {
  kind?: 'article';
  articleId: string;
  lineUserId: string;
  /** 画像の到着を待つ秒数 */
  debounceSec: number;
}

/**
 * ナレッジの整理（2026-09-14）。
 *
 * ★記事生成と同じ Workflow に載せた理由:
 *   長文の整理は LINE の裏処理（約30秒で打ち切り）に収まらない。Workflow なら時間制限が無い。
 *   新しい Workflow を足すと、配布済みの環境ごとに設定ファイルの書き換えが要るため、既存のものを使う。
 */
export interface KnowledgeParams {
  kind: 'knowledge';
  /** 整理の対象として保存した行。整理が終わる前に新しい内容が保存されたら、この結果は使わない */
  contextId: string;
  lineUserId: string;
  /** 終わったことを知らせるか（書き足し・入れ替え＝知らせる／1件消す＝知らせない） */
  announce: boolean;
}

export type GenerateParams = ArticleParams | KnowledgeParams;

export class GenerateArticleWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
    if (event.payload.kind === 'knowledge') return this.organizeKnowledge(event.payload, step);
    const { articleId, lineUserId, debounceSec } = event.payload;
    const db = new Db(this.env.DB);
    const line = new LineClient(this.env.LINE_CHANNEL_ACCESS_TOKEN, this.env.KV);

    // 1. 画像の到着を待つ
    if (debounceSec > 0) {
      await step.sleep('画像の到着を待つ', `${debounceSec} seconds`);
    }

    // 2. 生成（4ステップは pipeline 内で個別にリトライされる）
    const result = await step.do('記事を生成する', {
      retries: { limit: 1, delay: '10 seconds' },
      timeout: '10 minutes',
    }, async () => {
      try {
        const { article, charCount } = await generateArticle({
          db,
          llmApiKey: this.env.ANTHROPIC_API_KEY,
          llmWorkspaceId: this.env.ANTHROPIC_WORKSPACE_ID ?? null,
          noteSession: (await resolveNoteSession(this.env)).session,
          ownerLineUserId: this.env.LINE_OWNER_USER_ID,
          images: new KvImageStore(this.env.KV),
        }, articleId);

        return {
          ok: true as const,
          title: article.title ?? '無題',
          markdown: article.body_md ?? '',
          metaDescription: article.meta_description ?? '',
          hashtags: article.hashtags_json ? JSON.parse(article.hashtags_json) : [],
          charCount,
          hasEyecatch: Boolean(await db.getEyecatch(articleId)),
        };
      } catch (e) {
        const userMessage = e instanceof LlmError
          ? e.userMessage
          : '記事の生成に失敗しました。もう一度お試しください。';
        log.error('記事生成に失敗', String(e));
        return { ok: false as const, userMessage };
      }
    });

    // 3. 結果を LINE へ返す（生成に1〜3分かかるので Push）
    if (!result.ok) {
      await step.do('失敗を通知する', async () => {
        await db.markFailed(articleId, 'system', { reason: result.userMessage });
        await line.push(lineUserId, [{
          type: 'text',
          text: `${result.userMessage}\n\n` +
            'もう一度やってみる場合は、指示をそのまま送ってください。\n' +
            '新しいネタにする場合は「やめる」と送ってください。',
        }]);
      });
      return;
    }

    await step.do('プレビューを送る', async () => {
      await line.push(lineUserId, [buildPreview({
        articleId,
        title: result.title,
        markdown: result.markdown,
        metaDescription: result.metaDescription,
        hashtags: result.hashtags,
        charCount: result.charCount,
        hasEyecatch: result.hasEyecatch,
      })]);
      await markAwaitingApproval({
        db,
        llmApiKey: this.env.ANTHROPIC_API_KEY,
          llmWorkspaceId: this.env.ANTHROPIC_WORKSPACE_ID ?? null,
        noteSession: (await resolveNoteSession(this.env)).session,
        ownerLineUserId: this.env.LINE_OWNER_USER_ID,
        images: new KvImageStore(this.env.KV),
      }, articleId);
    });
  }

  /** ナレッジを整理して、記事に使う前提を作り直す（時間がかかっても打ち切られない） */
  private async organizeKnowledge(p: KnowledgeParams, step: WorkflowStep) {
    const db = new Db(this.env.DB);
    const line = new LineClient(this.env.LINE_CHANNEL_ACCESS_TOKEN, this.env.KV);

    const result = await step.do('ナレッジを整理する', {
      retries: { limit: 1, delay: '10 seconds' },
      timeout: '10 minutes',
    }, async () => {
      const current = await db.getActiveContext(DEFAULT_TENANT_ID);
      if (!current || current.id !== p.contextId) return { status: 'stale' as const };
      try {
        const llm = new AnthropicLlm(this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_WORKSPACE_ID ?? null);
        const { data } = await analyzeContext(llm, current.raw_text);
        const applied = await applyKnowledgeDigest(db, DEFAULT_TENANT_ID, p.contextId, data);
        if (applied === 'stale') return { status: 'stale' as const };
        return { status: 'ok' as const, data, count: listEntries(current.raw_text).length };
      } catch (e) {
        log.error('ナレッジの整理に失敗', String(e));
        return { status: 'failed' as const, reason: e instanceof LlmError ? e.userMessage : null };
      }
    });

    if (result.status === 'stale') {
      log.info('新しい内容が保存されたため、前の整理結果は使いません');
      return;
    }
    if (!p.announce) return;

    await step.do('整理の結果を知らせる', async () => {
      await line.push(p.lineUserId, [result.status === 'ok'
        ? buildKnowledgeSaved(result.data, result.count)
        : { type: 'text', text: buildKnowledgeOrganizeFailed(result.reason) }]);
    });
  }
}
