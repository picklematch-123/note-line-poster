/**
 * LINE のナレッジの入口を「確認」と「修正」に分けた（2026-11 オーナー指示）。
 *
 * ★守っているもの
 *   1. 「ナレッジを確認」で全文がそのまま返る（コード不要・投稿者も見られる）
 *   2. 長文は分けて送り、送り切れないときは続きの見方を案内する（投稿者には「持ち主に」）
 *   3. 「ナレッジを修正」のあとに送った文章は書き足される（既定）
 *   4. 投稿者には削除系（1件消す・入れ替える・全部消す）を出さない／「3番を消す」も効かない
 *   5. 旧来の文言（「ナレッジ」「プロフィールを登録する」）・リッチメニューのボタンも反応する
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_STAFF, MAX_ADMINS } from '../../src/core/line/members';
import { COMMANDS } from '../../src/adapters/line/commands';
import { normalizeCommand, parseDeleteRequest } from '../../src/adapters/line/mode';
import {
  buildKnowledgeFull, splitIntoChunks, FULL_CHUNK_SIZE, FULL_MAX_MESSAGES,
} from '../../src/adapters/line/messages/knowledge';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import { signLineBody } from '../../src/adapters/line/signature';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

const ROOT = new URL('../../', import.meta.url).pathname;
const SECRET = 'line-secret-test';

function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return db;
}

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) { params = p; return api; },
        async first<T>() { return (db.prepare(sql).get(...(params as [])) as T) ?? null; },
        async run() { const r = db.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all<T>() { return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

afterEach(() => vi.restoreAllMocks());

/** 署名つき webhook を通す。返事は「最後の返信の messages」を返す */
async function webhookEnv(knowledge?: string) {
  const sqlite = migrate();
  const d1 = asD1(sqlite);
  const db = new Db(d1);
  await db.ensureTenant();
  await db.addStaff(DEFAULT_TENANT_ID, 'staff1', 'スタッフ', 'owner', MAX_STAFF);
  await db.addAdmin(DEFAULT_TENANT_ID, 'admin1', '運用担当', 'owner', MAX_ADMINS);
  if (knowledge) await db.saveContext(DEFAULT_TENANT_ID, knowledge, null, knowledge);
  const replies: Array<Array<{ type: string; text: string; quickReply?: { items: Array<{ action: { label: string; data?: string } }> } }>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/message/reply')) replies.push(JSON.parse(String(init?.body)).messages);
    return new Response('{}', { status: 200 });
  });
  const kv = fakeKv();
  const created: unknown[] = [];
  const env = {
    DB: d1, KV: kv, LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner',
    GENERATE: { create: async (p: unknown) => { created.push(p); return { id: 'w' }; } },
  };
  const { handleLineWebhook } = await import('../../src/adapters/line/webhook');
  const send = async (userId: string, ev: { text?: string; postback?: string }) => {
    const event = ev.text !== undefined
      ? { type: 'message', replyToken: 'rt', source: { userId }, message: { id: 'm', type: 'text', text: ev.text } }
      : { type: 'postback', replyToken: 'rt', source: { userId }, postback: { data: ev.postback } };
    const body = JSON.stringify({ events: [event] });
    const pending: Array<Promise<unknown>> = [];
    const res = await handleLineWebhook(new Request('https://x/line/webhook', {
      method: 'POST', body, headers: { 'x-line-signature': await signLineBody(body, SECRET) },
    }), env as never, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as never);
    expect(res.status).toBe(200);
    await Promise.all(pending);
    return replies[replies.length - 1] ?? [];
  };
  return { db, kv, send, created };
}

const allText = (msgs: Array<{ text: string }>) => msgs.map((m) => m.text).join('\n');
const labels = (msgs: Array<{ quickReply?: { items: Array<{ action: { label: string } }> } }>) =>
  (msgs[msgs.length - 1]?.quickReply?.items ?? []).map((i) => i.action.label);

const SAMPLE = '店主のことは「店長」と書く。\n\n記事の最後に https://example.com/ig のリンクを入れる。\n\n席は20席。コーヒーは180円。';

// ── コマンド判定 ──────────────────────────────────────────
describe('ナレッジの入口: コマンド判定', () => {
  it('「確認」「修正」の文字ゆれを受ける。互いに取り違えない', () => {
    for (const t of ['ナレッジを確認', 'ナレッジ確認', 'ナレッジ を 確認', 'ナレッジを見る']) {
      expect(COMMANDS.knowledgeView.test(normalizeCommand(t)), t).toBe(true);
      expect(COMMANDS.knowledgeEdit.test(normalizeCommand(t)), t).toBe(false);
    }
    for (const t of ['ナレッジを修正', 'ナレッジ修正', 'ナレッジを直す', 'ナレッジを追加']) {
      expect(COMMANDS.knowledgeEdit.test(normalizeCommand(t)), t).toBe(true);
      expect(COMMANDS.knowledgeView.test(normalizeCommand(t)), t).toBe(false);
    }
  });

  it('★旧来の文言（ナレッジ・プロフィールを登録する）は、引き続き入口（2択）に届く', () => {
    for (const t of ['ナレッジ', 'プロフィールを登録する', 'プロフィール登録']) {
      expect(COMMANDS.knowledge.test(normalizeCommand(t)), t).toBe(true);
      expect(COMMANDS.knowledgeView.test(normalizeCommand(t)), t).toBe(false);
      expect(COMMANDS.knowledgeEdit.test(normalizeCommand(t)), t).toBe(false);
    }
  });

  it('「3番を消す」の番号を拾う。ふつうの文は拾わない', () => {
    expect(parseDeleteRequest('3番を消す')).toBe(3);
    expect(parseDeleteRequest('３を削除して')).toBe(3);
    expect(parseDeleteRequest('12番目を消して')).toBe(12);
    expect(parseDeleteRequest('3番の席数を20席に直す')).toBeNull();
    expect(parseDeleteRequest('0番を消す')).toBeNull();
  });
});

// ── 全文表示（純関数）──────────────────────────────────────
describe('ナレッジを確認: 全文の組み立て', () => {
  it('番号付きで全文が入り、最後の1通に「修正する」ボタン', () => {
    const msgs = buildKnowledgeFull(SAMPLE, true);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain('全3件');
    expect(msgs[0].text).toContain('【1】\n店主のことは「店長」と書く。');
    expect(msgs[0].text).toContain('https://example.com/ig');
    expect(msgs[0].text).toContain('【3】\n席は20席。コーヒーは180円。');
    expect(labels(msgs)).toContain('修正する');
  });

  it('長文は分けて送る（1通の上限を超えない・段落の途中で切らない）', () => {
    const entries = Array.from({ length: 6 }, (_, i) => `メモ${i + 1}:` + 'あ'.repeat(1500));
    const msgs = buildKnowledgeFull(entries.join('\n\n'), true);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.length).toBeLessThanOrEqual(FULL_MAX_MESSAGES);
    for (const m of msgs) expect(m.text.length).toBeLessThanOrEqual(FULL_CHUNK_SIZE);
    for (let i = 1; i <= 6; i++) expect(allText(msgs)).toContain(`【${i}】\nメモ${i}:`);
    expect(allText(msgs)).not.toContain('表示しきれませんでした');
  });

  it('★5通に収まらないときは、続きの見方を案内する（持ち主・管理者は「セットアップ」、投稿者は「持ち主に」）', () => {
    const huge = Array.from({ length: 40 }, (_, i) => `メモ${i + 1}:` + 'い'.repeat(1000)).join('\n\n');
    const owner = buildKnowledgeFull(huge, true);
    expect(owner).toHaveLength(FULL_MAX_MESSAGES);
    for (const m of owner) expect(m.text.length).toBeLessThanOrEqual(FULL_CHUNK_SIZE);
    expect(owner[FULL_MAX_MESSAGES - 1].text).toContain('「セットアップ」');
    const staff = buildKnowledgeFull(huge, false);
    expect(staff[FULL_MAX_MESSAGES - 1].text).toContain('持ち主の方に');
    expect(staff[FULL_MAX_MESSAGES - 1].text).not.toContain('「セットアップ」');
  });

  it('splitIntoChunks: 1段落が上限を超えるときだけ途中で切る', () => {
    const chunks = splitIntoChunks('a'.repeat(9000), 4000);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
  });
});

// ── webhook を通した流れ ────────────────────────────────────
describe('ナレッジの入口: LINE の流れ（webhook）', () => {
  it('★「ナレッジを確認」で全文が返る（コード不要・投稿者も可）', async () => {
    for (const who of ['owner', 'admin1', 'staff1']) {
      const { send } = await webhookEnv(SAMPLE);
      const r = await send(who, { text: 'ナレッジを確認' });
      expect(allText(r), who).toContain('https://example.com/ig');
      expect(allText(r), who).toContain('席は20席。コーヒーは180円。');
      expect(allText(r), who).not.toContain('コード');
    }
  });

  it('ゲスト（投稿者でない人）には見せない', async () => {
    const { send } = await webhookEnv(SAMPLE);
    expect(allText(await send('stranger', { text: 'ナレッジを確認' }))).not.toContain('example.com');
  });

  it('★リッチメニューの「ナレッジ」・旧文言は2択（確認する／修正する）を出す', async () => {
    for (const t of ['ナレッジ', 'プロフィールを登録する']) {
      const { send } = await webhookEnv(SAMPLE);
      const r = await send('owner', { text: t });
      expect(labels(r), t).toEqual(expect.arrayContaining(['確認する', '修正する']));
    }
    // メニューの「ナレッジ」ボタン（postback）も同じ
    const { send } = await webhookEnv(SAMPLE);
    expect(labels(await send('owner', { postback: 'action=menu_profile' }))).toEqual(expect.arrayContaining(['確認する', '修正する']));
  });

  it('2択の「確認する」で全文、以前の「全文を見る」ボタンも全文', async () => {
    const { send } = await webhookEnv(SAMPLE);
    expect(allText(await send('staff1', { postback: 'action=ctx_view' }))).toContain('席は20席');
    expect(allText(await send('staff1', { postback: 'action=ctx_full' }))).toContain('席は20席');
  });

  it('★「ナレッジを修正」で操作案内が出て、続けて送った文が書き足される', async () => {
    const { send, db, created } = await webhookEnv(SAMPLE);
    const r = await send('owner', { text: 'ナレッジを修正' });
    expect(allText(r)).toContain('書き足します');
    expect(allText(r)).toContain('セットアップ');
    expect(labels(r)).toEqual(expect.arrayContaining(['1件消す', '入れ替える', '全部消す']));
    await send('owner', { text: '定休日は水曜日。祝日は営業する。' });
    const after = await db.getActiveContext(DEFAULT_TENANT_ID);
    expect(after?.raw_text).toContain('店主のことは「店長」と書く。');      // 元の内容は残る
    expect(after?.raw_text).toContain('定休日は水曜日。祝日は営業する。');   // 書き足された
    expect(created).toHaveLength(1);                                         // 整理は Workflow へ
  });

  it('★投稿者には削除系を出さない。書き足しはできる。「3番を消す」は効かない', async () => {
    const { send, db } = await webhookEnv(SAMPLE);
    const r = await send('staff1', { text: 'ナレッジを修正' });
    expect(labels(r)).not.toEqual(expect.arrayContaining(['1件消す']));
    for (const l of ['1件消す', '入れ替える', '全部消す']) expect(labels(r)).not.toContain(l);
    expect(allText(r)).not.toContain('セットアップ');
    await send('staff1', { text: '3番を消す' });
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toContain('席は20席');
    await send('staff1', { text: 'ナレッジを修正' });
    await send('staff1', { text: 'お客さんからはテイクアウトの質問が多い。' });
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toContain('テイクアウトの質問が多い');
  });

  it('持ち主・管理者は「修正」の最中に「3番を消す」で1件消せる', async () => {
    for (const who of ['owner', 'admin1']) {
      const { send, db } = await webhookEnv(SAMPLE);
      await send(who, { text: 'ナレッジを修正' });
      const r = await send(who, { text: '3番を消す' });
      expect(allText(r), who).toContain('消しました');
      const after = (await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text ?? '';
      expect(after, who).not.toContain('席は20席');
      expect(after, who).toContain('店主のことは「店長」と書く。');
    }
  });

  it('まだ何も覚えていないときの「修正」は、次の文をそのまま覚える', async () => {
    const { send, db } = await webhookEnv();
    expect(allText(await send('owner', { text: 'ナレッジを確認' }))).toContain('まだ何も覚えていません');
    await send('owner', { text: 'ナレッジを修正' });
    await send('owner', { text: 'うちは福岡の小さなカフェです。' });
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toBe('うちは福岡の小さなカフェです。');
  });
});

// ── 源蔵レビュー（2026-11）の必須1・2 ─────────────────────────
describe('ナレッジの書き足し待ち中の記事への返事（必須1）', () => {
  async function withPreview() {
    const h = await webhookEnv(SAMPLE);
    const a = await h.db.createArticle(DEFAULT_TENANT_ID, 'ネタ', null);
    await h.db.updateArticle(a.id, { state: 'awaiting_approval', title: 'テスト記事', body_md: '本文です。' });
    return { ...h, articleId: a.id };
  }

  it('★プレビュー待ち中に 修正する→「OK」: 公開の流れに乗り、ナレッジは増えない', async () => {
    const { send, db, created, articleId } = await withPreview();
    await send('owner', { text: 'ナレッジを修正' });
    const r = await send('owner', { text: 'OK' });
    expect(allText(r)).not.toContain('覚えました');
    expect(allText(r)).not.toContain('書き足していません');
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toBe(SAMPLE);
    expect(created).toHaveLength(0);                             // ナレッジの整理は走らない
    expect((await db.getArticle(articleId))?.state).not.toBe('awaiting_approval'); // 公開の処理に進んだ
  });

  it('プレビュー待ち中に 修正する→「下書き」「公開しない」も記事への返事として扱う', async () => {
    for (const t of ['下書き', '公開しない']) {
      const { send, db, articleId } = await withPreview();
      await send('owner', { text: 'ナレッジを修正' });
      const r = await send('owner', { text: t });
      expect(allText(r), t).not.toContain('覚えました');
      expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text, t).toBe(SAMPLE);
      if (t === '公開しない') {
        expect(allText(r)).toContain('公開はしていません');
        expect((await db.getArticle(articleId))?.state).toBe('awaiting_approval');
      }
    }
  });

  it('「やめる」は書き足しをやめるだけ（記事は取りやめない）', async () => {
    const { send, db, articleId } = await withPreview();
    await send('owner', { text: 'ナレッジを修正' });
    const r = await send('owner', { text: 'やめる' });
    expect(allText(r)).toContain('ナレッジの登録をやめました');
    expect(allText(r)).toContain('確認待ちの記事は、そのまま');
    expect((await db.getArticle(articleId))?.state).toBe('awaiting_approval');
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toBe(SAMPLE);
  });

  it('判断待ちの記事が無いときの「OK」は保存せず、書き足すかを聞き返す', async () => {
    const { send, db } = await webhookEnv(SAMPLE);
    await send('owner', { text: 'ナレッジを修正' });
    const r = await send('owner', { text: 'OK' });
    expect(allText(r)).toContain('ナレッジに書き足しますか');
    expect(labels(r)).toEqual(expect.arrayContaining(['書き足す', 'やめる']));
    expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text).toBe(SAMPLE);
  });
});

describe('投稿者が削除系の postback を手で作って送っても効かない（必須2）', () => {
  it('★ctx_clear / ctx_replace / ctx_delete は拒否され、DB も入力待ちも変わらない', async () => {
    for (const data of ['action=ctx_clear', 'action=ctx_replace', 'action=ctx_delete']) {
      const { send, db, kv } = await webhookEnv(SAMPLE);
      const r = await send('staff1', { postback: data });
      expect(allText(r), data).toContain('持ち主・管理者だけ');
      expect((await db.getActiveContext(DEFAULT_TENANT_ID))?.raw_text, data).toBe(SAMPLE);
      expect(kv.store.has(`mode:${DEFAULT_TENANT_ID}:staff1`), data).toBe(false);
    }
  });

  it('1件消したあとの返事に「番号が繰り上がった」と添える', async () => {
    const { send } = await webhookEnv(SAMPLE);
    await send('owner', { postback: 'action=ctx_delete' });
    expect(allText(await send('owner', { text: '1' }))).toContain('繰り上がりました');
  });
});
