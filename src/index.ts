/**
 * Worker のエントリポイント。
 *
 * ★ここは薄く保つ。ルーティングと配線だけで、判断はしない。
 *   入口が増えても（REST は Phase 2、MCP は Phase 3）、ここに数行足すだけで済むようにする。
 */
import { chooseProvider, describeMissingLlm, llmConfigFromEnv } from './ports/llm';
import { Hono } from 'hono';
import type { Env } from './env';
import { handleLineWebhook } from './adapters/line/webhook';
import { Db } from './ports/storage/db';
import { sessionHealth } from './cron/session-health';
import { retryBlocked } from './cron/retry-blocked';
import { handleConnectNote, handleConnectPing, handleConnectPreflight } from './adapters/connect/router';
import { handleAgentPoll, handleAgentResult, handleAgentAsset, handleAgentPreflight } from './adapters/agent/router';
import { resolveNoteSession } from './core/session/resolve';
import { resolveMasterKey } from './core/setup/masterkey';
import { setupRouter } from './adapters/setup/router';
import { hasDevice, isAgentOnline } from './core/agent/jobs';
import { loadNoteSession } from './core/session/store';
import { DEFAULT_TENANT_ID } from './ports/storage/db';
import { REQUIRED_COLUMNS } from './core/setup/schema-check';
import { VERSION } from './version';

export { GenerateArticleWorkflow } from './workflows/generate-article';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.json({ name: 'note-line-poster', phase: 1, ok: true }));

/**
 * 死活確認。
 * ★D1 に到達できるかだけでなく、コードが必要とする列が揃っているかも見る。
 *   マイグレーションを流し忘れてデプロイすると、顧客が操作した瞬間に
 *   「no such column」で落ちる。それを先に見つけるための検査。
 */
app.get('/health', async (c) => {
  const checks: Record<string, string> = {};
  let ok = true;

  try {
    await new Db(c.env.DB).getFlag('publish_enabled');
    checks.d1 = 'ok';
  } catch (e) {
    checks.d1 = String(e).slice(0, 200);
    ok = false;
  }

  // コードが依存している列。増やしたら core/setup/schema-check.ts に足す
  const required = REQUIRED_COLUMNS;

  for (const [table, columns] of Object.entries(required)) {
    try {
      const info = await c.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const have = new Set((info.results ?? []).map((r) => r.name));
      const missing = columns.filter((col) => !have.has(col));
      if (missing.length > 0) {
        checks[table] = `列が足りません: ${missing.join(', ')}（マイグレーション未適用）`;
        ok = false;
      } else {
        checks[table] = 'ok';
      }
    } catch (e) {
      checks[table] = String(e).slice(0, 200);
      ok = false;
    }
  }

  // note 連携の状態。★秘密情報は出さない（方式と状態だけ）
  try {
    const db = new Db(c.env.DB);
    const tenant = await db.getTenant(DEFAULT_TENANT_ID);
    checks.execution_mode = tenant.execution_mode;

    // ★鍵の「置き場所」だけを出す。値は絶対に出さない。
    //   none のままだと note 連携ができないので、気づけるようにしておく
    const mk = await resolveMasterKey(c.env);
    checks.master_key = mk.source;
    if (mk.source === 'none') ok = false;

    if (tenant.execution_mode === 'agent') {
      // agent では Cookie を預からない。見るべきは「拡張が繋がっているか」
      const connected = await hasDevice(c.env.DB, DEFAULT_TENANT_ID);
      const online = connected && (await isAgentOnline(c.env.DB, DEFAULT_TENANT_ID));
      checks.note_session = connected ? (online ? 'agent/online' : 'agent/offline') : 'agent/not_connected';
      if (!connected) ok = false;
    } else {
      const { origin } = await resolveNoteSession(c.env);
      const stored = origin === 'extension'
        ? await loadNoteSession(c.env.DB, DEFAULT_TENANT_ID, (await resolveMasterKey(c.env)).key)
        : null;
      checks.note_session = `${origin}${stored ? `/${stored.status}` : ''}`;
      if (origin === 'none') ok = false;
    }
  } catch (e) {
    checks.note_session = String(e).slice(0, 200);
    ok = false;
  }

  // 文章生成に使う提供元（秘密は出さない）。使えなければ ok を落とす
  const llmCfg = llmConfigFromEnv(c.env);
  const provider = chooseProvider(llmCfg);
  checks.llm = provider ?? describeMissingLlm(llmCfg);
  if (!provider) ok = false;
  checks.thumbnail = c.env.OPENAI_API_KEY ? 'enabled' : 'disabled（OPENAI_API_KEY 未登録）';

  // ★version は追加のみ（既存の ok / checks の形は変えない）。運用側の `npm run fleet` が読む
  return c.json({ ok, version: VERSION, checks }, ok ? 200 : 500);
});

/** LINE Webhook（署名検証は handleLineWebhook 内で行う）。 */
// ★配備したあと、ブラウザだけで仕上げるための画面
app.route('/', setupRouter);

app.post('/line/webhook', (c) => handleLineWebhook(c.req.raw, c.env, c.executionCtx));

/**
 * Chrome 拡張からの note 連携。
 * 認証は LINE で発行した使い捨てコード1本（adapters/connect/router.ts）。
 */
app.options('/connect/note', (c) => handleConnectPreflight(c.req.raw));
app.post('/connect/note', (c) => handleConnectNote(c.req.raw, c.env));
app.get('/connect/ping', (c) => handleConnectPing(c.req.raw));

/**
 * 拡張機能が note を叩くための窓口。
 * ★ここを通すことで、note から見たアクセス元が顧客本人になる。
 *   全員がサーバーから叩くと、1件のスパム判定で全員が同時に止まる。
 */
app.options('/agent/*', (c) => handleAgentPreflight(c.req.raw));
app.post('/agent/poll', (c) => handleAgentPoll(c.req.raw, c.env));
app.post('/agent/result', (c) => handleAgentResult(c.req.raw, c.env));
app.get('/agent/asset/:id', (c) => handleAgentAsset(c.req.raw, c.env, c.req.param('id')));

export default {
  fetch: app.fetch,

  /** Cron: 毎日09:00 JST = セッション監視 / 15分ごと = blocked の再開 */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 0 * * *') {
      ctx.waitUntil(sessionHealth(env));
    } else {
      ctx.waitUntil(retryBlocked(env));
    }
  },
};
