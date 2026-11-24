/**
 * 公開済み記事のハッシュタグを付け直す（2026-11-24）。
 *
 * 背景: 公開時に送っていたタグが「#」なしだったため、note が黙って捨てていた（実測）。
 *   それまでに公開した記事には、タグが1つも付いていない。
 *
 * ★方式を Worker 側（LINE の「ハッシュタグを付け直す」）にした理由:
 *   note の Cookie は顧客の D1 に暗号化して入っていて、鍵は顧客の Worker の中にしか無い。
 *   運用側の手元のスクリプトでやるには、鍵か Cookie を外に出すことになる。
 *   Worker の中で済ませれば、どちらも顧客の環境から一歩も出ない。
 *
 * ★守ること（2026-11 源蔵レビュー必須4件を含む）:
 *   ・本文・タイトルは作り直さない。**ログインして note から読んだ、いまの本文とタイトル**をそのまま送る
 *     （公開 API と本文は同じだが、ログインして読むと自分の記事かを確かめられる）
 *   ・URL は変えない（同じ記事を上書き更新する）／フォロワーへの通知はしない
 *   ・タグは足し算。**既存タグは受け取った文字列のまま**送る。整えると形が変わる既存タグがあれば送らない
 *   ・目次・コメント欄・トップ表示・AI学習の設定は note から読んだ値を引き継ぐ。
 *     **読み取れない項目が1つでもあれば送らない**（false と取り違えて設定を変えないため）
 *   ・有料・限定・マガジン入り・他人の記事は送らない
 *   ・コメント欄を閉じられるアカウント（プレミアムなど）では1本も送らない。閉じた記事で設定を正しく読めるか
 *     実機で確かめられていないため（自社アカウントは閉じられない＝閉じた記事を作れない）
 *   ・note の画面で編集中（下書きあり）の記事、こちらで直近10分以内に更新した記事は今回は飛ばす
 *     （★note 側の更新日時は API に無い＝実測。note の画面での更新直後は「編集中の下書き」でしか見分けられない）
 *   ・1回の実行で読む数・送る数・間隔に上限、さらに**開始から約20秒で新しい読み込み・送信をやめる**
 *     （LINE の裏処理は約30秒で打ち切られる）。残りはもう一度送れば続きから進む
 *   ・すでに付いている記事は送らない（何度実行しても二重に送らない）
 *   ・1本失敗しても記録して次へ。ただし連携切れ・混雑のときはそこで止める（全部失敗するため）
 */
import type { Db } from '../../ports/storage/db';
import { NoteClient, NoteApiError, type NoteSession } from '../../ports/publisher/note/client';
import { parseNoteDetail, type PublicNote } from '../../ports/publisher/note/public';
import { plainLength } from '../../ports/publisher/note/html';
import { mergeHashtags, parseHashtagsJson } from '../../ports/publisher/note/hashtags';
import { log } from '../../lib/mask';

/** 1回の実行で note に読みに行く記事の数（無料プランの外部通信 50回/リクエストに収めるため） */
export const RETAG_MAX_CHECKS = 20;
/** 1回の実行で実際に送り直す記事の数 */
export const RETAG_MAX_UPDATES = 5;
/** 送り直しの間隔（note に連投と見られないように） */
export const RETAG_INTERVAL_MS = 2000;
/** 開始からこれを過ぎたら、新しい読み込み・送信を始めない（LINE の裏処理は約30秒で打ち切られる） */
export const RETAG_TIME_BUDGET_MS = 20_000;
/** こちらで直近にこれ以内に更新した記事は、今回は飛ばす */
export const RETAG_RECENT_MS = 10 * 60 * 1000;

/** 送らない理由（★この先も変わらない＝次回から読みに行かない） */
export type RetagSkipReason =
  | 'not_published'        // note 上で公開中ではない
  | 'id_mismatch'          // 記録と note の記事が食い違う
  | 'not_mine'             // ログインしているアカウントの記事ではない
  | 'paid'                 // 有料・限定記事
  | 'in_magazine'          // マガジンに入っている
  | 'empty_body'           // 本文が読めない
  | 'unknown_setting'      // 目次・コメント欄・トップ表示・AI学習のどれかが読み取れない
  | 'unsafe_existing_tag'; // 整えると形が変わる既存タグがある

/** 今回だけ見送る理由（次の実行でもう一度確かめる） */
export type RetagDeferReason = 'editing' | 'recently_updated';

/**
 * 監査ログの action。★'ok' / 'already' / 'skipped' が付いた記事は次から読みに行かない。
 * 'deferred'（編集中・更新直後）と 'error' は次の実行でやり直す
 */
export const RETAG_AUDIT_ACTION = 'retag.hashtags';
export type RetagAuditResult = 'ok' | 'already' | 'skipped' | 'deferred' | 'error';

export interface RetagResult {
  /** note の連携情報がサーバーに無く、実行できなかった */
  noSession: boolean;
  /**
   * コメント欄を閉じられるアカウント（または確かめられない）ため、1本も送らなかった。
   * ★閉じた記事でコメント欄の設定を正しく読めるかを実機で確かめられていない（自社アカウントは閉じられない）。
   *   読み違えて送ると、閉じていたコメント欄が開いてしまうので、確かめられるまで送らない（2026-11 源蔵レビュー）
   */
  blockedByCommentSetting: boolean;
  /** 連携切れ・混雑で途中で止めた */
  stoppedBySession: boolean;
  /** 時間切れで途中で止めた */
  stoppedByTime: boolean;
  updated: number;
  alreadyTagged: number;
  skipped: number;
  /** 編集中・更新直後のため今回は見送った */
  deferred: number;
  failed: number;
  /** 今回は手を付けずに残した記事の数（もう一度実行すると続きから進む）。失敗・見送りは含まない */
  remaining: number;
}

type RetagRow = Awaited<ReturnType<Db['listPublishedForRetag']>>[number];

export interface RetagDeps {
  db: Pick<Db, 'listPublishedForRetag' | 'listRetagDoneIds' | 'audit'>;
  noteSession: NoteSession;
  tenantId: string;
  /** 監査ログに残す実行者（例: line:Uxxx） */
  actor: string;
  onCookieRefresh?: (cookieHeader: string) => Promise<void>;
  // ── テストで差し替える ──
  makeClient?: (session: NoteSession) => Pick<NoteClient, 'publish' | 'getNote' | 'canTurnOffComments' | 'latestCookieHeader'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  limits?: { maxChecks?: number; maxUpdates?: number; intervalMs?: number; timeBudgetMs?: number; recentMs?: number };
}

/** note 上の記事を、タグだけのために送り直してよいか（だめなら理由）。 */
export function retagSkipReason(note: PublicNote, expectedNoteId: number): RetagSkipReason | null {
  if (note.status !== 'published') return 'not_published';
  if (Number.isFinite(expectedNoteId) && note.id !== expectedNoteId) return 'id_mismatch';
  if (note.isMyNote === false) return 'not_mine';
  if (note.price > 0 || note.isLimited || note.separator) return 'paid';
  if (note.magazineKeys.length > 0) return 'in_magazine';
  if (!note.body.trim()) return 'empty_body';
  if (note.index === null || note.disableComment === null
    || note.excludeFromCreatorTop === null || note.excludeAiLearning === null) return 'unknown_setting';
  return null;
}

/** こちらの記録で直近に更新した記事か（★note 側の更新日時は API で取れない） */
export function isRecentlyUpdated(row: Pick<RetagRow, 'updated_at' | 'published_at'>, now: number, recentMs = RETAG_RECENT_MS): boolean {
  return [row.updated_at, row.published_at].some((t) => {
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) && now - ms < recentMs;
  });
}

export async function retagPublishedArticles(deps: RetagDeps): Promise<RetagResult> {
  const result: RetagResult = {
    noSession: false, blockedByCommentSetting: false, stoppedBySession: false, stoppedByTime: false,
    updated: 0, alreadyTagged: 0, skipped: 0, deferred: 0, failed: 0, remaining: 0,
  };
  // ★agent モード（Cookie を預からない）や未連携では、サーバーから送れない
  if (!deps.noteSession.cookieHeader) {
    result.noSession = true;
    return result;
  }

  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const maxChecks = deps.limits?.maxChecks ?? RETAG_MAX_CHECKS;
  const maxUpdates = deps.limits?.maxUpdates ?? RETAG_MAX_UPDATES;
  const intervalMs = deps.limits?.intervalMs ?? RETAG_INTERVAL_MS;
  const budgetMs = deps.limits?.timeBudgetMs ?? RETAG_TIME_BUDGET_MS;
  const recentMs = deps.limits?.recentMs ?? RETAG_RECENT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const client = (deps.makeClient ?? ((s: NoteSession) => new NoteClient(s)))(deps.noteSession);
  const outOfTime = (extraMs = 0) => now() - startedAt + extraMs >= budgetMs;

  // ★一度確かめ終えた記事（付け直した・もう付いていた・対象外）は、次の実行で読みに行かない。
  //   こうしないと、記事が多い環境では毎回先頭の確認だけで上限に達し、後ろの記事に届かない
  // ★コメント欄を閉じられるアカウントでは送らない（blockedByCommentSetting の説明を参照）。
  //   閉じられないアカウントなら、どの記事もコメント欄は開いている＝読んだ false は確か
  try {
    if ((await client.canTurnOffComments()) !== false) {
      result.blockedByCommentSetting = true;
      return result;
    }
  } catch (e) {
    if (e instanceof NoteApiError && e.recoverable) { result.stoppedBySession = true; return result; }
    result.blockedByCommentSetting = true;
    return result;
  }

  const done = new Set(await deps.db.listRetagDoneIds(deps.tenantId));
  const candidates = (await deps.db.listPublishedForRetag(deps.tenantId))
    .map((row) => ({ row, desired: parseHashtagsJson(row.hashtags_json) }))
    .filter(({ row, desired }) => desired.length > 0 && !done.has(row.id));
  let checks = 0;

  const audit = async (articleId: string, res: RetagAuditResult, detail: Record<string, unknown>) => {
    try {
      await deps.db.audit(deps.tenantId, RETAG_AUDIT_ACTION, deps.actor, articleId, res, detail);
    } catch (e) {
      log.warn('ハッシュタグ付け直しの記録に失敗', String(e).slice(0, 120));
    }
  };
  const stopHere = (i: number, why: 'limit' | 'time' | 'session') => {
    result.remaining = candidates.length - i;
    if (why === 'time') result.stoppedByTime = true;
    if (why === 'session') result.stoppedBySession = true;
  };

  for (let i = 0; i < candidates.length; i++) {
    const { row, desired } = candidates[i];

    // こちらで直近に更新した記事は、通信せずに今回は見送る
    if (isRecentlyUpdated(row, now(), recentMs)) {
      result.deferred++;
      await audit(row.id, 'deferred', { reason: 'recently_updated' satisfies RetagDeferReason });
      continue;
    }
    // 上限・時間切れなら、残りは次回へ（新しい読み込みを始めない）
    if (checks >= maxChecks || result.updated >= maxUpdates) { stopHere(i, 'limit'); break; }
    if (outOfTime()) { stopHere(i, 'time'); break; }
    checks++;

    let note: PublicNote | null;
    try {
      note = parseNoteDetail(await client.getNote(row.note_key), row.note_key);
    } catch (e) {
      if (e instanceof NoteApiError && e.recoverable) {
        await audit(row.id, 'error', { reason: 'fetch_failed', code: e.code });
        stopHere(i, 'session');
        break;
      }
      note = null;
    }
    if (!note) {
      result.failed++;
      await audit(row.id, 'error', { reason: 'fetch_failed' });
      continue;
    }
    const reason = retagSkipReason(note, Number(row.note_id));
    if (reason) {
      result.skipped++;
      await audit(row.id, 'skipped', { reason });
      continue;
    }
    if (note.hasDraft) {
      // note の画面で編集中。いま送ると、編集中の内容と食い違うおそれがある
      result.deferred++;
      await audit(row.id, 'deferred', { reason: 'editing' satisfies RetagDeferReason });
      continue;
    }
    const plan = mergeHashtags(note.hashtags, desired);
    if (plan.unsafe) {
      result.skipped++;
      await audit(row.id, 'skipped', { reason: 'unsafe_existing_tag' satisfies RetagSkipReason });
      continue;
    }
    if (plan.missing.length === 0) {
      result.alreadyTagged++;
      await audit(row.id, 'already', {});
      continue;
    }

    // 送信の前にも時間を確かめる（間隔を待つと超えるなら、送らずに次回へ）
    const wait = result.updated > 0 ? intervalMs : 0;
    if (outOfTime(wait)) { stopHere(i, 'time'); break; }
    if (wait) await sleep(wait);
    try {
      await client.publish(note.id, note.key, {
        title: note.name,
        html: note.body,
        bodyLength: plainLength(note.body),
        hashtagsVerbatim: plan.send,
        notifyFollowers: false,
        // retagSkipReason で null でないことを確かめてある
        index: note.index!,
        disableComment: note.disableComment!,
        excludeFromCreatorTop: note.excludeFromCreatorTop!,
        excludeAiLearning: note.excludeAiLearning!,
      });
      result.updated++;
      await audit(row.id, 'ok', { added: plan.missing });
    } catch (e) {
      const code = e instanceof NoteApiError ? e.code : 'unknown';
      await audit(row.id, 'error', { code });
      // 連携切れ・混雑は、続けても全部失敗する。ここで止める
      if (e instanceof NoteApiError && e.recoverable) { stopHere(i, 'session'); break; }
      result.failed++;
    }
  }

  if (result.updated > 0) {
    try { await deps.onCookieRefresh?.(client.latestCookieHeader); } catch { /* 保存できなくても付け直しは済んでいる */ }
  }
  return result;
}

/** LINE に返す文面。 */
export function retagSummaryText(r: RetagResult): string {
  if (r.noSession) {
    return 'note の連携情報がサーバーに無いため、ハッシュタグを付け直せませんでした。\n'
      + '（「投稿する場所」がパソコンの設定のときや、note と未連携のときは使えません）';
  }
  if (r.blockedByCommentSetting) {
    return 'この note アカウントはコメント欄を閉じられる設定（プレミアムなど）のため、'
      + '記事のコメント欄の設定を変えてしまわないよう、ハッシュタグの付け直しを見送りました。\n'
      + '（記事には何も送っていません。運用担当に知らせてください）';
  }
  const lines = ['ハッシュタグの付け直しの結果です。', ''];
  lines.push(`付け直した: ${r.updated}本`);
  lines.push(`すでに付いていた: ${r.alreadyTagged}本`);
  if (r.skipped) lines.push(`対象外（有料・マガジン入り・設定が読み取れない など）: ${r.skipped}本`);
  if (r.deferred) lines.push(`今回は見送り（編集中・更新した直後）: ${r.deferred}本`);
  if (r.failed) lines.push(`読めなかった・失敗: ${r.failed}本（もう一度送るとやり直します）`);
  if (r.stoppedBySession) {
    lines.push('', 'note との連携が切れているか、note が混み合っているため途中で止めました。'
      + '連携を確かめてから、もう一度「ハッシュタグを付け直す」と送ってください。');
  } else if (r.remaining > 0 || r.stoppedByTime) {
    lines.push('', `まだ ${r.remaining}本 残っています。少し時間をおいて、もう一度「ハッシュタグを付け直す」と送ると続きから進みます。`);
  } else {
    lines.push('', r.failed || r.deferred ? '失敗・見送りの記事のほかは、すべて確認しました。' : 'すべての記事を確認しました。');
  }
  lines.push('※本文・タイトル・URL は変えていません。フォロワーへの通知もしていません。');
  return lines.join('\n');
}
