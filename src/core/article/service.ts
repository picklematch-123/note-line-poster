/**
 * 記事のライフサイクル操作。
 *
 * ★入口（LINE / REST / MCP）はここを呼ぶ。ここは入口を知らない。
 *   Phase 3 で MCP を足すとき、このファイルには手を入れない。
 */
import { Db, type ArticleRow, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { NoteClient, NoteApiError, type NoteSession } from '../../ports/publisher/note/client';
import { toNoteHtml, plainLength } from '../../ports/publisher/note/html';
import { AnthropicLlm, LlmError } from '../../ports/llm/anthropic';
import { generate } from '../generation/pipeline';
import { ensureContextUrls } from '../generation/context';
import { canPublish, type PolicyDecision } from '../policy';
import { assertTransition } from './state';
import { fill, normalize, parseHeadings, move, swap, remove } from './placeholders';
import type { ImageStore } from '../../ports/storage/images';
import { nowIso } from '../../lib/time';
import { log } from '../../lib/mask';

export interface ServiceDeps {
  db: Db;
  llmApiKey: string;
  llmWorkspaceId?: string | null;
  noteSession: NoteSession;
  ownerLineUserId: string | null;
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
export async function submitIdea(deps: ServiceDeps, sourceText: string, tenantId = DEFAULT_TENANT_ID) {
  await deps.db.ensureTenant(tenantId);
  return deps.db.createArticle(tenantId, sourceText);
}

/**
 * 記事を生成する（4ステップ）。
 * 画像は一時置き場（KV）から読み出して note へ上げ、[画像N] を実URLに解決する。
 */
export async function generateArticle(deps: ServiceDeps, articleId: string): Promise<GenerateResult> {
  const article = await deps.db.getArticle(articleId);
  if (!article) throw new Error('記事が見つかりません');

  assertTransition(article.state, 'generating');
  await deps.db.setState(articleId, article.state, 'generating', 'system');

  const images = await deps.db.listImages(articleId);
  const style = await deps.db.getActiveStyleProfile(article.tenant_id);
  const context = await deps.db.getActiveContext(article.tenant_id);

  const llm = new AnthropicLlm(deps.llmApiKey, deps.llmWorkspaceId);
  const hintKeywords = extractHintKeywords(article.source_text);

  // 修正指示は source_text に混ぜず、生成時にだけ足す。
  // 混ぜると修正のたびに元ネタが汚れ、指示が累積してしまう。
  const sourceText = article.revision_instruction
    ? `${article.source_text}\n\n【今回の修正指示】\n${article.revision_instruction}\n` +
      `※前回の記事はこの指示に沿って作り直してください。元のネタの意図は保つこと。`
    : article.source_text;

  const out = await generate(llm, {
    sourceText,
    hintKeywords,
    imageCount: images.length,
    stylePrompt: style?.prompt_snippet ?? null,
    // ★以前に登録されたプロフィールでも URL が落ちないよう、読み出すたびに補う
    contextPrompt: ensureContextUrls(context?.raw_text ?? null, context?.prompt_snippet ?? null),
  });

  await deps.db.updateArticle(articleId, {
    title: out.title,
    image_alts_json: JSON.stringify(out.imageAlts),
    body_md: out.markdown,
    meta_description: out.metaDescription,
    keywords_json: JSON.stringify(out.keywords),
    outline_json: JSON.stringify(out.outline),
    hashtags_json: JSON.stringify(out.hashtags),
    llm_input_tokens: out.usage.inputTokens,
    llm_output_tokens: out.usage.outputTokens,
  });
  await deps.db.setState(articleId, 'generating', 'preview_ready', 'system', {
    見出し数: parseHeadings(out.markdown).length,
  });

  const updated = (await deps.db.getArticle(articleId))!;
  return { article: updated, charCount: out.markdown.replace(/\[画像\d+\]/g, '').length };
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

    const md = normalize(a.body_md ?? '', images.length);
    const alts: Record<string, string> = a.image_alts_json ? JSON.parse(a.image_alts_json) : {};
    const html = toNoteHtml(fill(md, urls, alts));

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
 * 公開済みの記事を修正モードに戻す。
 * 再公開すると note 上の同じ記事が上書きされる（新しい記事は増えない）。
 */
export async function reopenPublished(deps: ServiceDeps, articleId: string): Promise<void> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');
  if (a.state !== 'published') return;
  // 再公開には改めて承認が必要
  await deps.db.updateArticle(articleId, { approved_at: null, approved_by: null });
  await deps.db.setState(articleId, 'published', 'editing', 'system');
}

/** プレビュー送信後に承認待ちへ。 */
export async function markAwaitingApproval(deps: ServiceDeps, articleId: string) {
  const a = await deps.db.getArticle(articleId);
  if (!a) return;
  assertTransition(a.state, 'awaiting_approval');
  await deps.db.setState(articleId, a.state, 'awaiting_approval', 'system');
}

/** 承認する。★承認できるのはオーナーだけ。 */
export async function approve(deps: ServiceDeps, articleId: string, byLineUserId: string): Promise<PolicyDecision> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');

  if (deps.ownerLineUserId && byLineUserId !== deps.ownerLineUserId) {
    await deps.db.audit(a.tenant_id, 'publish.denied', `line:${byLineUserId}`, articleId, 'denied', { reason: 'wrong_approver' });
    return { allowed: false, reason: 'wrong_approver', retryable: false,
      userMessage: 'この記事を公開できるのはアカウントの持ち主だけです。' };
  }

  await deps.db.updateArticle(articleId, { approved_at: nowIso(), approved_by: byLineUserId });
  return { allowed: true };
}

/** ポリシー判定を行う。公開の直前に必ず呼ぶ。 */
export async function checkPolicy(deps: ServiceDeps, articleId: string): Promise<PolicyDecision> {
  const a = await deps.db.getArticle(articleId);
  if (!a) throw new Error('記事が見つかりません');
  const tenant = await deps.db.ensureTenant(a.tenant_id);

  return canPublish({
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
    todayPublishCount: await deps.db.todayPublishCount(a.tenant_id),
    lastPublishedAt: await deps.db.lastPublishedAt(a.tenant_id),
    globalRecentCount: await deps.db.globalRecentCount(),
    globalLimitPerMinute: await deps.db.getNumberFlag('global_limit_per_minute', 3),
    // すでに note 上に記事があるなら、これは上書き更新
    isUpdate: Boolean(a.note_id),
  });
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

    const md = normalize(a.body_md ?? '', images.length);
    const alts: Record<string, string> = a.image_alts_json ? JSON.parse(a.image_alts_json) : {};
    const html = toNoteHtml(fill(md, urls, alts));
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
): Promise<{ markdown: string; message: string }> {
  const a = await deps.db.getArticle(articleId);
  if (!a?.body_md) throw new Error('記事が見つかりません');

  let md = a.body_md;
  let message: string;

  switch (op.action) {
    case 'move': {
      const headings = parseHeadings(md);
      md = move(md, op.index, op.headingIndex);
      const name = headings[Math.min(op.headingIndex, headings.length - 1)]?.text ?? '末尾';
      message = `[画像${op.index}] を「${name}」の下に移動しました`;
      break;
    }
    case 'swap':
      md = swap(md, op.a, op.b);
      message = `[画像${op.a}] と [画像${op.b}] を入れ替えました`;
      break;
    case 'remove':
      md = remove(md, op.index);
      message = `[画像${op.index}] を削除しました`;
      break;
  }

  await deps.db.updateArticle(articleId, { body_md: md });
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
