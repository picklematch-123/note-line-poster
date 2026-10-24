/**
 * ポリシーで待機中（blocked / awaiting_session）の記事を再開する（15分ごと）。
 *
 * 「上限に達したので明朝投稿します」と約束した以上、必ず自動で投稿する。
 */
import { llmConfigFromEnv } from '../ports/llm';
import type { Env } from '../env';
import { Db, DEFAULT_TENANT_ID } from '../ports/storage/db';
import { LineClient, text } from '../adapters/line/client';
import { checkPolicy, publishArticle, type ServiceDeps } from '../core/article/service';
import { dispatchPublish } from '../core/agent/dispatch';
import { DisallowedLinksError, linkBlockRecipients } from '../core/article/links';
import { KvImageStore } from '../ports/storage/images';
import { resolveNoteSession, persistRefreshedCookie } from '../core/session/resolve';
import { log } from '../lib/mask';

export async function retryBlocked(env: Env): Promise<void> {
  const db = new Db(env.DB);
  // env に無ければ、最初に話しかけた人として登録済みのオーナーを使う
  const ownerId = env.LINE_OWNER_USER_ID || (await db.getOwnerLineUserId(DEFAULT_TENANT_ID));
  const { session, origin } = await resolveNoteSession(env);
  const deps: ServiceDeps = {
    db,
    llm: llmConfigFromEnv(env),
    noteSession: session,
    ownerLineUserId: ownerId,
    // ★投稿者が承認した記事も、条件が戻れば自動で出す（外された人の承認は通らない）
    staffLineUserIds: await db.listStaffIds(DEFAULT_TENANT_ID),
    images: new KvImageStore(env.KV),
    onCookieRefresh: (cookieHeader) => persistRefreshedCookie(env, origin, cookieHeader),
  };

  const waiting = await env.DB
    .prepare(`SELECT id, approved_by FROM articles
              WHERE tenant_id = ? AND state IN ('blocked','awaiting_session')
                -- awaiting_agent は拡張が取りに来るのを待っている状態なので触らない
              ORDER BY approved_at ASC LIMIT 5`)
    .bind(DEFAULT_TENANT_ID)
    .all<{ id: string; approved_by: string | null }>();

  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV);

  for (const row of waiting.results ?? []) {
    const decision = await checkPolicy(deps, row.id);
    if (!decision.allowed) continue;   // まだ条件が回復していない

    try {
      // ★実行先を必ず通す。ここを素通りさせると agent 設定のテナントでも
      //   サーバーから叩いてしまい、分散させた意味が無くなる
      const dispatch = await dispatchPublish(deps, row.id, 'publish');
      if (dispatch.mode !== 'server') {
        log.info('待機中の記事を拡張へ回しました', { articleId: row.id, mode: dispatch.mode });
        continue;
      }

      const { url } = await publishArticle(deps, row.id);
      log.info('待機中の記事を自動投稿しました', { articleId: row.id });
      // ★「公開する」を押した人に知らせる（投稿者が出した記事なら投稿者へ）
      const notify = row.approved_by ?? ownerId;
      if (notify) {
        await line.push(notify, [text(`お待たせしました。公開しました。\n${url}`)]);
      }
    } catch (e) {
      if (e instanceof DisallowedLinksError) {
        // ★リンク検査で止めた。記事は failed に落としてあるので、次の Cron で同じ記事を繰り返し試さない。
        //   「公開する」を押した人・担当者・持ち主に知らせる
        const a = await db.getArticle(row.id);
        for (const to of linkBlockRecipients(a, ownerId, row.approved_by)) {
          await line.push(to, [text(e.userMessage)]);
        }
      } else {
        log.warn('自動投稿に失敗', String(e));
      }
    }
    // 全体流量を守るため、1回の Cron では1件だけ投稿する
    break;
  }
}
