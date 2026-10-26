/**
 * LINE Webhook ハンドラ。
 *
 * ★このファイルの責務は3つだけ:
 *   1. 署名を検証して送信者を確定する
 *   2. LINE のイベントをドメインの操作に変換する
 *   3. 結果を LINE の表現に整形して返す
 * ドメイン層（core/）は LINE を知らない。
 */
import type { Env } from '../../env';
import { Db, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { verifyLineSignature } from './signature';
import { LineClient, text, textWithActions, type LineMessage } from './client';
import {
  submitIdea, approve, publishArticle, checkPolicy, reviseImagePosition, requestRewrite,
  reopenPublished, setEyecatch, clearEyecatch, saveArticleAsDraft, PolicyBlockedError, type ServiceDeps,
} from '../../core/article/service';
import { NoteApiError } from '../../ports/publisher/note/client';
import { DisallowedLinksError, linkBlockRecipients } from '../../core/article/links';
import { LlmError } from '../../ports/llm/types';
import { createLlm, llmConfigFromEnv } from '../../ports/llm';
import { RevisionIntent } from '../../core/generation/schema';
import { analyzeContext } from '../../core/generation/pipeline';
import { buildContextSnippet, listEntries, removeEntry } from '../../core/generation/context';
import { classifyRevision } from '../../core/generation/prompts';
import { parseHeadings, parse as parsePlaceholders } from '../../core/article/placeholders';
import { buildPreview } from './messages/preview';
import { buildFullText } from './messages/fulltext';
import { buildMenu, buildArticleList, buildArticleActions } from './messages/menu';
import { setMode, getMode, clearMode, parseIndex, normalizeCommand } from './mode';
import { COMMANDS } from './commands';
import { resolveNoteSession, persistRefreshedCookie } from '../../core/session/resolve';
import { issuePairingCode } from '../../core/session/pairing';
import { loadNoteSession, disconnectNoteSession } from '../../core/session/store';
import { buildConnectGuide, buildConnectStatus } from './messages/connect';
import { dispatchPublish, withdrawJobs } from '../../core/agent/dispatch';
import { reconcilePublished } from '../../core/article/reconcile';
import { isAgentOnline, hasDevice, revokeDevices } from '../../core/agent/jobs';
import {
  buildSettings, buildDailyLimitChoices, buildIntervalChoices, buildModeChoices,
  buildSettingsSaved, type SettingsView,
} from './messages/settings';
import { parseDailyLimit, parseIntervalSec } from '../../core/policy/options';
import { KvImageStore } from '../../ports/storage/images';
import { newId } from '../../lib/id';
import { log } from '../../lib/mask';
import { getThumbSettings, setThumbAuto, setThumbDailyLimit, DAILY_LIMIT_OPTIONS, NOTE_NO_KEY } from '../../core/image/thumbnail';
import { buildThumbSettings } from './messages/thumbnail';
import { buildAiSettings, buildDomainChoices, buildResearchLimitChoices } from './messages/research';
import { buildImageRulesSummary } from './messages/image-rules';
import { loadImageRulesSummary } from '../../core/image/rules';
import { getResearchSettings, applyResearchSetting } from '../../core/research/settings';
import { canRedoResearch } from '../../core/research/run';
import { createResearchLlm } from '../../ports/llm';
import { canUse, isOwner, roleOf, NOT_OWNER_MESSAGE, OWNER_ONLY_MESSAGE } from '../../core/line/access';
import {
  openInvite, peekInvite, closeInvite, MAX_STAFF,
  savePending, getPending, deletePending, listPending, decideTypedMemberCommand,
  buildInviteOpened, buildWelcomeStaff, buildStaffAddedNotice,
  buildApprovalRequest, buildWaitingForApproval,
} from '../../core/line/members';
import { otherWorkInProgress } from '../../core/article/ownership';
import { buildProvisionalSnippet } from '../../core/generation/context';
import { buildKnowledgeReceived } from './messages/knowledge';
import { issueSetupCode } from '../../core/setup/state';
import { resolveMasterKey } from '../../core/setup/masterkey';
import { validateIdeaLength } from '../../core/line/idea-input';
import { formatRevisionWaitMessage } from '../../core/generation/estimate';
import {
  getInlineSettings, applyInlineSetting, effectiveInlineCount, inlineWaitNote, hasImageKey, loadInlineView,
  countInlineForArticle, MAX_INLINE_PER_ARTICLE, NOTE_ARTICLE_LIMIT,
} from '../../core/image/inline';
import { buildInlineCountChoices, buildInlineLimitChoices, buildAiImageReviewPrompt } from './messages/inline';
import {
  startLockedImageJob, regenStateCheck, NOTE_STILL_GENERATING, NOTE_INLINE_LOCKED, NOTE_THUMB_LOCKED,
} from '../../core/image/lock';
import { needsAiImageReview, markAiImagesConfirmed } from '../../core/image/review';

/** 画像の到着を待つ秒数 */
const DEBOUNCE_SEC = 60;
/**
 * サムネイル指定の言い回し。
 * よくある言い方は LLM を通さずここで拾う（即時・API費用ゼロ）。
 */
const EYECATCH_RE = /(サムネ|さむね|アイキャッチ|見出し画像|トップ画像|ヘッダー画像|カバー画像)/;

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string; text?: string };
  postback?: { data: string };
}

/**
 * ★note セッションは必ず resolveNoteSession を通す。
 *   拡張機能で連携されていれば D1（暗号化）から、無ければ環境変数から取る。
 */
async function deps(env: Env): Promise<ServiceDeps> {
  const { session, origin } = await resolveNoteSession(env);
  return {
    db: new Db(env.DB),
    llm: llmConfigFromEnv(env),
    noteSession: session,
    ownerLineUserId: env.LINE_OWNER_USER_ID || null,
    images: new KvImageStore(env.KV),
    onCookieRefresh: (cookieHeader) => persistRefreshedCookie(env, origin, cookieHeader),
  };
}

/** ctx は waitUntil さえ持っていればよい（Hono と Workers の ExecutionContext 型差を吸収する）。 */
export async function handleLineWebhook(
  req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const body = await req.text();

  // ★署名検証を通らないリクエストは一切処理しない
  const ok = await verifyLineSignature(body, req.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET);
  if (!ok) {
    log.warn('LINE 署名検証に失敗');
    return new Response('invalid signature', { status: 401 });
  }

  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(body).events ?? []) as LineEvent[];
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // LINE は 200 を速く返さないと再送してくるので、処理は待たない
  ctx.waitUntil(
    Promise.all(events.map((e) => handleEvent(e, env).catch((err) => {
      log.error('イベント処理でエラー', String(err));
    }))),
  );
  return new Response('ok');
}

async function handleEvent(event: LineEvent, env: Env): Promise<void> {
  const userId = event.source?.userId;
  if (!userId) return;

  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV);
  const d = await deps(env);

  // ★オーナー（承認できる唯一の人）を決める。
  // env に設定があればそれを使い、無ければ「最初に話しかけた人」を登録する。
  // ユーザーIDを手で転記させないための仕組み。
  await d.db.ensureTenant(DEFAULT_TENANT_ID);
  const { ownerId, justRegistered } = env.LINE_OWNER_USER_ID
    ? { ownerId: env.LINE_OWNER_USER_ID, justRegistered: false }
    : await d.db.resolveOwnerLineUserId(DEFAULT_TENANT_ID, userId);
  d.ownerLineUserId = ownerId;

  if (justRegistered) {
    log.info('オーナーを登録しました');
    await line.push(userId, [text(
      'このアカウントの持ち主として登録しました。\n' +
      'これ以降、記事を公開できるのはあなただけになります。'
    )]);
  }

  // ★持ち主以外は、ここから先へ通さない（2026-08-31 源蔵レビュー指摘）。
  //   公開だけを守っていたが、記事生成は毎回 Claude を呼ぶ＝顧客の残高が減る。
  //   ナレッジを書き換えられると、以後の記事すべてに影響が残る。
  //   友だち追加さえすれば誰でもできる状態だった。
  d.staffLineUserIds = await d.db.listStaffIds(DEFAULT_TENANT_ID);

  // ★投稿者の受付（持ち主が「投稿者を追加」と送ってから10分間だけ開く）。
  //   持ち主でも投稿者でもない人が話しかけてきたら、窓口を閉じて**持ち主に確認を送る**。
  //   話しかけただけでは投稿者にしない（源蔵レビュー条件2: メニューを1回押しただけで登録される事故を防ぐ）。
  //   友だち追加（follow）だけでは受け付けない。本人が話しかけたときに限る。
  if (roleOf(d.ownerLineUserId, userId, d.staffLineUserIds) === 'guest'
      && (event.type === 'message' || event.type === 'postback')) {
    if (await getPending(env.KV, DEFAULT_TENANT_ID, userId)) {
      if (event.replyToken) await line.reply(event.replyToken, [text(buildWaitingForApproval())]);
      return;
    }
    const invite = await peekInvite(env.KV, DEFAULT_TENANT_ID);
    if (invite) {
      await closeInvite(env.KV, DEFAULT_TENANT_ID);
      // ★窓口を開けた人が、いまも持ち主であること（その後に持ち主が変わっていたら無効）
      if (invite.by === d.ownerLineUserId) {
        const profile = await line.getProfile(userId);
        const name = profile?.displayName ?? null;
        await savePending(env.KV, DEFAULT_TENANT_ID, {
          userId, displayName: name, invitedBy: invite.by, requestedAt: new Date().toISOString(),
        });
        await d.db.audit(DEFAULT_TENANT_ID, 'member.requested', `line:${userId}`, null, 'ok', { displayName: name });
        if (event.replyToken) await line.reply(event.replyToken, [text(buildWaitingForApproval())]);
        await line.push(invite.by, [approvalMessage(name, userId)]);
        return;
      }
    }
  }

  if (!canUse(d.ownerLineUserId, userId, d.staffLineUserIds)) {
    log.warn('持ち主以外からの操作を断りました');
    const token = event.replyToken;
    if (token && (event.type === 'message' || event.type === 'postback')) {
      await line.reply(token, [text(NOT_OWNER_MESSAGE)]);
    }
    return;
  }

  switch (event.type) {
    case 'follow':
      await line.reply(event.replyToken!, [
        text(
          'はじめまして。ネタを送るだけで、note の記事にして投稿します。\n\n' +
          '最初に「ナレッジ」で、お店や事業のことを覚えさせておくのがおすすめです。\n' +
          '同じネタでも、記事の中身がまるごと変わります。あとからいくらでも足せます。'
        ),
        buildMenu(),
      ]);
      return;

    case 'message':
      if (event.message?.type === 'text') return guard(event, line, () => handleText(event, env, line, d, userId));
      if (event.message?.type === 'image') return guard(event, line, () => handleImage(event, env, line, d, userId));
      return;

    case 'postback':
      return guard(event, line, () => handlePostback(event, env, line, d, userId));
  }
}

/**
 * 処理中に例外が出ても、必ず何か返す。
 *
 * ★無言で落ちるのが一番たちが悪い。
 *   ボタンを押しても無反応で、しかも状態が変わらないので操作が詰まる
 *   （2026-08-28 の不具合はこれで発覚が遅れた）。
 */
async function guard(
  event: LineEvent, line: LineClient, fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error('イベント処理で例外', String(e));
    if (event.replyToken) {
      await line.reply(event.replyToken, [text(
        'うまく処理できませんでした。\n' +
        'お手数ですが、もう一度お試しください。\n\n' +
        '操作が詰まってしまった場合は「メニュー」と送ってください。'
      )]).catch(() => { /* 返信も失敗したら諦める */ });
    }
  }
}

/** 「自分の作業中の記事」を探すときの指定。担当者が空の古い記事は持ち主のもの */
function me(d: ServiceDeps, userId: string) {
  return { userId, isOwner: isOwner(d.ownerLineUserId, userId) };
}

/**
 * その人が「別の記事」を作業中なら、その記事を返す（担当を引き受けさせない）。
 * ★作業中の記事を1人2本にすると、次の指示や「OK」が開いたつもりの記事ではない方に届く。
 */
async function busyWithOther(d: ServiceDeps, userId: string, articleId: string) {
  return otherWorkInProgress(await d.db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, me(d, userId)), articleId);
}

/** 投稿者が、持ち主だけの操作をしようとしたとき */
async function ownerOnly(line: LineClient, replyToken: string): Promise<void> {
  await line.reply(replyToken, [text(OWNER_ONLY_MESSAGE)]);
}

/** 投稿者の受付を開く（持ち主だけ） */
async function startMemberInvite(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  if ((d.staffLineUserIds ?? []).length >= MAX_STAFF) {
    await line.reply(replyToken, [text(
      `投稿者は${MAX_STAFF}人までです。\n「投稿者一覧」から誰かを外してから、もう一度お試しください。`,
    )]);
    return;
  }
  await openInvite(env.KV, DEFAULT_TENANT_ID, userId);
  await line.reply(replyToken, [text(buildInviteOpened())]);
}

/** 投稿者の一覧と、外すボタン（持ち主だけ） */
async function showMembers(line: LineClient, d: ServiceDeps, replyToken: string): Promise<void> {
  const staff = await d.db.listStaff(DEFAULT_TENANT_ID);
  if (staff.length === 0) {
    await line.reply(replyToken, [text(
      '投稿者はまだいません。\n\n「投稿者を追加」と送ると、追加の受付を始めます。',
    )]);
    return;
  }
  await line.reply(replyToken, [textWithActions(
    `【投稿者】${staff.length}人\n\n` +
    staff.map((m, i) => `${i + 1}. ${m.display_name ?? '（名前なし）'}`).join('\n') +
    '\n\n外したい人の番号を押してください。',
    staff.slice(0, 12).map((m, i) => ({ label: `${i + 1}を外す`, data: `action=member_remove&uid=${m.line_user_id}` })),
  )]);
}

// ── 投稿者の承認（ボタンと文字の両方から呼ぶ）──────────────
const PENDING_GONE_MESSAGE =
  'この確認は、期限が切れたか、すでに済んでいます。\n' +
  '追加する場合は、もう一度「投稿者を追加」と送ってください。';

/** 持ち主への確認のお知らせ（ボタンつき） */
function approvalMessage(displayName: string | null, uid: string): LineMessage {
  return textWithActions(buildApprovalRequest(displayName), [
    { label: '投稿者にする', data: `action=member_approve&uid=${uid}` },
    { label: '断る', data: `action=member_reject&uid=${uid}` },
  ]);
}

async function approveMember(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, ownerId: string, uid: string,
): Promise<void> {
  // ★確認待ちの記録がある人にしか効かない（ボタンの中身を書き換えて別人を登録させない）
  const pending = await getPending(env.KV, DEFAULT_TENANT_ID, uid);
  if (!pending) {
    await line.reply(replyToken, [text(PENDING_GONE_MESSAGE)]);
    return;
  }
  const result = await d.db.addStaff(DEFAULT_TENANT_ID, uid, pending.displayName, ownerId, MAX_STAFF);
  if (result === 'full') {
    await line.reply(replyToken, [text(
      `投稿者は${MAX_STAFF}人までです。\n「投稿者一覧」から誰かを外してから、もう一度「投稿者にする」を押してください。`,
    )]);
    return;
  }
  await deletePending(env.KV, DEFAULT_TENANT_ID, uid);
  if (result === 'exists') {
    // ★すでに投稿者。案内は送らないので「送りました」と言わない
    await line.reply(replyToken, [text('この方は、すでに投稿者です。')]);
    return;
  }
  await line.reply(replyToken, [text(buildStaffAddedNotice(pending.displayName))]);
  await line.push(uid, [text(buildWelcomeStaff())]);
}

async function rejectMember(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, ownerId: string, uid: string,
): Promise<void> {
  const pending = await getPending(env.KV, DEFAULT_TENANT_ID, uid);
  await deletePending(env.KV, DEFAULT_TENANT_ID, uid);
  if (pending) {
    await d.db.audit(DEFAULT_TENANT_ID, 'member.rejected', `line:${ownerId}`, null, 'ok', { userId: uid });
  }
  // ★断られた本人には知らせない（何が動いているかを教えない）
  await line.reply(replyToken, [text(pending ? '登録しませんでした。' : 'この確認は、すでに済んでいます。')]);
}

// ── テキスト ────────────────────────────────────────────
async function handleText(
  event: LineEvent, env: Env, line: LineClient, d: ServiceDeps, userId: string,
): Promise<void> {
  const body = (event.message?.text ?? '').trim();
  const replyToken = event.replyToken!;

  // ── 1. コマンド（いつでも受け付ける。モードより優先）──────
  // ★リッチメニューは GUI でも作れるので、文字コードの揺れを吸収してから判定する
  const cmd = normalizeCommand(body);

  if (COMMANDS.menu.test(cmd)) {
    await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
    await line.reply(replyToken, [buildMenu()]);
    return;
  }
  // ★リッチメニューのボタンが送る文言。ここを変えるときは
  //   scripts/setup-richmenu.mjs のラベルも合わせること。
  // ★呼び名は「ナレッジ」に寄せたが、リッチメニューの文言も引き続き受ける
  if (COMMANDS.knowledge.test(cmd)) {
    return showContext(env, line, d, replyToken, userId);
  }
  if (COMMANDS.newArticle.test(cmd)) {
    return startArticleInput(env, line, replyToken, userId);
  }
  if (COMMANDS.articleList.test(cmd)) {
    return showArticleList(env, line, d, replyToken, userId);
  }

  // ── note 連携（Chrome 拡張）────────────────────────────
  // ★これが無いと、顧客に DevTools を開かせることになる。
  if (COMMANDS.connect.test(cmd)) {
    return startNoteConnect(env, line, d, replyToken, userId);
  }
  if (COMMANDS.connectStatus.test(cmd)) {
    return showConnectStatus(env, line, replyToken);
  }
  if (COMMANDS.disconnect.test(cmd)) {
    return doDisconnect(env, line, d, replyToken, userId);
  }
  // ★ここから下の3つは持ち主だけ（投稿者を足したので、入口の判定だけでは足りない）
  if (COMMANDS.setupCode.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return sendSetupCode(env, line, replyToken);
  }
  if (COMMANDS.ownerReset.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return resetOwner(env, line, d, replyToken, userId);
  }
  if (COMMANDS.memberAdd.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return startMemberInvite(env, line, d, replyToken, userId);
  }
  if (COMMANDS.memberList.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return showMembers(line, d, replyToken);
  }
  // ★「投稿者にする」「断る」が、ボタンの合図ではなく文字で届くことがある（2026-09-15 実際に発生）。
  //   確認待ちが1人だけなら、その人のこととして扱う。2人以上なら取り違えないようボタンを出し直す。
  if (isOwner(d.ownerLineUserId, userId)
      && (COMMANDS.memberApprove.test(cmd) || COMMANDS.memberReject.test(cmd))) {
    const decision = decideTypedMemberCommand({
      isOwner: true,
      approving: COMMANDS.memberApprove.test(cmd),
      pendings: await listPending(env.KV, DEFAULT_TENANT_ID),
      inviteOpen: (await peekInvite(env.KV, DEFAULT_TENANT_ID)) !== null,
    });
    switch (decision.kind) {
      case 'approve':
        return approveMember(env, line, d, replyToken, userId, decision.userId);
      case 'reject':
        return rejectMember(env, line, d, replyToken, userId, decision.userId);
      case 'ask':
        // ★ボタンは最後の1通にしか出ないので、1人ずつ出す。片付けたら、もう一度送ると次の人が出る
        await line.reply(replyToken, [
          text(`確認待ちの方が${decision.total}人います。人違いを防ぐため、1人ずつ確認します。`),
          approvalMessage(decision.pending.displayName, decision.pending.userId),
        ]);
        return;
      case 'not_yet':
        await line.reply(replyToken, [text(
          'まだ誰からも届いていません。\n追加したい人がこのアカウントへ1通送ると、確認のお知らせが届きます。',
        )]);
        return;
      case 'gone':
        await line.reply(replyToken, [text(PENDING_GONE_MESSAGE)]);
        return;
      case 'ignore':
        break; // 確認待ちが無いときの「断る」は、ふつうのメッセージとして下へ流す
    }
  }
  if (COMMANDS.settings.test(cmd)) {
    return showSettings(env, line, d, replyToken);
  }
  if (COMMANDS.moreSettings.test(cmd)) {
    return showMoreSettings(line, d, replyToken, userId);
  }
  if (COMMANDS.aiSettings.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return showAiSettings(env, line, d, replyToken);
  }
  if (COMMANDS.thumbSettings.test(cmd)) {
    if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
    return showThumbSettings(env, line, d, replyToken);
  }

  // ── 2. いま何を待っているか（モード）─────────────────────
  const mode = await getMode(env.KV, DEFAULT_TENANT_ID, userId);

  if (mode?.kind === 'ctx_delete') {
    await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
    if (/^(やめ|キャンセル|中止)/.test(body)) {
      await line.reply(replyToken, [text('消すのをやめました。')]);
      return;
    }
    const n = parseIndex(body);
    if (!n) {
      await line.reply(replyToken, [text('番号を送ってください。')]);
      return;
    }
    return deleteContextEntry(n, env, line, d, replyToken, userId);
  }

  if (mode?.kind === 'ctx_new' || mode?.kind === 'ctx_append') {
    await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
    if (/^(やめ|キャンセル|中止)/.test(body)) {
      await line.reply(replyToken, [text('登録をやめました。')]);
      return;
    }
    return saveContext(body, mode.kind === 'ctx_append', env, line, d, replyToken, userId);
  }

  if (mode?.kind === 'article_select') {
    const n = parseIndex(body);
    if (n && mode.ids && n <= mode.ids.length) {
      await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
      const a = await d.db.getArticle(mode.ids[n - 1]);
      if (!a) {
        await line.reply(replyToken, [text('その記事が見つかりませんでした。')]);
        return;
      }
      await line.reply(replyToken, [buildArticleActions(a)]);
      return;
    }
    if (/^(やめ|キャンセル|中止)/.test(body)) {
      await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
      await line.reply(replyToken, [text('一覧を閉じました。')]);
      return;
    }
    // 番号でなければ、そのまま新しいネタとして扱う
    await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
  }

  if (mode?.kind === 'article_new') {
    await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
    if (/^(やめ|キャンセル|中止)/.test(body)) {
      await line.reply(replyToken, [text('作成をやめました。')]);
      return;
    }
    // 前の記事が片付いていなければ、そちらを先に終わらせてもらう
    const pending = await d.db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, me(d, userId));
    if (pending) {
      await line.reply(replyToken, [buildPendingNotice(pending)]);
      return;
    }
    if (!validateIdeaLength(body).valid) {
      await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'article_new' });
      await line.reply(replyToken, [text(
        'もう少し詳しく教えてください。\n' +
        '何について書きたいか、誰に向けてか、狙いたいキーワードがあると記事が良くなります。'
      )]);
      return;
    }
    return startGeneration(body, env, line, d, replyToken, userId);
  }

  // ── 3. いま判断待ちの記事があるか ───────────────────────
  // ★これがある間は新しい記事を作らない（運用側の判断 2026-08-28）。
  //   記事を書いている途中に別の記事を書くことは実際には無く、
  //   誤って別記事が生まれるほうが害が大きい。
  const active = await d.db.findArticleAwaitingDecision(DEFAULT_TENANT_ID, me(d, userId));

  // 生成に失敗した記事があるなら、この発言は「やり直しの指示」
  if (active && active.state === 'failed') {
    if (/^(やめ|キャンセル|中止|いいえ|新し)/.test(body)) {
      await withdrawJobs(d, active.id);
      await d.db.setState(active.id, 'failed', 'cancelled', `line:${userId}`);
      await line.reply(replyToken, [text('前の記事は取りやめました。新しいネタを送ってください。')]);
      return;
    }
    await requestRewrite(d, active.id, body);
    await env.GENERATE.create({ params: { articleId: active.id, lineUserId: userId, debounceSec: 0 } });
    await line.reply(replyToken, [text(`前回は失敗したので、その内容で${formatRevisionWaitMessage()}`)]);
    return;
  }

  // 記事の作成中に来た指示も拾う。
  // ここを素通りさせると「新しいネタ」と誤解して別の記事を作ってしまう。
  if (active && (active.state === 'received' || active.state === 'generating' || active.state === 'preview_ready')) {
    if (EYECATCH_RE.test(body)) {
      try {
        const { message } = await setEyecatch(d, active.id, null);
        await line.reply(replyToken, [text(message)]);
      } catch (e) {
        await line.reply(replyToken, [text(e instanceof Error ? e.message : 'サムネイルを設定できませんでした。')]);
      }
      return;
    }
    if (/サムネ.*(外|消|やめ)|見出し画像.*(外|消)/.test(body)) {
      await clearEyecatch(d, active.id);
      await line.reply(replyToken, [text('サムネイルの指定を外しました。')]);
      return;
    }
    if (/^(やめ|キャンセル|中止)/.test(body)) {
      await withdrawJobs(d, active.id);
      await d.db.setState(active.id, active.state, 'cancelled', `line:${userId}`);
      await line.reply(replyToken, [text('作成中の記事を取りやめました。新しいネタを送ってください。')]);
      return;
    }
    // ★新しいネタとして扱わない。いま作っている記事の続きを待たせる
    await line.reply(replyToken, [textWithActions(
      'いま記事を作っています。もう少しお待ちください。\n\n' +
      '画像を追加したい場合はこのまま送れます。\n' +
      'この記事をやめる場合は下のボタンを押してください。',
      [{ label: 'この記事をやめる', data: `action=cancel&id=${active.id}` }],
    )]);
    return;
  }

  // 承認待ちの記事があるなら、この発言は「承認」か「修正指示」
  if (active && (active.state === 'awaiting_approval' || active.state === 'editing')) {
    if (/^(公開|OK|ok|はい|投稿)/.test(body)) {
      return publishAfterAiImageReview(active.id, env, line, d, userId, replyToken);
    }
    if (/^(下書き|したがき)/.test(body)) {
      return doSaveDraft(active.id, line, d, userId, replyToken);
    }
    if (/^(全文|本文|ぜんぶん|読みたい|見せて)/.test(body)) {
      await line.reply(replyToken, buildFullText({
        articleId: active.id,
        title: active.title ?? '無題',
        markdown: active.body_md ?? '',
        metaDescription: active.meta_description ?? '',
        hashtags: active.hashtags_json ? JSON.parse(active.hashtags_json) : [],
        imageCount: parsePlaceholders(active.body_md ?? '').length,
      }));
      return;
    }
    if (/^(やめ|キャンセル|中止|いいえ)/.test(body)) {
      await d.db.setState(active.id, active.state, 'cancelled', `line:${userId}`);
      await line.reply(replyToken, [text('この記事は取りやめました。')]);
      return;
    }
    return handleRevision(active.id, body, env, line, d, replyToken, userId);
  }

  // ── 4. どれにも当てはまらない ───────────────────────────
  // ★判断待ちの記事が残っていれば、新しい記事は作らない
  if (active) {
    await line.reply(replyToken, [buildPendingNotice(active)]);
    return;
  }
  // 3〜500文字ならネタとして受け付ける。範囲外はメニューを出す。
  if (!validateIdeaLength(body).valid) {
    await line.reply(replyToken, [buildMenu()]);
    return;
  }
  return startGeneration(body, env, line, d, replyToken, userId);
}

/** 前の記事が片付いていないことを伝える。 */
function buildPendingNotice(a: { id: string; title: string | null; state: string }): LineMessage {
  return textWithActions(
    `先に「${a.title ?? '作成中の記事'}」を片付けてください。\n\n` +
    '「公開する」「下書きに保存する」「やめる」のどれかを選ぶと、次の記事を作れます。',
    [
      { label: '公開する', data: `action=publish&id=${a.id}` },
      { label: '下書きに保存する', data: `action=savedraft&id=${a.id}` },
      { label: '全文を読む', data: `action=fulltext&id=${a.id}` },
      { label: 'やめる', data: `action=cancel&id=${a.id}` },
    ],
  );
}

/** 記事のネタ入力を待つ状態にする。 */
async function startArticleInput(env: Env, line: LineClient, replyToken: string, userId: string): Promise<void> {
  await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'article_new' });
  await line.reply(replyToken, [text(
    '記事にしたいネタを送ってください。\n\n' +
    '画像は、ネタを送ったあとに続けて送ってください。'
  )]);
}

/** ネタを受け付けて生成を始める。 */
async function startGeneration(
  body: string, env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  const article = await submitIdea(d, body, DEFAULT_TENANT_ID, userId);
  await env.GENERATE.create({
    params: { articleId: article.id, lineUserId: userId, debounceSec: DEBOUNCE_SEC },
  });
  // 文中の画像を作る設定なら、その分の待ち時間も先に伝える（短く約束しない）
  const inlineNote = inlineWaitNote(await effectiveInlineCount(d.db, env.OPENAI_API_KEY));
  await line.reply(replyToken, [text(
    '受け付けました。\n' +
    '画像があれば続けて送ってください。\n\n' +
    `最後のメッセージから約${DEBOUNCE_SEC}秒後に書き始めて、1〜3分でお送りします。` +
    (inlineNote ? `\n${inlineNote}` : '')
  )]);
}

/** 過去の記事を連番つきで一覧表示し、番号待ちにする。 */
async function showArticleList(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  // ★note の画面から消された記事を、先に一覧から外す。
  //   ここを飛ばすと、開いても 404 になる記事が並ぶ。
  //   note に問い合わせできなければ何も変えない（失敗を「消えた」と取り違えない）。
  await reconcilePublished(d.db, DEFAULT_TENANT_ID, d.noteSession.urlname);

  const articles = await d.db.listRecentArticles(DEFAULT_TENANT_ID, 10);
  if (articles.length > 0) {
    await setMode(env.KV, DEFAULT_TENANT_ID, userId, {
      kind: 'article_select',
      ids: articles.map((a) => a.id),
    });
  }
  await line.reply(replyToken, [buildArticleList(articles)]);
}

// ── 画像 ────────────────────────────────────────────────
async function handleImage(
  event: LineEvent, env: Env, line: LineClient, d: ServiceDeps, userId: string,
): Promise<void> {
  const messageId = event.message!.id;
  const active = await d.db.findActiveArticle(DEFAULT_TENANT_ID, me(d, userId));

  if (!active || !['received', 'generating'].includes(active.state)) {
    await line.reply(event.replyToken!, [text(
      '先に記事のネタを送ってください。そのあとで画像を送ると記事に入れられます。'
    )]);
    return;
  }

  const { bytes, contentType } = await line.getContent(messageId);
  const key = `${active.tenant_id}/${active.id}/${newId()}`;
  await d.images.put(key, bytes, contentType);
  await d.db.addImage(active.tenant_id, {
    articleId: active.id,
    r2Key: key,
    mimeType: contentType,
    sizeBytes: bytes.byteLength,
    lineMessageId: messageId,
  });

  const all = await d.db.listAllImages(active.id);
  const count = all.length;
  await line.reply(event.replyToken!, [textWithActions(
    `画像を受け取りました（${count}枚目）\n\n` +
    'このまま続けて画像を送れます。\n' +
    'サムネイル（見出し画像）にしたい場合は下のボタンを押してください。',
    [
      { label: 'この画像をサムネに', data: `action=eyecatch&id=${active.id}&slot=${count}` },
      ...(count > 1 ? [{ label: 'サムネを外す', data: `action=eyecatch_clear&id=${active.id}` }] : []),
    ],
  )]);
}

// ── ボタン ──────────────────────────────────────────────
async function handlePostback(
  event: LineEvent, env: Env, line: LineClient, d: ServiceDeps, userId: string,
): Promise<void> {
  const params = new URLSearchParams(event.postback?.data ?? '');
  const action = params.get('action');
  const replyToken = event.replyToken!;

  // 記事に紐づかない操作（メニュー・ナレッジ）はここで処理する
  switch (action) {
    case 'menu_new':
      return startArticleInput(env, line, replyToken, userId);


    case 'menu_list':
      return showArticleList(env, line, d, replyToken, userId);

    case 'menu_profile':
      return showContext(env, line, d, replyToken, userId);

    case 'member_approve':
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      return approveMember(env, line, d, replyToken, userId, params.get('uid') ?? '');

    case 'member_reject':
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      return rejectMember(env, line, d, replyToken, userId, params.get('uid') ?? '');

    case 'member_remove': {
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      const uid = params.get('uid') ?? '';
      const removed = uid ? await d.db.removeStaff(DEFAULT_TENANT_ID, uid, `line:${userId}`) : false;
      await line.reply(replyToken, [text(removed
        ? '投稿者から外しました。\nこの人は、このアカウントで記事を作ったり公開したりできなくなります。\n' +
          '作りかけの記事があれば、「過去記事一覧」から続きを操作できます。'
        : 'その人は、すでに投稿者ではありません。')]);
      return;
    }

    case 'menu_cancel':
      await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
      await line.reply(replyToken, [text('閉じました。「メニュー」と送ると、いつでも操作を出せます。')]);
      return;

    case 'ctx_append':
      await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'ctx_append' });
      await line.reply(replyToken, [textWithActions(
        '書き足したい内容を送ってください。いまの内容は残ります。\n\n' +
        '例:\n' +
        '・新しく始めたメニューのこと\n' +
        '・お客さんからよく聞かれること\n' +
        '・記事で触れてほしくないこと',
        [{ label: 'やめる', data: 'action=ctx_cancel' }],
      )]);
      return;

    case 'ctx_replace':
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'ctx_new' });
      await line.reply(replyToken, [textWithActions(
        '新しい内容を送ってください。いまの設定は置き換わります。',
        [{ label: 'やめる', data: 'action=ctx_cancel' }],
      )]);
      return;

    case 'ctx_cancel':
      await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
      await line.reply(replyToken, [text('登録をやめました。')]);
      return;

    case 'ctx_clear':
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      await clearMode(env.KV, DEFAULT_TENANT_ID, userId);
      await d.db.clearContext(DEFAULT_TENANT_ID);
      await line.reply(replyToken, [text('設定を消しました。今後は前提なしで記事を書きます。')]);
      return;

    case 'ctx_delete': {
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      const current = await d.db.getActiveContext(DEFAULT_TENANT_ID);
      const entries = current ? listEntries(current.raw_text) : [];
      if (entries.length === 0) {
        await line.reply(replyToken, [text('まだ何も覚えていません。')]);
        return;
      }
      await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'ctx_delete' });
      await line.reply(replyToken, [{
        type: 'text',
        text: '消したいものの番号を送ってください。\n（一覧は「ナレッジ」で見られます）',
        quickReply: {
          items: [
            ...entries.slice(0, 12).map((_, i) => ({
              type: 'action' as const,
              action: { type: 'message' as const, label: String(i + 1), text: String(i + 1) },
            })),
            { type: 'action' as const, action: { type: 'postback' as const, label: 'やめる', data: 'action=ctx_cancel', displayText: 'やめる' } },
          ],
        },
      }]);
      return;
    }

    case 'ctx_full': {
      const current = await d.db.getActiveContext(DEFAULT_TENANT_ID);
      if (!current) {
        await line.reply(replyToken, [text('まだ何も覚えていません。')]);
        return;
      }
      // LINE の1通の上限に収まるよう、必要なら分けて送る
      const chunks = splitForLine(current.raw_text);
      await line.reply(replyToken, chunks.slice(0, 5).map((c) => text(c)));
      return;
    }

    case 'ctx_edit':
      return showContext(env, line, d, replyToken, userId);

    // ★サムネの設定は費用に直結するので持ち主だけ
    case 'thumb_auto': {
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      await setThumbAuto(d.db, params.get('on') === '1', `line:${userId}`);
      return showThumbSettings(env, line, d, replyToken);
    }
    case 'thumb_limit': {
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      const n = Number(params.get('n'));
      if (!(DAILY_LIMIT_OPTIONS as readonly number[]).includes(n)) return; // 読めない値は何も変えない
      await setThumbDailyLimit(d.db, n, `line:${userId}`);
      return showThumbSettings(env, line, d, replyToken);
    }

    // ★Webリサーチの設定も費用に直結するので持ち主だけ。読めない値は何も変えない（危ない側に倒さない）
    case 'ai_mode':
    case 'ai_domains':
    case 'ai_domains_set':
    case 'ai_rlimit':
    case 'ai_rlimit_set':
    case 'ai_thumb':
    // ★文中の画像（P3）も費用に直結するので持ち主だけ
    case 'ai_img':
    case 'ai_img_set':
    case 'ai_ilimit':
    case 'ai_ilimit_set':
    // ★画像のルール（2026-10-26）も持ち主だけ（設定画面への入り口なので）
    case 'ai_imgrules':
      if (!isOwner(d.ownerLineUserId, userId)) return ownerOnly(line, replyToken);
      return handleAiSettingsPostback(action, params, env, line, d, replyToken, userId);

    case 'cfg_daily':
      return line.reply(replyToken, [buildDailyLimitChoices((await d.db.getTenant(DEFAULT_TENANT_ID)).daily_post_limit)]);

    case 'cfg_interval':
      return line.reply(replyToken, [buildIntervalChoices((await d.db.getTenant(DEFAULT_TENANT_ID)).min_interval_sec)]);

    case 'cfg_mode':
      return line.reply(replyToken, [buildModeChoices(await settingsView(env, d))]);

    // ★読めない値のときは何も変えない。
    //   丸めて 0 にすると「無制限・間隔なし」＝いちばん危ない側に倒れてしまう
    case 'cfg_daily_set': {
      const v = parseDailyLimit(params.get('v'));
      if (v === null) return;
      return saveSetting(env, line, d, replyToken, userId, 'daily', { daily_post_limit: v });
    }

    case 'cfg_interval_set': {
      const v = parseIntervalSec(params.get('v'));
      if (v === null) return;
      return saveSetting(env, line, d, replyToken, userId, 'interval', { min_interval_sec: v });
    }

    case 'cfg_mode_set':
      return saveSetting(env, line, d, replyToken, userId, 'mode',
        { execution_mode: params.get('v') === 'server' ? 'server' : 'agent' });
  }

  const articleId = params.get('id');
  if (!articleId) return;

  switch (action) {
    case 'publish':
      return publishAfterAiImageReview(articleId, env, line, d, userId, replyToken);

    case 'publish_confirm': {
      // 「AI画像がまだ確認されていません」で『このまま公開する』を押した。印を付けて通常の公開へ
      // ★印を付けるのは承認できる人（持ち主・投稿者）だけ。それ以外は doPublish がいつもどおり断る
      if (canApprove(d, userId)) await markAiImagesConfirmed(d.db, articleId);
      return doPublish(articleId, env, line, d, userId, replyToken);
    }

    case 'cancel': {
      const a = await d.db.getArticle(articleId);
      // ★拡張に渡した仕事も引き上げる。放っておくと後から勝手に投稿される
      await withdrawJobs(d, articleId);
      if (a) await d.db.setState(articleId, a.state, 'cancelled', `line:${userId}`);
      await line.reply(replyToken, [text('この記事は取りやめました。')]);
      return;
    }

    case 'fulltext': {
      const a = await d.db.getArticle(articleId);
      if (!a?.body_md) {
        await line.reply(replyToken, [text('記事が見つかりませんでした。')]);
        return;
      }
      // ★Reply で返すので追加の課金は発生しない
      await line.reply(replyToken, buildFullText({
        articleId,
        title: a.title ?? '無題',
        markdown: a.body_md,
        metaDescription: a.meta_description ?? '',
        hashtags: a.hashtags_json ? JSON.parse(a.hashtags_json) : [],
        imageCount: parsePlaceholders(a.body_md).length,
      }));
      return;
    }

    case 'reopen': {
      // 公開済みの記事を修正モードに戻す。再公開すると同じURLのまま更新される。
      {
        const busy = await busyWithOther(d, userId, articleId);
        if (busy) return line.reply(replyToken, [buildPendingNotice(busy)]);
      }
      // ★押した人に担当を移す（続きの指示とプレビューがその人に届くように）
      await d.db.setRequestedBy(articleId, userId);
      await reopenPublished(d, articleId);
      await line.reply(replyToken, [text(
        'この記事を修正します。どこを直しますか。文章で送ってください。\n\n' +
        '例:\n・■2をもっと具体的に書き直して\n・タイトルを別の案にして\n・文章量を3分の2に減らして\n\n' +
        '書き直したあと「公開する」を押すと、note の同じ記事が更新されます（URLは変わりません）。'
      )]);
      return;
    }

    case 'savedraft':
      return doSaveDraft(articleId, line, d, userId, replyToken);

    case 'thumb_regen': {
      // 作り直しは費用がかかるので、その記事を担当している人（持ち主を含む）だけ
      const a = await d.db.getArticle(articleId);
      // ★受け付けるのは確認待ちだけ（作っている最中に古いボタンで重ねて走らせない・源蔵レビュー P3 必須1）
      const st = regenStateCheck(a?.state);
      if (st === 'generating') return line.reply(replyToken, [text(NOTE_STILL_GENERATING)]);
      if (!a || st !== 'ok') {
        await line.reply(replyToken, [text('いまはサムネを作り直せない状態です。')]);
        return;
      }
      if (!isOwner(d.ownerLineUserId, userId) && a.requested_by !== userId) {
        return line.reply(replyToken, [text('この記事を作った人か、持ち主だけが作り直せます。')]);
      }
      if (!env.OPENAI_API_KEY) {
        await line.reply(replyToken, [text(NOTE_NO_KEY)]);
        return;
      }
      // ★「作成中」の印が取れたときだけ起動する（二度押しで二重に課金しない）。外すのは Workflow 側
      const started = await startLockedImageJob(env.KV, 'thumb', articleId, newId(), async (lockToken) => {
        await env.GENERATE.create({ params: { kind: 'thumbnail', articleId, lineUserId: userId, lockToken } });
      });
      if (started === 'locked') return line.reply(replyToken, [text(NOTE_THUMB_LOCKED)]);
      await line.reply(replyToken, [text('サムネを作り直します。1分ほどで結果をお知らせします。')]);
      return;
    }

    case 'inline_regen': {
      // 文中の画像の作り直しは費用がかかるので、その記事を担当している人（持ち主を含む）だけ。上限にも数える
      const a = await d.db.getArticle(articleId);
      // ★受け付けるのは確認待ちだけ。preview_ready は文中の画像を自動で作っている最中（源蔵レビュー P3 必須1）
      const st = regenStateCheck(a?.state);
      if (st === 'generating') return line.reply(replyToken, [text(NOTE_STILL_GENERATING)]);
      if (!a || st !== 'ok') {
        await line.reply(replyToken, [text('いまは文中の画像を作り直せない状態です。')]);
        return;
      }
      if (!isOwner(d.ownerLineUserId, userId) && a.requested_by !== userId) {
        return line.reply(replyToken, [text('この記事を作った人か、持ち主だけが作り直せます。')]);
      }
      if (!hasImageKey(env.OPENAI_API_KEY)) {
        await line.reply(replyToken, [text('文中の画像の自動生成は未設定です（OpenAI の API キーを登録すると使えます）。')]);
        return;
      }
      const view = await loadInlineView(d.db, a, { hasKey: true });
      if (!view) {
        await line.reply(replyToken, [text('この記事には、AI が作る画像の場所がありません。')]);
        return;
      }
      if ((await countInlineForArticle(d.db, articleId)) >= MAX_INLINE_PER_ARTICLE) {
        await line.reply(replyToken, [text(`${NOTE_ARTICLE_LIMIT}。`)]);
        return;
      }
      // ★別の作業中の記事があれば引き受けない（「もう一度調べる」と同じ作り）
      const busy = await busyWithOther(d, userId, articleId);
      if (busy) return line.reply(replyToken, [buildPendingNotice(busy)]);
      // ★「作成中」の印が取れたときだけ、担当を引き受けて起動する。取れなければ予約も起動もしない。
      //   外すのは Workflow 側（終わる・失敗する）。外し損ねても10分で切れる
      const started = await startLockedImageJob(env.KV, 'inline', articleId, newId(), async (lockToken) => {
        await d.db.setRequestedBy(articleId, userId);
        await env.GENERATE.create({ params: { kind: 'inline_images', articleId, lineUserId: userId, lockToken } });
      });
      if (started === 'locked') return line.reply(replyToken, [text(NOTE_INLINE_LOCKED)]);
      await line.reply(replyToken, [text(`文中の画像を作り直します（${view.slots}枚）。最大${view.slots}分ほどで結果をお知らせします。`)]);
      return;
    }

    case 'research_redo': {
      // 調べ直しは費用がかかるので、その記事を担当している人（持ち主を含む）だけ。上限にも数える
      const a = await d.db.getArticle(articleId);
      if (!a || a.state !== 'awaiting_approval') {
        await line.reply(replyToken, [text('いまは調べ直せない状態です。')]);
        return;
      }
      if (!isOwner(d.ownerLineUserId, userId) && a.requested_by !== userId) {
        return line.reply(replyToken, [text('この記事を作った人か、持ち主だけが調べ直せます。')]);
      }
      if (!(await canRedoResearch(d.db, a, Boolean(createResearchLlm(env))))) {
        return line.reply(replyToken, [text('調べ直せる回数の上限に達したか、AI設定が「与えた情報だけ」になっています。')]);
      }
      // ★担当の引き受けは「やり直す」と同じ作り（別の作業中の記事があれば引き受けない）
      const busy = await busyWithOther(d, userId, articleId);
      if (busy) return line.reply(replyToken, [buildPendingNotice(busy)]);
      await d.db.setRequestedBy(articleId, userId);
      await d.db.setState(articleId, a.state, 'editing', `line:${userId}`, { reason: 'research_redo' });
      await env.GENERATE.create({ params: { articleId, lineUserId: userId, debounceSec: 0, forceResearch: true } });
      await line.reply(replyToken, [text('もう一度調べて、書き直します。2〜4分ほどでお送りします。')]);
      return;
    }

    case 'eyecatch': {
      const slot = Number(params.get('slot')) || null;
      try {
        const { message } = await setEyecatch(d, articleId, slot);
        await line.reply(replyToken, [text(message)]);
      } catch (e) {
        await line.reply(replyToken, [text(e instanceof Error ? e.message : 'サムネイルを設定できませんでした。')]);
      }
      return;
    }

    case 'eyecatch_clear':
      await clearEyecatch(d, articleId);
      await line.reply(replyToken, [text('サムネイルの指定を外しました。')]);
      return;

    case 'retry': {
      const a = await d.db.getArticle(articleId);
      if (!a) return;
      const busy = await busyWithOther(d, userId, articleId);
      if (busy) return line.reply(replyToken, [buildPendingNotice(busy)]);
      await d.db.setRequestedBy(articleId, userId);
      await requestRewrite(d, articleId, a.revision_instruction ?? a.source_text);
      await env.GENERATE.create({ params: { articleId, lineUserId: userId, debounceSec: 0 } });
      await line.reply(replyToken, [text(`もう一度${formatRevisionWaitMessage()}`)]);
      return;
    }

    case 'revise': {
      const busy = await busyWithOther(d, userId, articleId);
      if (busy) return line.reply(replyToken, [buildPendingNotice(busy)]);
      await d.db.setRequestedBy(articleId, userId);
      await line.reply(replyToken, [text(
        'どこを直しますか。文章で送ってください。\n\n' +
        '例:\n・画像2を■3の下に移して\n・画像1と画像2を入れ替えて\n・■2をもっと具体的に書き直して\n・タイトルを別の案にして\n\n' +
        '本文を確認したいときは「全文」と送ってください。'
      )]);
      return;
    }
  }
}

// ── 公開 ────────────────────────────────────────────────
/** 承認できる人か（持ち主・投稿者。持ち主が未登録なら誰でも＝approve と同じ考え方） */
function canApprove(d: ServiceDeps, userId: string): boolean {
  if (!d.ownerLineUserId) return true;
  return userId === d.ownerLineUserId || (d.staffLineUserIds ?? []).includes(userId);
}

/**
 * 「公開する」の入口。AI が作った画像を誰も見ていないまま初めて公開しようとしたら、一度だけ確認する
 * （源蔵レビュー P3 必須3）。下書き保存済み・確認済み・AI 画像なしなら、そのまま通常の公開へ
 * ★承認できない人には聞かない（doPublish がいつもどおり断る）
 */
async function publishAfterAiImageReview(
  articleId: string, env: Env, line: LineClient, d: ServiceDeps, userId: string, replyToken: string,
): Promise<void> {
  if (canApprove(d, userId) && await needsAiImageReview(d.db, await d.db.getArticle(articleId))) {
    await line.reply(replyToken, [buildAiImageReviewPrompt(articleId)]);
    return;
  }
  return doPublish(articleId, env, line, d, userId, replyToken);
}

async function doPublish(
  articleId: string, env: Env, line: LineClient, d: ServiceDeps, userId: string, replyToken: string,
): Promise<void> {
  // ★承認できるのはオーナーだけ
  const approval = await approve(d, articleId, userId);
  if (!approval.allowed) {
    await line.reply(replyToken, [text(approval.userMessage!)]);
    return;
  }

  const decision = await checkPolicy(d, articleId);
  if (!decision.allowed) {
    const a = await d.db.getArticle(articleId);
    if (decision.retryable && a) {
      // 顧客の作業を無駄にしない。条件が回復したら Cron が自動で投稿する
      await d.db.setState(articleId, a.state, 'blocked', `line:${userId}`, { reason: decision.reason, retryAfter: decision.retryAfter });
    }
    await line.reply(replyToken, [text(decision.userMessage!)]);
    return;
  }

  // ★実行先を決める。agent なら note を叩くのは顧客のブラウザ
  // ★許可外のリンク先があれば、ここで止まる（note には何も送らない）
  let dispatch: Awaited<ReturnType<typeof dispatchPublish>>;
  try {
    dispatch = await dispatchPublish(d, articleId, 'publish');
  } catch (e) {
    if (e instanceof DisallowedLinksError) return notifyLinkBlocked(line, d, articleId, e, userId, replyToken);
    throw e;
  }

  if (dispatch.mode === 'no_device') {
    await line.reply(replyToken, [text(buildNoDeviceMessage())]);
    return;
  }

  if (dispatch.mode === 'agent') {
    await line.reply(replyToken, [text(
      dispatch.online
        ? 'お使いのパソコンの Chrome から投稿します。少しお待ちください。'
        : 'パソコンの Chrome が起動したら投稿します。\n\n' +
          'いま投稿したい場合は、パソコンで Chrome を開いてください。\n' +
          '記事は預かっているので、そのままで大丈夫です。',
    )]);
    return;  // 完了通知は拡張から結果が返ったときに Push する
  }

  await line.reply(replyToken, [text('note に投稿します。少しお待ちください。')]);

  try {
    const { url } = await publishArticle(d, articleId);
    await line.push(userId, [text(`公開しました。\n${url}`)]);
  } catch (e) {
    if (e instanceof DisallowedLinksError) return notifyLinkBlocked(line, d, articleId, e, userId, null);
    const message = e instanceof PolicyBlockedError ? e.decision.userMessage
      : e instanceof NoteApiError ? e.userMessage
      : '投稿に失敗しました。しばらくしてからもう一度お試しください。';
    await line.push(userId, [text(message!)]);
  }
}

/**
 * リンク検査で止めたことを知らせる（押した人・記事の担当者・持ち主）。
 * ★押した人には返信（無料）で、ほかの人にはプッシュで。同じ人には1回だけ
 */
async function notifyLinkBlocked(
  line: LineClient, d: ServiceDeps, articleId: string, e: DisallowedLinksError, userId: string, replyToken: string | null,
): Promise<void> {
  const a = await d.db.getArticle(articleId);
  for (const to of linkBlockRecipients(a, d.ownerLineUserId, userId)) {
    if (to === userId && replyToken) await line.reply(replyToken, [text(e.userMessage)]);
    else await line.push(to, [text(e.userMessage)]);
  }
}

/** 拡張がまだ繋がっていないとき。 */
function buildNoDeviceMessage(): string {
  return (
    'note への投稿は、お使いのパソコンの Chrome から行う設定になっています。\n' +
    'まだ連携ツールがつながっていないため、投稿できません。\n\n' +
    '「note連携」と送って、連携をお願いします。\n' +
    '記事は預かっているので、連携後にそのまま投稿できます。'
  );
}

/**
 * 下書き保存。公開と同じく、実行先（サーバー / 顧客のブラウザ）を通す。
 * ★下書きは公開ではないので、承認ゲートとレート制限は課さない（緊急停止だけ効く）。
 */
async function doSaveDraft(
  articleId: string, line: LineClient, d: ServiceDeps, userId: string, replyToken: string,
): Promise<void> {
  let dispatch: Awaited<ReturnType<typeof dispatchPublish>>;
  try {
    dispatch = await dispatchPublish(d, articleId, 'draft');
  } catch (e) {
    if (e instanceof DisallowedLinksError) return notifyLinkBlocked(line, d, articleId, e, userId, replyToken);
    throw e;
  }

  if (dispatch.mode === 'no_device') {
    await line.reply(replyToken, [text(buildNoDeviceMessage())]);
    return;
  }

  if (dispatch.mode === 'agent') {
    await line.reply(replyToken, [text(
      dispatch.online
        ? 'お使いのパソコンの Chrome から、note に下書きとして保存します。'
        : 'パソコンの Chrome が起動したら、note に下書きとして保存します。',
    )]);
    return;
  }

  await line.reply(replyToken, [text('note に下書きとして保存します。少しお待ちください。')]);
  try {
    const { editUrl } = await saveArticleAsDraft(d, articleId);
    await line.push(userId, [text(
      'note に下書きとして保存しました。公開はされていません。\n\n' +
      `${editUrl}\n\n` +
      '新しい記事を作れる状態になりました。'
    )]);
  } catch (e) {
    if (e instanceof DisallowedLinksError) return notifyLinkBlocked(line, d, articleId, e, userId, null);
    const message = e instanceof PolicyBlockedError ? e.decision.userMessage
      : e instanceof NoteApiError ? e.userMessage
      : '下書きの保存に失敗しました。';
    await line.push(userId, [text(message!)]);
  }
}

// ── 修正指示 ────────────────────────────────────────────
async function handleRevision(
  articleId: string, instruction: string, env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  const a = await d.db.getArticle(articleId);
  if (!a?.body_md) return;

  const headings = parseHeadings(a.body_md).map((h) => h.text);
  const imageCount = parsePlaceholders(a.body_md).length;
  const generatedCount = parsePlaceholders(a.body_md, 'generated').length;

  // 意図分類だけは軽いモデルで。1円未満で済む
  const llm = createLlm(d.llm);
  const { data: intent } = await llm.structured({
    tier: 'light',
    label: '修正指示の分類',
    schema: RevisionIntent,
    maxTokens: 500,
    system: classifyRevision.system,
    user: classifyRevision.user(instruction, headings, imageCount, generatedCount),
  });

  // 画像の位置操作は LLM を使わず純関数で即処理する（数秒・API費用ゼロ）
  try {
    let result: { markdown: string; message: string } | null = null;
    // AI が作った文中画像の位置も、写真と同じ純関数で即時に動かす（課金なし）。本文に AI 画像が無ければ写真として扱う
    const kind = intent.imageKind === 'generated' && generatedCount > 0 ? 'generated' : 'photo';

    if (intent.action === 'move_image' && intent.imageIndex && intent.headingIndex !== null) {
      result = await reviseImagePosition(d, articleId,
        { action: 'move', index: intent.imageIndex, headingIndex: intent.headingIndex }, kind);
    } else if (intent.action === 'swap_image' && intent.imageIndex && intent.secondImageIndex) {
      result = await reviseImagePosition(d, articleId,
        { action: 'swap', a: intent.imageIndex, b: intent.secondImageIndex }, kind);
    } else if (intent.action === 'remove_image' && intent.imageIndex) {
      result = await reviseImagePosition(d, articleId, { action: 'remove', index: intent.imageIndex }, kind);
    } else if (intent.action === 'set_eyecatch') {
      // サムネ指定は本文を作り直さないので、そのまま返す
      const { message } = await setEyecatch(d, articleId, intent.imageIndex);
      await line.reply(replyToken, [text(message)]);
      return;
    } else if (intent.action === 'clear_eyecatch') {
      await clearEyecatch(d, articleId);
      await line.reply(replyToken, [text('サムネイルの指定を外しました。')]);
      return;
    }

    if (result) {
      const updated = (await d.db.getArticle(articleId))!;
      await line.reply(replyToken, [
        text(result.message),
        buildPreview({
          articleId,
          title: updated.title ?? '無題',
          markdown: result.markdown,
          metaDescription: updated.meta_description ?? '',
          hashtags: updated.hashtags_json ? JSON.parse(updated.hashtags_json) : [],
          charCount: result.markdown.replace(/\[(?:AI)?画像\d+\]/g, '').length,
          hasEyecatch: Boolean(await d.db.getEyecatch(articleId)),
          inlineImages: await loadInlineView(d.db, updated, { hasKey: hasImageKey(env.OPENAI_API_KEY) }),
        }),
      ]);
      return;
    }
  } catch (e) {
    await line.reply(replyToken, [text(e instanceof Error ? e.message : '修正できませんでした。')]);
    return;
  }

  // 本文の書き直しが必要なものは再生成に回す
  if (intent.action === 'regenerate_all' || intent.action === 'rewrite_section' || intent.action === 'change_title') {
    // ★状態は awaiting_approval → editing を通す（generating へ直接飛ばすと遷移表に弾かれる）
    await requestRewrite(d, articleId, instruction);
    await env.GENERATE.create({
      params: { articleId, lineUserId: userId, debounceSec: 0 },
    });
    await line.reply(replyToken, [text(formatRevisionWaitMessage())]);
    return;
  }

  await line.reply(replyToken, [textWithActions(
    '指示の内容が分かりませんでした。もう少し具体的に教えてください。',
    [{ label: 'このまま公開する', data: `action=publish&id=${articleId}` }],
  )]);
}


// ── 事業コンテキスト ────────────────────────────────────
/** 現在の設定を見せる。追記・書き換え・削除を選ばせる。 */
async function showContext(env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string): Promise<void> {
  const current = await d.db.getActiveContext(DEFAULT_TENANT_ID);

  if (!current) {
    await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: 'ctx_append' });
    await line.reply(replyToken, [textWithActions(
      'ここに書いたことは、これから作る記事すべての前提になります。\n' +
      '思いついたものから、どんどん送ってください。あとから足していけます。\n\n' +
      'たとえば こんなこと:\n' +
      '・何をやっているか、どんなお客さんが来るか\n' +
      '・使っている材料、こだわり、店の決まりごと\n' +
      '・「文末に https://... のリンクを貼る」のような毎回のルール\n' +
      '・「店主は大将と書く」のような呼び方の指定\n\n' +
      '次に送るメッセージをそのまま覚えます。',
      [{ label: 'やめる', data: 'action=ctx_cancel' }],
    )]);
    return;
  }

  await line.reply(replyToken, [buildKnowledgeList(current.raw_text, isOwner(d.ownerLineUserId, userId))]);
}

/** LINE の1通の上限に収まるよう、長い文章を切り分ける。 */
function splitForLine(textBody: string, size = 1800): string[] {
  const out: string[] = [];
  for (let i = 0; i < textBody.length; i += size) out.push(textBody.slice(i, i + size));
  return out.length > 0 ? out : [''];
}

/**
 * 覚えているメモを1件だけ消して、残りで整理し直す。
 * ★消したあとに分析をかけ直さないと、消したはずの内容が記事に残る。
 */
async function deleteContextEntry(
  index: number, env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  const current = await d.db.getActiveContext(DEFAULT_TENANT_ID);
  if (!current) {
    await line.reply(replyToken, [text('まだ何も覚えていません。')]);
    return;
  }

  const entries = listEntries(current.raw_text);
  if (index > entries.length) {
    await line.reply(replyToken, [text(`${index}番はありません。いまは ${entries.length} 件です。`)]);
    return;
  }

  const removed = entries[index - 1];
  const rest = removeEntry(current.raw_text, index);

  if (rest.trim() === '') {
    await d.db.clearContext(DEFAULT_TENANT_ID);
    await line.reply(replyToken, [text('最後の1件を消しました。今後は前提なしで記事を書きます。')]);
    return;
  }

  // ★先に保存してすぐ返事をする（書き足しと同じ理由。整理は Workflow で後から）
  const contextId = await d.db.saveContext(DEFAULT_TENANT_ID, rest, null, buildProvisionalSnippet(rest));
  await line.reply(replyToken, [textWithActions(
    `消しました。（残り${listEntries(rest).length}件）\n\n` +
    `消したもの: ${removed.length > 40 ? `${removed.slice(0, 40)}…` : removed}`,
    [{ label: '一覧を見る', data: 'action=ctx_edit' }],
  )]);
  try {
    await env.GENERATE.create({ params: { kind: 'knowledge', contextId, lineUserId: userId, announce: false } });
  } catch (e) {
    log.warn('ナレッジの整理を始められませんでした', String(e));
  }
}

/** 溜まっているメモを連番で見せる。長いものは折りたたむ。 */
/** @param canEdit 消す・入れ替えるを出すか（持ち主だけ） */
function buildKnowledgeList(rawText: string, canEdit = true): LineMessage {
  const entries = listEntries(rawText);
  const shown = entries.slice(0, 20);
  const lines = shown.map((e, i) => {
    const body = e.replace(/\n/g, ' ');
    const clipped = body.length > 64 ? `${body.slice(0, 64)}…` : body;
    return `${String(i + 1).padStart(2, ' ')}. ${clipped}`;
  });

  return {
    type: 'text',
    text:
      `【覚えていること】${entries.length}件\n\n` +
      lines.join('\n') +
      (entries.length > shown.length ? `\n\n（ほか ${entries.length - shown.length} 件）` : '') +
      '\n\n────────\n' +
      'そのまま送ると書き足します。',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '書き足す', data: 'action=ctx_append', displayText: '書き足す' } },
        ...(canEdit ? [{ type: 'action', action: { type: 'postback', label: '1件消す', data: 'action=ctx_delete', displayText: '1件消す' } }] : []),
        { type: 'action', action: { type: 'postback', label: '全文を見る', data: 'action=ctx_full', displayText: '全文を見る' } },
        ...(canEdit ? [
          { type: 'action', action: { type: 'postback', label: '入れ替える', data: 'action=ctx_replace', displayText: '入れ替える' } },
          { type: 'action', action: { type: 'postback', label: '全部消す', data: 'action=ctx_clear', displayText: '全部消す' } },
        ] : []),
      ],
    },
  };
}

/**
 * 本人が書いた文章を保存し、記事の前提として構造化する。
 * @param append true なら既存の内容に書き足す（上書きしない）
 */
async function saveContext(
  rawText: string, append: boolean,
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  if (rawText.length < 10) {
    await setMode(env.KV, DEFAULT_TENANT_ID, userId, { kind: append ? 'ctx_append' : 'ctx_new' });
    await line.reply(replyToken, [text(
      'もう少しだけ詳しく書いてください。短すぎると記事に反映できません。'
    )]);
    return;
  }

  // ★先に原文を保存し、すぐ返事をする（2026-09-14）。
  //   以前は「Claude で整理 → 保存 → 返事」の順で、長文だと整理が裏処理の制限時間（約30秒）に
  //   間に合わずに打ち切られ、**保存もされず返事も届かなかった**（お客さまの環境で2回発生）。
  //   整理は時間制限の無い Workflow に回し、終わったら知らせる。
  const merged = append ? await d.db.appendContextText(DEFAULT_TENANT_ID, rawText) : rawText;
  const contextId = await d.db.saveContext(DEFAULT_TENANT_ID, merged, null, buildProvisionalSnippet(merged));
  await line.reply(replyToken, [buildKnowledgeReceived(listEntries(merged).length, append ? 'append' : 'replace')]);

  try {
    await env.GENERATE.create({ params: { kind: 'knowledge', contextId, lineUserId: userId, announce: true } });
  } catch (e) {
    // 整理を始められなくても、原文はもう記事に使われている
    log.warn('ナレッジの整理を始められませんでした', String(e));
  }
}

// ── note 連携（Chrome 拡張）─────────────────────────────
/**
 * 連携コードを発行して LINE に返す。
 *
 * ★コードを出せるのはオーナーだけ。
 *   ここを緩めると、公式アカウントを友だち追加した誰でも
 *   note の Cookie を差し替えられることになる。
 */
async function startNoteConnect(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  if (d.ownerLineUserId && userId !== d.ownerLineUserId) {
    await line.reply(replyToken, [text('この操作はアカウントの持ち主だけが行えます。')]);
    return;
  }

  const existing = await loadNoteSession(env.DB, DEFAULT_TENANT_ID, (await resolveMasterKey(env)).key);
  const { display } = await issuePairingCode(env.KV, DEFAULT_TENANT_ID, userId);
  await d.db.audit(DEFAULT_TENANT_ID, 'session.code_issued', `line:${userId}`, null, 'ok');

  await line.reply(replyToken, [buildConnectGuide(display, existing === null)]);
}

/** いまの連携状況を見せる。 */
async function showConnectStatus(env: Env, line: LineClient, replyToken: string): Promise<void> {
  const stored = await loadNoteSession(env.DB, DEFAULT_TENANT_ID, (await resolveMasterKey(env)).key);
  await line.reply(replyToken, [buildConnectStatus({
    connected: stored !== null,
    urlname: stored?.urlname ?? env.NOTE_URLNAME ?? '',
    status: stored?.status ?? 'active',
    lastVerifiedAt: stored?.lastVerifiedAt ?? null,
    expiresAt: stored?.expiresAt ?? null,
    viaEnv: Boolean(env.NOTE_COOKIE),
  })]);
}

/** 連携を解除して Cookie を捨てる。 */
async function doDisconnect(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  if (d.ownerLineUserId && userId !== d.ownerLineUserId) {
    await line.reply(replyToken, [text('この操作はアカウントの持ち主だけが行えます。')]);
    return;
  }
  const removed = await disconnectNoteSession(env.DB, DEFAULT_TENANT_ID);
  // ★端末も無効にする。ここを忘れると、解除したはずの拡張が仕事を取りに来られる
  const devices = await revokeDevices(env.DB, DEFAULT_TENANT_ID);
  await d.db.audit(DEFAULT_TENANT_ID, 'session.disconnected', `line:${userId}`, null,
    removed || devices > 0 ? 'ok' : 'denied', { devices });
  await line.reply(replyToken, [text(
    removed || devices > 0
      ? 'note の連携を解除しました。\n' +
        (removed ? 'お預かりしていたログイン情報も削除しました。\n' : '') +
        (devices > 0 ? `連携ツール ${devices} 台を無効にしました。\n` : '') +
        '\nまた使うときは「note連携」と送ってください。'
      : '連携中の note はありませんでした。'
  )]);
}

// ── 投稿の設定 ──────────────────────────────────────────
async function settingsView(env: Env, d: ServiceDeps): Promise<SettingsView> {
  const tenant = await d.db.getTenant(DEFAULT_TENANT_ID);
  const agentConnected = await hasDevice(env.DB, DEFAULT_TENANT_ID);
  return {
    tenant,
    agentConnected,
    agentOnline: agentConnected && (await isAgentOnline(env.DB, DEFAULT_TENANT_ID)),
  };
}

/**
 * 「その他の設定」: 連携・投稿者・設定画面への入り口。
 * ★ボタンは「文字を送る」形にして、ふだん打つコマンドと同じ経路を通す（持ち主チェックも同じ）。
 */
async function showMoreSettings(line: LineClient, d: ServiceDeps, replyToken: string, userId: string): Promise<void> {
  const owner = isOwner(d.ownerLineUserId, userId);
  const labels = owner
    ? [['連携状況', '連携状況'], ['投稿者一覧', '投稿者一覧'], ['投稿者を追加', '投稿者を追加'], ['設定画面を開く', 'セットアップ'], ['使い方', 'メニュー']]
    : [['使い方', 'メニュー']];
  await line.reply(replyToken, [{
    type: 'text',
    text: owner ? 'その他の設定です。開きたいものを選んでください。' : 'メニューです。',
    quickReply: {
      items: labels.map(([label, sendText]) => ({
        type: 'action' as const,
        action: { type: 'message' as const, label, text: sendText },
      })),
    },
  }]);
}

async function showAiSettings(env: Env, line: LineClient, d: ServiceDeps, replyToken: string): Promise<void> {
  // ★文中の画像の設定は、画像を作れるキーがある環境でだけ見せる（キーが無ければ項目もボタンも出さない）
  const inline = hasImageKey(env.OPENAI_API_KEY) ? await getInlineSettings(d.db) : undefined;
  await line.reply(replyToken, [buildAiSettings(await getResearchSettings(d.db), Boolean(createResearchLlm(env)), inline)]);
}

/** AI設定のボタン（持ち主チェックは呼び出し側で済んでいる） */
async function handleAiSettingsPostback(
  action: string, params: URLSearchParams, env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  const by = `line:${userId}`;
  switch (action) {
    case 'ai_thumb':
      return showThumbSettings(env, line, d, replyToken);
    case 'ai_imgrules':
      // 状態の要約だけ（本文・画像は出さない）。登録・変更は /setup
      return line.reply(replyToken, [buildImageRulesSummary(
        await loadImageRulesSummary(d.db, DEFAULT_TENANT_ID), hasImageKey(env.OPENAI_API_KEY))]);
    case 'ai_domains':
      return line.reply(replyToken, [buildDomainChoices(await getResearchSettings(d.db))]);
    case 'ai_rlimit':
      return line.reply(replyToken, [buildResearchLimitChoices(await getResearchSettings(d.db))]);
    case 'ai_img':
    case 'ai_ilimit':
      // キーが無い環境では選ぶ画面も出さない（AI設定の画面に戻す）
      if (!hasImageKey(env.OPENAI_API_KEY)) return showAiSettings(env, line, d, replyToken);
      return line.reply(replyToken, [action === 'ai_img'
        ? buildInlineCountChoices(await getInlineSettings(d.db))
        : buildInlineLimitChoices(await getInlineSettings(d.db))]);
    case 'ai_img_set':
    case 'ai_ilimit_set': {
      // ★持ち主・キーの有無・値の読み取りは core 側で判定する（キーが無い環境では有効にしない）
      const r = await applyInlineSetting(d.db, {
        isOwner: isOwner(d.ownerLineUserId, userId),
        hasKey: hasImageKey(env.OPENAI_API_KEY),
        action,
        value: params.get('n'),
        by,
      });
      if (r === 'denied') return ownerOnly(line, replyToken);
      if (r === 'ignored') return; // 読めない値は何も変えない
      return showAiSettings(env, line, d, replyToken);
    }
  }
  // ★持ち主・キーの有無・値の読み取りは core 側で判定する（キーが無い環境では有効にしない）
  const result = await applyResearchSetting(d.db, {
    isOwner: isOwner(d.ownerLineUserId, userId),
    hasKey: Boolean(createResearchLlm(env)),
    action,
    value: params.get(action === 'ai_rlimit_set' ? 'n' : 'v'),
    by,
  });
  if (result === 'denied') return ownerOnly(line, replyToken);
  if (result === 'ignored') return; // 読めない値は何も変えない
  return showAiSettings(env, line, d, replyToken);
}

async function showThumbSettings(env: Env, line: LineClient, d: ServiceDeps, replyToken: string): Promise<void> {
  await line.reply(replyToken, [buildThumbSettings(await getThumbSettings(d.db), Boolean(env.OPENAI_API_KEY))]);
}

async function showSettings(env: Env, line: LineClient, d: ServiceDeps, replyToken: string): Promise<void> {
  await line.reply(replyToken, [buildSettings(await settingsView(env, d))]);
}

/**
 * 設定を保存する。
 * ★変えられるのはオーナーだけ。上限や投稿方法は、note アカウントの安全に直結する。
 */
async function saveSetting(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
  kind: 'daily' | 'interval' | 'mode',
  patch: Parameters<ServiceDeps['db']['updateTenantSettings']>[1],
): Promise<void> {
  if (d.ownerLineUserId && userId !== d.ownerLineUserId) {
    await line.reply(replyToken, [text('この操作はアカウントの持ち主だけが行えます。')]);
    return;
  }
  await d.db.updateTenantSettings(DEFAULT_TENANT_ID, patch, `line:${userId}`);
  await line.reply(replyToken, [buildSettingsSaved(kind, await settingsView(env, d))]);
}


/**
 * セットアップ画面用の使い捨てコードを出す。
 * ★ここに来る時点で持ち主チェックは済んでいる（handleEvent の入口で弾いている）。
 */
async function sendSetupCode(env: Env, line: LineClient, replyToken: string): Promise<void> {
  const { display, expiresAt } = await issueSetupCode(env.KV);
  await line.reply(replyToken, [text(
    'セットアップ画面で使うコードです。\n\n' +
    `　${display}\n\n` +
    '10分で使えなくなります。1回だけ使えます。\n' +
    'システムのURLの末尾に /setup を付けて開き、この番号を貼ってください。'
  )]);
  log.info('セットアップ用コードを発行しました', { expiresAt });
}


/**
 * 持ち主の登録をやめる。次に話しかけた人が新しい持ち主になる。
 *
 * ★ここに来る時点で「いまの持ち主」であることは確認済み（入口で弾いている）。
 * ★環境変数で持ち主を固定している場合は効かない。黙って成功と言わない。
 */
async function resetOwner(
  env: Env, line: LineClient, d: ServiceDeps, replyToken: string, userId: string,
): Promise<void> {
  if (env.LINE_OWNER_USER_ID) {
    await line.reply(replyToken, [text(
      '持ち主が固定されているため、ここからは変更できません。\n' +
      'Cloudflare の画面 → お使いの Worker → 設定 → 変数とシークレット で\n' +
      'LINE_OWNER_USER_ID を消してから、もう一度お試しください。'
    )]);
    return;
  }

  const cleared = await d.db.clearOwnerLineUserId(DEFAULT_TENANT_ID, `line:${userId}`);
  const hasStaff = (d.staffLineUserIds ?? []).length > 0;
  await line.reply(replyToken, [text(cleared
    ? '持ち主の登録をやめました。\n\n' +
      '★次にこのトークへ話しかけた人が、新しい持ち主になります。\n' +
      '引き継ぐ相手に、先に話しかけてもらってください。' +
      (hasStaff
        ? '\n\n★投稿者がいます。投稿者が先に話しかけると、その人が持ち主になります。\n' +
          '引き継ぐ相手に、すぐ話しかけてもらってください。'
        : '')
    : '持ち主はもともと登録されていませんでした。')]);
  log.info('持ち主の登録をやめました', { cleared });
}
