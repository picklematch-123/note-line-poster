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
import { buildThumbnailResult } from '../adapters/line/messages/thumbnail';
import { generateArticle, markAwaitingApproval } from '../core/article/service';
import { LlmError } from '../ports/llm/types';
import { KvImageStore } from '../ports/storage/images';
import { resolveNoteSession } from '../core/session/resolve';
import { log } from '../lib/mask';

import { DEFAULT_TENANT_ID } from '../ports/storage/db';
import { createLlm, createResearchLlm, llmConfigFromEnv } from '../ports/llm';
import { runResearchSafely, recordResearchFailure, parseResearch, canRedoResearch } from '../core/research/run';
import { toResearchView } from '../adapters/line/messages/research';
import { analyzeContext } from '../core/generation/pipeline';
import { listEntries } from '../core/generation/context';
import { applyKnowledgeDigest } from '../core/knowledge/apply';
import { buildKnowledgeSaved, buildKnowledgeOrganizeFailed } from '../adapters/line/messages/knowledge';
import { ensureThumbnail, type ThumbnailOutcome } from '../core/image/thumbnail';
import { runGenerationStep, notifyGenerationFailure, runThumbnailStep } from './generate-step';
import { runInlineImageSteps, loadInlineView, hasImageKey, type StepDo } from '../core/image/inline';
import { buildInlineRegenResult } from '../adapters/line/messages/inline';
import { acquireImageLock, releaseImageLock, refreshImageLock, NOTE_INLINE_BUSY_AUTO } from '../core/image/lock';
import { parse as parsePlaceholders } from '../core/article/placeholders';

export interface ArticleParams {
  kind?: 'article';
  articleId: string;
  lineUserId: string;
  /** 画像の到着を待つ秒数 */
  debounceSec: number;
  /** 「もう一度調べる」が押された。保存済みの調査を使い回さず調べ直す（上限は守る） */
  forceResearch?: boolean;
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

/**
 * サムネイルの作り直し（利用者が「サムネを作り直す」を押したとき）。
 * ★記事生成と同じ Workflow に載せた理由はナレッジ整理と同じ（配布済みの環境の設定を変えずに済む）。
 */
export interface ThumbnailParams {
  kind: 'thumbnail';
  articleId: string;
  lineUserId: string;
  /** LINE 側で取った「作成中」の印。終わったら（失敗しても）ここで外す */
  lockToken?: string;
}

/**
 * 文中画像（P3）の作り直し（利用者が「文中画像を作り直す」を押したとき）。
 * ★同じ Workflow に載せる理由はサムネと同じ（配布済みの環境の設定を変えずに済む）。
 */
export interface InlineImagesParams {
  kind: 'inline_images';
  articleId: string;
  lineUserId: string;
  /** LINE 側で取った「作成中」の印。終わったら（失敗しても）ここで外す */
  lockToken?: string;
}

export type GenerateParams = ArticleParams | KnowledgeParams | ThumbnailParams | InlineImagesParams;

export class GenerateArticleWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
    if (event.payload.kind === 'knowledge') return this.organizeKnowledge(event.payload, step);
    if (event.payload.kind === 'thumbnail') return this.regenerateThumbnail(event.payload, step);
    if (event.payload.kind === 'inline_images') return this.regenerateInlineImages(event.payload, step);
    const { articleId, lineUserId, debounceSec, forceResearch } = event.payload;
    const db = new Db(this.env.DB);
    const line = new LineClient(this.env.LINE_CHANNEL_ACCESS_TOKEN, this.env.KV);

    // 1. 画像の到着を待つ
    if (debounceSec > 0) {
      await step.sleep('画像の到着を待つ', `${debounceSec} seconds`);
    }

    // 1.5 Webで調べる（設定が「Webで調べる」のときだけ。結果は articles.research_json に保存される）
    // ★retries: 0 の理由: 検索した時点で課金されるので、step の自動再試行で二重に課金させない。
    //   失敗しても例外は投げず「調べられなかった」と記録する（記事は与えた情報だけで書き、そのことを明示する）
    // ★どんな失敗（OpenAI の時間切れ・D1 の例外）でも先へ進む（2026-10-24 源蔵レビュー必須2）。
    //   中身は runResearchSafely が受け止める。万一 step 自体が落ちた（5分の時間切れなど）ときも、ここで受け止める。
    //   通信は 120 秒で打ち切るので、通常 5 分には届かない
    try {
      await step.do('記事を調べる', {
        retries: { limit: 0, delay: '1 second' },
        timeout: '5 minutes',
      }, async () => runResearchSafely({ db, llm: createResearchLlm(this.env) }, articleId, { force: forceResearch }));
    } catch (e) {
      log.error('「記事を調べる」が止まったため、調べられなかったとして続けます', String(e));
      await step.do('調べられなかったことを記録する', async () => {
        await recordResearchFailure({ db, llm: createResearchLlm(this.env) }, articleId, e);
      });
    }

    // 2. 生成（4ステップは pipeline 内で個別にリトライされる）
    // ★文章の通信は1回 180 秒で打ち切る（ports/llm）。それでも step そのものが落ちた（10分の時間切れ・
    //   やり直しも同じく固まった）ときは runGenerationStep が受け止め、下の「失敗を通知する」へ進む。
    //   以前はここで例外が外へ抜け、記事が「生成中」のまま止まり LINE にも届かなかった（2026-10-24 源蔵 再レビュー）
    const result = await runGenerationStep(() => step.do('記事を生成する', {
      retries: { limit: 1, delay: '10 seconds' },
      timeout: '10 minutes',
    }, async () => {
      try {
        const { article, charCount } = await generateArticle({
          db,
          llm: llmConfigFromEnv(this.env),
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
          research: toResearchView(
            parseResearch(article.research_json),
            await canRedoResearch(db, article, Boolean(createResearchLlm(this.env))),
          ) ?? null,
        };
      } catch (e) {
        const userMessage = e instanceof LlmError
          ? e.userMessage
          : '記事の生成に失敗しました。もう一度お試しください。';
        log.error('記事生成に失敗', String(e));
        return { ok: false as const, userMessage };
      }
    }));

    // 3. 結果を LINE へ返す（生成に1〜3分かかるので Push）
    if (!result.ok) {
      const { userMessage } = result;
      await step.do('失敗を通知する', async () => {
        await notifyGenerationFailure({ db, line }, articleId, lineUserId, userMessage);
      });
      return;
    }

    // 2.5 サムネイルを作る（失敗しても記事は届ける）
    // ★retries: 0 の理由: 描いた時点で課金されるので、step の自動再試行で二重に課金させない。
    //   一時エラーの再試行は OpenAI クライアント側で回数を決めて行っている。
    // ★サムネも「作成中」の印を持つ（作り直しボタンと同時に描かない）。取れなければ今回は作らない
    const thumbToken = `auto:${articleId}:${(event as { instanceId?: string }).instanceId ?? ''}`;
    // ★step そのものが落ちても（5分の時間切れなど）runThumbnailStep が受け止め、サムネなしで先へ進む（源蔵レビュー必須1）
    const thumb = await runThumbnailStep(() => step.do('サムネイルを作る', {
      retries: { limit: 0, delay: '1 second' },
      timeout: '5 minutes',
    }, async (): Promise<ThumbnailOutcome> => {
      if (!this.env.OPENAI_API_KEY) return ensureThumbnail(this.thumbDeps(db), articleId);
      if (!(await acquireImageLock(this.env.KV, 'thumb', articleId, thumbToken))) {
        return { status: 'failed', kind: 'busy', note: 'サムネを作り直している最中だったため、今回は新しく作りませんでした。' };
      }
      try {
        return await ensureThumbnail(this.thumbDeps(db), articleId);
      } finally {
        await releaseImageLock(this.env.KV, 'thumb', articleId, thumbToken);
      }
    }));

    // 2.6 文中の画像を作る（P3・既定0枚＝何もしない。失敗しても記事は届ける）
    // ★指示文は1回、画像は1枚ずつ独立した step（retries: 0・二重課金させない）。
    //   修正で作り直したときは、使い回せなかった番号の分だけ作る（generateArticle で使い回し済み）
    // ★自動生成の最中も「作成中」の印を持つ（作り直しボタンと同時に走らせない・源蔵レビュー P3 必須1）。
    //   作り直しの最中だったら、今回は新しく作らない（作り直しの結果がこの本文の番号を埋める）
    const inlineReasons = await this.autoInlineImages(event, step, db, articleId, result.markdown);

    await step.do('プレビューを送る', async () => {
      const current = await db.getArticle(articleId);
      await line.push(lineUserId, [buildPreview({
        articleId,
        title: result.title,
        markdown: result.markdown,
        metaDescription: result.metaDescription,
        hashtags: result.hashtags,
        charCount: result.charCount,
        hasEyecatch: result.hasEyecatch || thumb.status === 'created',
        thumbnailNote: thumb.status === 'created' ? undefined : thumb.note,
        thumbnailGenerated: thumb.status === 'created',
        canRegenerateThumbnail: thumb.status !== 'skipped' || thumb.reason !== 'no_key',
        research: result.research ?? undefined,
        inlineImages: current
          ? await loadInlineView(db, current, { hasKey: hasImageKey(this.env.OPENAI_API_KEY), reasons: inlineReasons })
          : undefined,
      })]);
      await markAwaitingApproval({
        db,
        llm: llmConfigFromEnv(this.env),
        noteSession: (await resolveNoteSession(this.env)).session,
        ownerLineUserId: this.env.LINE_OWNER_USER_ID,
        images: new KvImageStore(this.env.KV),
      }, articleId);
    });
  }

  private thumbDeps(db: Db) {
    return {
      db,
      images: new KvImageStore(this.env.KV),
      llm: llmConfigFromEnv(this.env),
      openaiKey: this.env.OPENAI_API_KEY ?? null,
    };
  }

  private inlineDeps(db: Db) {
    return {
      db,
      images: new KvImageStore(this.env.KV),
      llm: llmConfigFromEnv(this.env),
      openaiKey: this.env.OPENAI_API_KEY ?? null,
    };
  }

  /** 記事生成の中の文中画像（自動）。「作成中」の印を取って作り、終わったら（失敗しても）外す */
  private async autoInlineImages(
    event: WorkflowEvent<GenerateParams>, step: WorkflowStep, db: Db, articleId: string, markdown: string,
  ): Promise<string[]> {
    // 本文に AI 画像の場所が無ければ何もしない（KV にも触らない）
    if (parsePlaceholders(markdown, 'generated').length === 0) return [];
    const kv = this.env.KV;
    const token = `auto:${articleId}:${(event as { instanceId?: string }).instanceId ?? ''}`;
    // ★取れたかどうかは step に記録する（Workflow のやり直しで判定が変わらないように）
    const locked = await step.do('文中の画像の作業を始める', async () => acquireImageLock(kv, 'inline', articleId, token));
    if (!locked) return [NOTE_INLINE_BUSY_AUTO];
    try {
      return await runInlineImageSteps(step.do.bind(step) as unknown as StepDo, this.inlineDeps(db), articleId,
        { heartbeat: () => refreshImageLock(kv, 'inline', articleId, token) });
    } finally {
      await releaseImageLock(kv, 'inline', articleId, token);
    }
  }

  /** 文中の画像を作り直して、結果を LINE へ知らせる（本文にある番号すべて。上限は守る） */
  private async regenerateInlineImages(p: InlineImagesParams, step: WorkflowStep) {
    const db = new Db(this.env.DB);
    const line = new LineClient(this.env.LINE_CHANNEL_ACCESS_TOKEN, this.env.KV);
    const kv = this.env.KV;
    // ★LINE 側で取った「作成中」の印は、終わっても失敗しても（step が落ちても）必ず外す
    try {
      const reasons = await runInlineImageSteps(step.do.bind(step) as unknown as StepDo, this.inlineDeps(db), p.articleId,
        { force: true, prefix: '作り直し: ', heartbeat: () => refreshImageLock(kv, 'inline', p.articleId, p.lockToken) });
      await step.do('文中の画像の作り直しを知らせる', async () => {
        const a = await db.getArticle(p.articleId);
        const view = a ? await loadInlineView(db, a, { hasKey: hasImageKey(this.env.OPENAI_API_KEY), reasons }) : undefined;
        await line.push(p.lineUserId, [buildInlineRegenResult(p.articleId, view, reasons)]);
      });
    } finally {
      await releaseImageLock(kv, 'inline', p.articleId, p.lockToken);
    }
  }

  /** サムネだけを作り直して、結果を LINE へ知らせる */
  private async regenerateThumbnail(p: ThumbnailParams, step: WorkflowStep) {
    const db = new Db(this.env.DB);
    const line = new LineClient(this.env.LINE_CHANNEL_ACCESS_TOKEN, this.env.KV);
    // ★LINE 側で取った「作成中」の印は、終わっても失敗しても必ず外す（文中画像と同じ作り）
    try {
      // ★step が落ちても受け止め、結果（失敗）を LINE に知らせる
      const out = await runThumbnailStep(() => step.do('サムネイルを作り直す', {
        retries: { limit: 0, delay: '1 second' },
        timeout: '5 minutes',
      }, async (): Promise<ThumbnailOutcome> => ensureThumbnail(this.thumbDeps(db), p.articleId, { force: true })));

      await step.do('作り直しの結果を知らせる', async () => {
        await line.push(p.lineUserId, [buildThumbnailResult(p.articleId, out)]);
      });
    } finally {
      await releaseImageLock(this.env.KV, 'thumb', p.articleId, p.lockToken);
    }
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
        const llm = createLlm(llmConfigFromEnv(this.env));
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
