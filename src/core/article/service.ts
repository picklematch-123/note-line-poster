/**
 * 記事のライフサイクル操作。
 *
 * ★入口（LINE / REST / MCP）はここを呼ぶ。ここは入口を知らない。
 *   Phase 3 で MCP を足すとき、このファイルには手を入れない。
 */
import { Db, type ArticleRow, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { NoteClient, NoteApiError, type NoteSession } from '../../ports/publisher/note/client';
import { toNoteHtml, plainLength } from '../../ports/publisher/note/html';
import { LlmError } from '../../ports/llm/types';
import { createLlm, type LlmConfig } from '../../ports/llm';
import { generate } from '../generation/pipeline';
import { ensureContextUrls } from '../generation/context';
import { parseResearch, researchForGeneration } from '../research/run';
import { finalizeArticle } from '../research/finalize';
import { findUnverifiedTerms, findMiscitedTerms, mergeVerifyResults } from '../research/verify';
import { canPublish, nextJstMorning, type PolicyDecision, type PolicyContext } from '../policy';
import { assertTransition, WITHDRAWN_STATES, type ArticleState } from './state';
import { REOPEN_REASON, snapshotOf } from './cancel';
import { parseHeadings, move, swap, remove, splitGeneratedPlaceholders, placeholderToken, type PlaceholderKind } from './placeholders';
import { precheckArticleLinks, assertArticleHtmlLinks, DisallowedLinksError, listPlacedGeneratedImages, GENERATED_SLOT_OFFSET } from './links';
import { composeArticleMarkdown, type GeneratedFill } from './compose';
import { effectiveInlineCount, reuseGeneratedImages, deleteGeneratedSlot, syncGeneratedHeadings } from '../image/inline';
import type { ImageStore } from '../../ports/storage/images';
import { nowIso } from '../../lib/time';
import { log } from '../../lib/mask';

export interface ServiceDeps {
  db: Db;
  /** 使う LLM の設定（Claude / OpenAI のどちらを使うかもここで決まる） */
  llm: LlmConfig;
  noteSession: NoteSession;
  ownerLineUserId: string | null;
  /** 投稿者（持ち主と同じく承認できる）。渡さなければ持ち主だけ */
  staffLineUserIds?: readonly string[];
  images: ImageStore;
  /**
   * note が振り直した Cookie を保存し直すための口。
   * ★note はリクエストのたびにセッションを振り直す。保存し直さないと、
   *   実際の寿命より早く「連携が切れました」になり、顧客の手間が増える。
   */
  onCookieRefresh?: (cookieHeader: string) => Promise<void>;
}

export interface GenerateResult {
  article: ArticleRow;
  charCount: number;
}

/** ネタを受け付けて記事レコードを作る。 */
export async function submitIdea(
  deps: ServiceDeps, sourceText: string, tenantId = DEFAULT_TENANT_ID, requestedBy: string | null = null,
) {
  await deps.db.ensureTenant(tenantId);
  return deps.db.createArticle(tenantId, sourceText, requestedBy);
}

/**
 * 記事を生成する（4ステップ）。
 * 画像は一時置き場（KV）から読み出して note へ上げ、[画像N] を実URLに解決する。
 */
export async function generateArticle(deps: ServiceDeps, articleId: string): Promise<GenerateResult> {
  const article = await deps.db.getArticle(articleId);
  if (!article) throw new Error('記事が見つかりません');

  // ★生成を待つ間に「やめる」が押されていたら、何もせずに終わる（失敗として扱わない）
  if (WITHDRAWN_STATES.includes(article.state)) throw new GenerationWithdrawnError(article.state);
  assertTransition(article.state, 'generating');
  await deps.db.setState(articleId, article.state, 'generating', 'system');

  const images = await deps.db.listImages(articleId);
  // AI が作る文中画像の枚数（P3）。★既定0・OpenAI のキーが無ければ0（設定に関わらず）
  const generatedCount = await effectiveInlineCount(deps.db, deps.llm.openaiKey);
  const style = await deps.db.getActiveStyleProfile(article.tenant_id);
  const context = await deps.db.getActiveContext(article.tenant_id);

  const llm = createLlm(deps.llm);
  const hintKeywords = extractHintKeywords(article.source_text);

  // 修正指示は source_text に混ぜず、生成時にだけ足す。
  // 混ぜると修正のたびに元ネタが汚れ、指示が累積してしまう。
  const sourceText = article.revision_instruction
    ? `${article.source_text}\n\n【今回の修正指示】\n${article.revision_instruction}\n` +
      `※前回の記事はこの指示に沿って作り直してください。元のネタの意図は保つこと。`
    : article.source_text;

  // Webリサーチの結果（Workflow の「記事を調べる」で保存済み）。無ければ今までどおり
  const research = parseResearch(article.research_json);
  const contextPrompt = ensureContextUrls(context?.raw_text ?? null, context?.prompt_snippet ?? null);

  const out = await generate(llm, {
    sourceText,
    hintKeywords,
    // ★「写真 k 枚＋生成 m 枚」で、今までどおり [画像1]〜[画像k+m] を書かせる（見出しの選び方も今のまま）。
    //   保存の直前に純関数で k+1 番目以降を [AI画像N] に書き換える（設計書 18-2）
    imageCount: images.length + generatedCount,
    stylePrompt: style?.prompt_snippet ?? null,
    // ★以前に登録されたプロフィールでも URL が落ちないよう、読み出すたびに補う
    contextPrompt,
    research: researchForGeneration(research),
  });

  // ★仕上げ（調査の有無に関わらず必ず通す）: 〔n〕の目印を出典の一覧に変え、
  //   本人が書いたもの（ナレッジ・ネタ・修正指示）と検査済みの出典以外の URL を消す
  const facts = research?.status === 'ok' ? research.facts : [];
  const fin = finalizeArticle({
    markdown: out.markdown,
    facts,
    trustedTexts: [context?.raw_text, article.source_text, article.revision_instruction],
  });
  // ★写真と AI 画像の目印を分ける（LLM を通さない）。以後 [画像N] は写真だけを指す
  const bodyMd = splitGeneratedPlaceholders(fin.markdown, images.length);
  // alt は写真の分（1..k）だけ残す。AI 画像の alt は指示文づくりで作り、images.alt_text に持つ
  const imageAlts = Object.fromEntries(Object.entries(out.imageAlts)
    .filter(([k]) => Number(k) >= 1 && Number(k) <= images.length));
  // ★修正で作り直したときは、前回の AI 画像を使い回す（見出しが同じものはその画像、残りは順番どおり）。
  //   足りない分だけ、この後の Workflow の step で新しく作る。余りは消す（二重課金を避ける・設計書 18-7）
  // ★書き込む直前にもう一度確かめる。生成の最中に「やめる」が押された（取りやめ・元の版に戻した）なら、
  //   結果を捨てる。ここで書くと、戻した本文を上書きし、取りやめた記事を生き返らせてしまう（2026-11）
  {
    const now = await deps.db.getArticle(articleId);
    if (now && now.state !== 'generating') throw new GenerationWithdrawnError(now.state);
  }
  await reuseGeneratedImages(deps.db, deps.images, articleId, bodyMd);

  if (research) {
    // 照合: 本文の数字・固有名詞が、事実メモ・ネタ・ナレッジのどれかにあるか（無ければプレビューで「要確認」）
    const unsupported = findUnverifiedTerms(fin.body, [
      ...facts.flatMap((f) => [f.claim, f.sourceTitle]),
      article.source_text, article.revision_instruction, context?.raw_text, contextPrompt,
    ]);
    // 〔n〕を付けた文の数字・固有名詞は、メモ n にあること（出典の付け違い・中身のすり替えを拾う）
    const check = mergeVerifyResults(unsupported, findMiscitedTerms(out.markdown, facts));
    research.check = { usedIds: fin.usedIds, referenceCount: fin.referenceCount, flags: check.flags, total: check.total };
  }

  await deps.db.updateArticle(articleId, {
    ...(research ? { research_json: JSON.stringify(research) } : {}),
    title: out.title,
    image_alts_json: JSON.stringify(imageAlts),
    body_md: bodyMd,
    meta_description: out.metaDescription,
    keywords_json: JSON.stringify(out.keywords),
    outline_json: JSON.stringify(out.outline),
    hashtags_json: JSON.stringify(out.hashtags),
    llm_input_tokens: out.usage.inputTokens,
    llm_output_tokens: out.usage.outputTokens,
  });
  await deps.db.setState(articleId, 'generating', 'preview_ready', 'system', {
    見出し数: parseHeadings(bodyMd).length,
  });

  const updated = (await deps.db.getArticle(articleId))!;
  return { article: updated, charCount: bodyMd.replace(/\[(?:AI)?画像\d+\]/g, '').length };
}

/**
 * 生成を待つ間・生成の最中に「やめる」が押された（取りやめ・note に出ている版へ戻した）。
 * ★失敗ではない。Workflow はこれを受けたら、失敗の記録も LINE への通知もせずに静かに終わる。
 */
export class GenerationWithdrawnError extends Error {
  constructor(readonly state: ArticleState) {
    super(`生成の途中で記事が取りやめられました（いまの状態: ${state}）`);
    this.name = 'GenerationWithdrawnError';
  }
}

/**
 * 本文の書き直しを依頼する（承認待ち → editing）。
 * 実際の生成はワークフロー側で行う。
 */
export async function requestRewrite(deps: ServiceDeps, articleId: string, instruction: string): Promise<void> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');

  await deps.db.updateArticle(articleId, {
    revision_instruction: instruction,
    revision_count: (a.revision_count ?? 0) + 1,
  });
  // failed からの再試行は editing を経由せず直接 generating へ進める
  if (a.state !== 'editing' && a.state !== 'failed') {
    await deps.db.setState(articleId, a.state, 'editing', 'system', { instruction });
  }
}

/**
 * note に「下書き」として保存する（公開しない）。
 *
 * 公開ではないので承認ゲートとレート制限は課さない。
 * ただし緊急停止だけは効かせる（note 側から止められている状況では触らない）。
 */
export async function saveArticleAsDraft(deps: ServiceDeps, articleId: string): Promise<{ editUrl: string }> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');

  if (!(await deps.db.getFlag('publish_enabled'))) {
    throw new PolicyBlockedError({
      allowed: false, reason: 'kill_switch', retryable: true,
      userMessage: 'システムメンテナンス中のため、いまは note に保存できません。',
    });
  }

  // ★最後の関所（note に何かを送る前）。許可外のリンク先があれば下書きにもしない
  await precheckArticleLinks(deps.db, a, 'draft');

  const client = new NoteClient(deps.noteSession);
  if (!(await client.isAlive())) {
    await deps.db.setState(articleId, a.state, 'awaiting_session', 'system');
    throw new NoteApiError(401, 'auth', 'note との連携が切れています。再接続をお願いします。', true);
  }

  await deps.db.setState(articleId, a.state, 'saving_draft', 'system');

  try {
    const isUpdate = Boolean(a.note_id && a.note_key);
    const created = isUpdate
      ? { id: Number(a.note_id), key: a.note_key!, slug: `slug-${a.note_key}`, canPublish: true }
      : await client.createNote();

    // サムネイル
    const eyecatch = await deps.db.getEyecatch(articleId);
    if (eyecatch) {
      const stored = await deps.images.get(eyecatch.r2_key);
      if (stored) {
        const up = await client.uploadEyecatch(
          created.id, new Blob([stored.bytes], { type: stored.contentType }), 'eyecatch.png');
        await deps.db.setImageNoteUrl(eyecatch.id, up.url, 0);
      }
    }

    // 本文画像
    const images = await deps.db.listImages(articleId);
    const urls: Record<number, string> = {};
    for (let i = 0; i < images.length; i++) {
      const stored = await deps.images.get(images[i].r2_key);
      if (!stored) continue;
      const up = await client.uploadImage(
        created.id, new Blob([stored.bytes], { type: stored.contentType }), `image${i + 1}.png`);
      urls[i + 1] = up.url;
      await deps.db.setImageNoteUrl(images[i].id, up.url, i + 1);
    }

    // AI が作った文中画像（P3）。写真・サムネと同じく note に上げてから [AI画像N] の位置に差し込む
    const generated = await uploadGeneratedImages(deps, client, a, created.id);

    const alts: Record<string, string> = a.image_alts_json ? JSON.parse(a.image_alts_json) : {};
    const html = toNoteHtml(composeArticleMarkdown({
      bodyMd: a.body_md ?? '', photoCount: images.length, photoUrls: urls, photoAlts: alts, generated,
    }));
    // ★送る直前の最終 HTML でも検査する（許可に足すのは、いま note に上げた画像の URL だけ）
    await assertArticleHtmlLinks(deps.db, a, html, 'draft', {
      imageUrls: [...Object.values(urls), ...Object.values(generated).map((g) => g.url)], stage: 'final',
    });

    await client.saveDraft(created.id, {
      title: a.title ?? '無題',
      html,
      bodyLength: plainLength(html),
    });

    await deps.db.updateArticle(articleId, {
      body_html: html,
      note_id: String(created.id),
      note_key: created.key,
    });
    await deps.db.setState(articleId, 'saving_draft', 'drafted', 'system');
    await deps.db.audit(a.tenant_id, 'draft.saved', 'system', articleId, 'ok');

    await deps.onCookieRefresh?.(client.latestCookieHeader);

    log.info('note に下書き保存しました', { articleId });
    return { editUrl: `https://editor.note.com/notes/${created.key}/edit/` };
  } catch (e) {
    // リンク検査で止めた場合は、後始末（状態・監査ログ）を済ませてある
    if (e instanceof DisallowedLinksError) throw e;
    const recoverable = e instanceof NoteApiError && e.recoverable;
    if (recoverable) {
      await deps.db.setState(articleId, 'saving_draft', 'awaiting_session', 'system');
    } else {
      await deps.db.markFailed(articleId, 'system', { step: 'draft' });
    }
    throw e;
  }
}

/**
 * 公開済み（または下書き保存済み）の記事を修正モードに戻す。
 * 再公開すると note 上の同じ記事が上書きされる（新しい記事は増えない）。
 *
 * ★修正を始める前の中身を、状態の記録に控えとして残す。
 *   途中で「やめる」と、記事を取りやめにせず、この控えに戻す（core/article/cancel.ts・2026-11 顧客環境の不具合）。
 * ★以前は published だけを開いていた。下書き保存済み（drafted）の「修正する」は状態が変わらず、
 *   続けて送った指示が新しい記事のネタになっていた。同じ作りで開く。
 */
export async function reopenPublished(deps: ServiceDeps, articleId: string): Promise<void> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');
  if (a.state !== 'published' && a.state !== 'drafted') return;
  // 再公開には改めて承認が必要
  await deps.db.updateArticle(articleId, { approved_at: null, approved_by: null });
  await deps.db.setState(articleId, a.state, 'editing', 'system', { reason: REOPEN_REASON, restore: snapshotOf(a) });
}

/** プレビュー送信後に承認待ちへ。 */
export async function markAwaitingApproval(deps: ServiceDeps, articleId: string) {
  const a = await deps.db.getArticle(articleId);
  if (!a) return;
  assertTransition(a.state, 'awaiting_approval');
  await deps.db.setState(articleId, a.state, 'awaiting_approval', 'system');
}

/** 承認する。★承認できるのは持ち主と投稿者だけ。 */
export async function approve(deps: ServiceDeps, articleId: string, byLineUserId: string): Promise<PolicyDecision> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');

  const isStaff = (deps.staffLineUserIds ?? []).includes(byLineUserId);
  if (deps.ownerLineUserId && byLineUserId !== deps.ownerLineUserId && !isStaff) {
    await deps.db.audit(a.tenant_id, 'publish.denied', `line:${byLineUserId}`, articleId, 'denied', { reason: 'wrong_approver' });
    return { allowed: false, reason: 'wrong_approver', retryable: false,
      userMessage: 'この記事を公開できるのは、アカウントの持ち主と投稿者だけです。' };
  }

  await deps.db.updateArticle(articleId, { approved_at: nowIso(), approved_by: byLineUserId });
  return { allowed: true };
}

/** ポリシー判定を行う。公開の直前に必ず呼ぶ。 */
export async function checkPolicy(deps: ServiceDeps, articleId: string): Promise<PolicyDecision> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');
  const tenant = await deps.db.ensureTenant(a.tenant_id);
  let publishWait: PolicyContext['publishWait'];
  if (a.state === 'blocked' || a.state === 'awaiting_session') {
    const wait = await deps.db.getPublishWait(articleId);
    if (wait) {
      const detail = JSON.parse(wait.detail_json) as { reason: 'daily_limit' | 'too_soon'; retryAfter?: string };
      // 修正前は理由だけを記録していた。日次上限なら記録日の翌朝9時を復元する。
      const retryAfter = detail.retryAfter ?? (detail.reason === 'daily_limit' ? nextJstMorning(wait.created_at) : undefined);
      if (retryAfter && Number.isFinite(new Date(retryAfter).getTime())) {
        publishWait = { reason: detail.reason, retryAfter };
      }
    }
  }

  const decision = canPublish({
    killSwitchOn: !(await deps.db.getFlag('publish_enabled')),
    tenant: {
      status: tenant.status,
      publishEnabled: tenant.publish_enabled === 1,
      tosAcceptedAt: tenant.tos_accepted_at,
      dailyPostLimit: tenant.daily_post_limit,
      minIntervalSec: tenant.min_interval_sec,
    },
    article: { state: a.state, approvedAt: a.approved_at, approvedBy: a.approved_by },
    ownerLineUserId: deps.ownerLineUserId,
    staffLineUserIds: deps.staffLineUserIds,
    todayPublishCount: await deps.db.todayPublishCount(a.tenant_id),
    lastPublishedAt: await deps.db.lastPublishedAt(a.tenant_id),
    globalRecentCount: await deps.db.globalRecentCount(),
    globalLimitPerMinute: await deps.db.getNumberFlag('global_limit_per_minute', 3),
    // すでに note 上に記事があるなら、これは上書き更新
    isUpdate: Boolean(a.note_id),
    publishWait,
  });
  // Cronで予定時刻に上限へ再到達した場合は、新しい待機時刻を保存する。
  // 未来の予定が残っている間は同じ記録を増やさず、翌日にずらさない。
  if ((a.state === 'blocked' || a.state === 'awaiting_session')
      && decision.retryAfter && decision.retryAfter !== publishWait?.retryAfter) {
    await deps.db.logEvent(articleId, a.state, 'blocked', 'system', {
      reason: decision.reason, retryAfter: decision.retryAfter,
    });
  }
  return decision;
}

/**
 * note へ公開する。
 * ★必ず checkPolicy を通してから呼ぶこと。ここでも二重に検証する（最後の砦）。
 */
export async function publishArticle(deps: ServiceDeps, articleId: string): Promise<{ url: string }> {
  const decision = await checkPolicy(deps, articleId);
  if (!decision.allowed) {
    throw new PolicyBlockedError(decision);
  }

  const a = (await deps.db.getArticle(articleId))!;
  // ★最後の関所（note に何かを送る前）。許可外のリンク先があれば公開しない
  await precheckArticleLinks(deps.db, a, 'publish');

  const client = new NoteClient(deps.noteSession);

  // 投稿直前にセッションの生死を確認する（前日から失効している可能性がある）
  if (!(await client.isAlive())) {
    await deps.db.setState(articleId, a.state, 'awaiting_session', 'system');
    throw new NoteApiError(401, 'auth', 'note との連携が切れています。再接続をお願いします。', true);
  }

  await deps.db.setState(articleId, a.state, 'publishing', 'system');

  try {
    // すでに note に記事があるならそれを上書きする（新しい記事を増やさない）
    const isUpdate = Boolean(a.note_id && a.note_key);
    const created = isUpdate
      ? { id: Number(a.note_id), key: a.note_key!, slug: `slug-${a.note_key}`, canPublish: true }
      : await client.createNote();

    // 画像を note へアップロードし、[画像N] を実URLに解決する
    const images = await deps.db.listImages(articleId);
    const urls: Record<number, string> = {};
    for (let i = 0; i < images.length; i++) {
      const stored = await deps.images.get(images[i].r2_key);
      if (!stored) continue;
      const blob = new Blob([stored.bytes], { type: stored.contentType });
      const up = await client.uploadImage(created.id, blob, `image${i + 1}.png`);
      urls[i + 1] = up.url;
      await deps.db.setImageNoteUrl(images[i].id, up.url, i + 1);
    }

    // サムネイル（見出し画像）。本文とは別枠で、note では og:image になる
    const eyecatch = await deps.db.getEyecatch(articleId);
    if (eyecatch) {
      const stored = await deps.images.get(eyecatch.r2_key);
      if (stored) {
        const up = await client.uploadEyecatch(
          created.id, new Blob([stored.bytes], { type: stored.contentType }), 'eyecatch.png');
        await deps.db.setImageNoteUrl(eyecatch.id, up.url, 0);
        log.info('サムネイルを設定しました', { articleId });
      }
    }

    // AI が作った文中画像（P3）。写真と同じく note に上げてから [AI画像N] の位置に差し込む
    const generated = await uploadGeneratedImages(deps, client, a, created.id);

    const alts: Record<string, string> = a.image_alts_json ? JSON.parse(a.image_alts_json) : {};
    const html = toNoteHtml(composeArticleMarkdown({
      bodyMd: a.body_md ?? '', photoCount: images.length, photoUrls: urls, photoAlts: alts, generated,
    }));
    // ★送る直前の最終 HTML でも検査する（許可に足すのは、いま note に上げた画像の URL だけ）
    await assertArticleHtmlLinks(deps.db, a, html, 'publish', {
      imageUrls: [...Object.values(urls), ...Object.values(generated).map((g) => g.url)], stage: 'final',
    });
    const length = plainLength(html);
    const hashtags: string[] = a.hashtags_json ? JSON.parse(a.hashtags_json) : [];

    await client.saveDraft(created.id, { title: a.title ?? '無題', html, bodyLength: length });
    const { url } = await client.publish(created.id, created.key, {
      title: a.title ?? '無題',
      html,
      bodyLength: length,
      hashtags,
      notifyFollowers: true,
      excludeAiLearning: true, // クライアント資産を第三者のAI学習に回さない
    });

    await deps.db.updateArticle(articleId, {
      body_html: html,             // note からは読み戻せないので必ず保存する
      note_id: String(created.id),
      note_key: created.key,
      note_url: url,
      published_at: nowIso(),
    });
    await deps.db.setState(articleId, 'publishing', 'published', 'system', { url, isUpdate });
    // 上書き更新は投稿本数に数えない（note 上の記事は増えていないため）
    if (!isUpdate) await deps.db.recordPublish(a.tenant_id, articleId);
    await deps.db.audit(a.tenant_id, isUpdate ? 'publish.updated' : 'publish.ok', 'system', articleId, 'ok', { url });

    await deps.onCookieRefresh?.(client.latestCookieHeader);

    log.info(isUpdate ? 'note の記事を更新しました' : 'note へ公開しました', { articleId, url });
    return { url };
  } catch (e) {
    // リンク検査で止めた場合は、後始末（状態・監査ログ）を済ませてある
    if (e instanceof DisallowedLinksError) throw e;
    const recoverable = e instanceof NoteApiError && e.recoverable;
    await deps.db.updateArticle(articleId, {
      error_code: e instanceof NoteApiError ? e.code : 'unknown',
      error_message: e instanceof Error ? e.message.slice(0, 500) : String(e),
    });
    if (recoverable) {
      await deps.db.setState(articleId, 'publishing', 'awaiting_session', 'system');
    } else {
      await deps.db.markFailed(articleId, 'system', { code: e instanceof NoteApiError ? e.code : 'unknown' });
    }
    await deps.db.audit(a.tenant_id, 'publish.failed', 'system', articleId, 'error', {
      code: e instanceof NoteApiError ? e.code : 'unknown',
    });
    throw e;
  }
}

/**
 * 本文に置かれている AI 文中画像を note に上げ、番号 → URL・alt を返す。
 * ★本文に無い番号の画像（「AI画像2を消して」のあと）は上げない（使わない画像で note を散らかさない）
 */
async function uploadGeneratedImages(
  deps: ServiceDeps, client: NoteClient, a: ArticleRow, noteId: number,
): Promise<Record<number, GeneratedFill>> {
  const out: Record<number, GeneratedFill> = {};
  for (const row of await listPlacedGeneratedImages(deps.db, a)) {
    const slot = row.gen_slot!;
    const stored = await deps.images.get(row.r2_key);
    if (!stored) continue;
    const up = await client.uploadImage(
      noteId, new Blob([stored.bytes], { type: stored.contentType }), `ai-image${slot}.png`);
    out[slot] = { url: up.url, alt: row.alt_text };
    await deps.db.setImageNoteUrl(row.id, up.url, GENERATED_SLOT_OFFSET + slot);
  }
  return out;
}

/** ポリシーで止められたことを示す例外。 */
export class PolicyBlockedError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(decision.userMessage ?? '公開できませんでした');
    this.name = 'PolicyBlockedError';
  }
}

/**
 * 指定した画像をサムネイル（見出し画像）にする。
 * @param slot 受信順の番号（1始まり）。省略時は最後に送られた画像
 */
export async function setEyecatch(
  deps: ServiceDeps, articleId: string, slot?: number | null,
): Promise<{ message: string }> {
  const all = await deps.db.listAllImages(articleId);
  if (all.length === 0) {
    throw new Error('この記事にはまだ画像がありません。先に画像を送ってください。');
  }
  const target = slot && slot >= 1 && slot <= all.length ? all[slot - 1] : all[all.length - 1];
  const ok = await deps.db.setEyecatch(articleId, target.id);
  if (!ok) throw new Error('その画像が見つかりませんでした。');

  const index = all.findIndex((x) => x.id === target.id) + 1;
  return { message: `${index}枚目の画像をサムネイル（見出し画像）に設定しました。\n本文からは外れます。` };
}

/** サムネイル指定を外す。 */
export async function clearEyecatch(deps: ServiceDeps, articleId: string): Promise<void> {
  await deps.db.clearEyecatch(articleId);
}

/**
 * 画像位置の修正（LLM を使わない即時処理）。
 * 再生成しないので数秒で終わり、顧客の API 費用もかからない。
 */
export async function reviseImagePosition(
  deps: ServiceDeps, articleId: string,
  op: { action: 'move'; index: number; headingIndex: number }
     | { action: 'swap'; a: number; b: number }
     | { action: 'remove'; index: number },
  /** 写真（既定）か、AI が作った文中画像か。どちらも純関数で即時・課金なし */
  kind: PlaceholderKind = 'photo',
): Promise<{ markdown: string; message: string }> {
  const a = await deps.db.getArticle(articleId);
  if (!a?.body_md) throw new Error('記事が見つかりません');

  let md = a.body_md;
  let message: string;
  const t = (n: number) => placeholderToken(n, kind);

  switch (op.action) {
    case 'move': {
      const headings = parseHeadings(md);
      md = move(md, op.index, op.headingIndex, kind);
      const name = headings[Math.min(op.headingIndex, headings.length - 1)]?.text ?? '末尾';
      message = `${t(op.index)} を「${name}」の下に移動しました`;
      break;
    }
    case 'swap':
      md = swap(md, op.a, op.b, kind);
      message = `${t(op.a)} と ${t(op.b)} を入れ替えました`;
      break;
    case 'remove':
      md = remove(md, op.index, kind);
      message = `${t(op.index)} を削除しました`;
      break;
  }

  await deps.db.updateArticle(articleId, { body_md: md });
  if (kind === 'generated') {
    if (op.action === 'remove') {
      // ★消した AI 画像は行と置き場も消す。残すと次の書き直しで使い回され、黙って戻ってくる（源蔵レビュー P3 必須2）
      await deleteGeneratedSlot(deps.db, deps.images, articleId, op.index);
    } else {
      // ★動かした番号の「作ったときの見出し」を今の位置に合わせる（誤警告・書き直しで元の位置へ戻るのを防ぐ）
      await syncGeneratedHeadings(deps.db, articleId, md, op.action === 'move' ? [op.index] : [op.a, op.b]);
    }
  }
  return { markdown: md, message };
}

/** ネタの文中から「キーワードは〜」の指定を拾う。 */
export function extractHintKeywords(text: string): string[] {
  const m = /(?:キーワード|KW)\s*(?:は|:|：)\s*(.+)/.exec(text);
  if (!m) return [];
  return m[1]
    .split(/[、,・\s]+/)
    .map((s) => s.replace(/[「」『』]/g, '').trim())
    .filter((s) => s.length > 0 && s.length < 40)
    .slice(0, 8);
}
