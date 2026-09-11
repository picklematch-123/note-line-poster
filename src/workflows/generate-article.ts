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

export interface GenerateParams {
  articleId: string;
  lineUserId: string;
  /** 画像の到着を待つ秒数 */
  debounceSec: number;
}

export class GenerateArticleWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
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
}
