/**
 * Chrome 拡張機能からの連携受け口。
 *
 * ★これが「顧客に DevTools を触らせない」の本体。
 *   顧客の操作は「note にログイン → 拡張のボタンを押す → コードを貼る」の3手で終わる。
 *
 * 守り:
 *   ・LINE で発行した使い捨てコードが無ければ何も受け付けない
 *   ・Cookie は保存する前に note で実際に通ることを確かめる
 *     （通らない Cookie を保存すると「連携できたのに投稿できない」が起きる）
 *   ・保存は必ず暗号化。MASTER_KEY_V1 が無ければ連携を断る
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { consumePairingCode } from '../../core/session/pairing';
import { buildCookieHeader, hasSessionCookie, isUsableUserAgent, SESSION_COOKIE } from '../../core/session/cookies';
import { saveNoteSession } from '../../core/session/store';
import { issueDeviceToken } from '../../core/agent/jobs';
import { CryptoConfigError } from '../../core/tenant/crypto';
import { NoteClient } from '../../ports/publisher/note/client';
import { Db, DEFAULT_TENANT_ID } from '../../ports/storage/db';
import { LineClient, text } from '../line/client';
import { log } from '../../lib/mask';
import { resolveMasterKey } from '../../core/setup/masterkey';
import { switchTo } from '../../core/line/richmenu';

const ConnectBody = z.object({
  code: z.string().min(4).max(32),
  cookies: z.array(z.object({
    name: z.string().min(1).max(128),
    value: z.string().max(8192),
    domain: z.string().max(128).optional(),
  })).min(1).max(80),
  userAgent: z.string().min(1).max(512),
  /** 拡張が拾えていれば送ってくる。最終的には note 本体に聞いた値を正とする */
  urlname: z.string().max(128).optional(),
});

/** 拡張機能から呼べるようにする（Cookie は使わないので `*` で足りる）。 */
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin?.startsWith('chrome-extension://') ? origin : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

/** 拡張が「つなぎ先が合っているか」を確かめるための軽い応答。 */
export function handleConnectPing(req: Request): Response {
  const origin = req.headers.get('origin');
  return json({ ok: true, service: 'note-line-poster' }, 200, origin);
}

export function handleConnectPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function handleConnectNote(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('origin');

  let parsed: z.infer<typeof ConnectBody>;
  try {
    parsed = ConnectBody.parse(await req.json());
  } catch {
    return json({ ok: false, message: '送信内容が正しくありません。拡張機能を最新版に更新してください。' }, 400, origin);
  }

  // ── 1. 使い捨てコード（本人であることの唯一の根拠）──────────
  const pairing = await consumePairingCode(env.KV, parsed.code);
  if (!pairing) {
    log.warn('連携コードが一致しませんでした');
    return json({
      ok: false,
      message: '連携コードが違うか、期限が切れています。\nLINE で「note連携」と送って、新しいコードを受け取ってください。',
    }, 401, origin);
  }

  // ── 2. Cookie の形を確かめる ───────────────────────────
  if (!hasSessionCookie(parsed.cookies)) {
    return json({
      ok: false,
      message: 'note にログインしていないようです。\nnote.com を開いてログインしてから、もう一度お試しください。',
    }, 400, origin);
  }
  if (!isUsableUserAgent(parsed.userAgent)) {
    return json({ ok: false, message: 'ブラウザ情報を取得できませんでした。拡張機能を再読み込みしてください。' }, 400, origin);
  }

  const cookieHeader = buildCookieHeader(parsed.cookies);

  // ── 3. 実際に note で通るか確かめてから保存する ──────────
  const probe = new NoteClient({ cookieHeader, userAgent: parsed.userAgent, urlname: parsed.urlname ?? '' });
  let me: { id: number; urlname: string; nickname: string };
  try {
    me = await probe.currentUser();
  } catch (e) {
    log.warn('連携時の note 疎通に失敗', String(e));
    return json({
      ok: false,
      message: 'note との通信を確認できませんでした。\nnote.com にログインし直してから、もう一度お試しください。',
    }, 400, origin);
  }

  // ── 4. 端末を登録する ───────────────────────────────
  const db = new Db(env.DB);
  const tenant = await db.getTenant(pairing.tenantId);
  const agentMode = tenant.execution_mode === 'agent';

  const { token: deviceToken } = await issueDeviceToken(env.DB, pairing.tenantId, {
    label: shortUaLabel(parsed.userAgent),
    noteUrlname: me.urlname,
  });

  // ── 5. ログイン情報の預かり ─────────────────────────
  // ★agent モードでは Cookie を保存しない。
  //   投稿はお客さまのブラウザが行うので、こちらが持つ理由が無い。
  //   持たなければ、漏れることも、まとめて失効させられることも無い。
  if (!agentMode) {
    try {
      await saveNoteSession(env.DB, pairing.tenantId, {
        // 疎通の時点で note が振り直した Cookie があればそちらを使う
        cookieHeader: probe.latestCookieHeader || cookieHeader,
        userAgent: parsed.userAgent,
        urlname: me.urlname,
      }, (await resolveMasterKey(env)).key);
    } catch (e) {
      if (e instanceof CryptoConfigError) {
        log.error('暗号化鍵が未設定のため連携を拒否しました');
        return json({
          ok: false,
          message: 'サーバー側の設定が未完了です。提供元にご連絡ください。',
        }, 503, origin);
      }
      throw e;
    }
  }

  await db.audit(pairing.tenantId, 'session.connected', `line:${pairing.lineUserId}`, me.urlname, 'ok',
    { mode: tenant.execution_mode });

  // ── 5. LINE に結果を返す（拡張の画面を閉じても分かるように）──
  const waiting = await countAwaitingSession(env, pairing.tenantId);
  const line = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV);
  await line.push(pairing.lineUserId, [text(
    `note と連携しました。\n投稿先: ${me.nickname}（@${me.urlname}）\n\n` +
    (agentMode
      ? 'この連携では、投稿はあなたのパソコンの Chrome から行います。\n' +
        'ログイン情報は保存しません。\n\n'
      : 'ログイン情報は、このシステムの中に暗号化して保存しました。\n' +
        'このシステムはあなた専用なので、ほかの人と混ざることはありません。\n' +
        'いつでも「連携解除」で消せます。\n\n') +
    (waiting > 0
      ? `お待たせしていた記事が ${waiting} 件あります。順番に投稿しますので、そのままお待ちください。`
      : 'このまま記事を作れます。'),
  )]).catch(() => { /* 通知が失敗しても連携自体は成立している */ });

  // ★繋がったので、通常の3ボタンへ切り替える（顧客の操作は不要）
  await switchTo(env.LINE_CHANNEL_ACCESS_TOKEN, env.KV, 'normal');

  log.info('note 連携が完了しました', { urlname: me.urlname, waiting, mode: tenant.execution_mode });
  return json({
    ok: true,
    urlname: me.urlname,
    nickname: me.nickname,
    waiting,
    mode: tenant.execution_mode,
    // ★拡張はこれを保存して、以後この token で名乗る
    deviceToken,
    // agent なら拡張が投稿を実行する。画面の説明を切り替えるために返す
    executesLocally: agentMode,
  }, 200, origin);
}

/** 連携切れで止まっている記事の件数。 */
async function countAwaitingSession(env: Env, tenantId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE tenant_id = ? AND state = 'awaiting_session'`)
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export { SESSION_COOKIE, DEFAULT_TENANT_ID };

/** 端末の見分けがつく程度の短い名前にする（UA をそのまま保存しない）。 */
function shortUaLabel(ua: string): string {
  const os = /Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : 'その他';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'ブラウザ';
  return `${browser} on ${os}`;
}
