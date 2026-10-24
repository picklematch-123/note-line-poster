/**
 * 公開・下書き保存の直前のリンク検査（★2026-10-24 源蔵 再レビューの条件）。
 * 本物の D1 の代わりに node:sqlite へ全マイグレーションを流して動かす。note・LINE への通信は偽物。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID, type ArticleRow } from '../../src/ports/storage/db';
import { publishArticle, saveArticleAsDraft, type ServiceDeps } from '../../src/core/article/service';
import { dispatchPublish } from '../../src/core/agent/dispatch';
import { buildPlan } from '../../src/core/agent/plan';
import { retryBlocked } from '../../src/cron/retry-blocked';
import {
  DisallowedLinksError, AUDIT_LINK_BLOCKED, precheckArticleLinks, findArticleLinkProblems, buildAllowedLinks,
  renderWithPlaceholders, linkBlockRecipients,
} from '../../src/core/article/links';
import { finalizeArticle } from '../../src/core/research/finalize';
import type { Env } from '../../src/env';

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); databases.splice(0).forEach((db) => db.close()); });

function asD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let params: unknown[] = [];
    const api = {
      bind(...values: unknown[]) { params = values; return api; },
      async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
      async run() { const result = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return api;
  } } as unknown as D1Database;
}

const KNOWLEDGE_URL = 'https://shop.example.jp/reserve';
const OLD_KNOWLEDGE_URL = 'https://old.example.jp/menu';
const IDEA_URL = 'https://idea.example.jp/campaign?id=1';
const SOURCE_URL = 'https://www.mhlw.go.jp/stf/kenkou(2024).html';
const NOTE_IMG = 'https://assets.st-note.com/img/1700000000-abc.png';
const EVIL = 'https://evil.example.com/x';

async function setup(opts: { body: string; research?: unknown; images?: number; state?: string; sourceText?: string } ) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  }
  const db = new Db(asD1(sqlite));
  await db.ensureTenant();
  // ナレッジ: 古い版（無効）→ 新しい版（有効）
  await db.saveContext(DEFAULT_TENANT_ID, `昔のメニューはこちら ${OLD_KNOWLEDGE_URL}`, {}, '');
  await db.saveContext(DEFAULT_TENANT_ID, `文末に予約リンク ${KNOWLEDGE_URL} を付けること`, {}, '');
  const article = await db.createArticle(DEFAULT_TENANT_ID, opts.sourceText ?? `キャンペーンの記事 ${IDEA_URL}`, 'staff1');
  await db.updateArticle(article.id, {
    state: (opts.state ?? 'awaiting_approval') as ArticleRow['state'],
    title: 'テスト記事', body_md: opts.body,
    approved_at: new Date().toISOString(), approved_by: 'owner',
    ...(opts.research ? { research_json: JSON.stringify(opts.research) } : {}),
  });
  for (let i = 0; i < (opts.images ?? 0); i++) {
    await db.addImage(DEFAULT_TENANT_ID, { articleId: article.id, r2Key: `k${i}`, mimeType: 'image/png', sizeBytes: 3, lineMessageId: `m${i}` });
  }
  const deps = {
    db, ownerLineUserId: 'owner', staffLineUserIds: ['staff1'],
    llm: { provider: 'openai', openaiKey: 'sk-test' },
    noteSession: { cookieHeader: '_note_session_v5=x', userAgent: 'ua', urlname: 'test' },
    images: { get: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png' }) },
  } as unknown as ServiceDeps;
  return { db, sqlite, article: (await db.getArticle(article.id))!, deps };
}

/** note の偽物。呼ばれた URL を記録する */
function fakeNote() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (u.includes('/v2/current_user')) return json({ id: 1, urlname: 'test', nickname: 't' });
    if (u.endsWith('/v1/text_notes')) return json({ id: 123, key: 'nabc', slug: 'slug-nabc' });
    if (u.includes('text_note_picture')) return json({ url: NOTE_IMG, width: 620 });
    if (u.includes('api.line.me')) return new Response('{}', { status: 200 });
    return json({});
  });
  return calls;
}

const auditCount = (sqlite: DatabaseSync) =>
  (sqlite.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?').get(AUDIT_LINK_BLOCKED) as { c: number }).c;

/** 仕上げを通った本文（ナレッジ・ネタ・出典・画像） */
function finalizedBody(): { body: string; research: unknown } {
  const facts = [{ id: 1, claim: '手洗いは30秒以上が目安', sourceUrl: SOURCE_URL, sourceTitle: '手洗いの目安' }];
  const fin = finalizeArticle({
    markdown: `## はじめに\n手洗いは30秒以上〔1〕。詳しくは ${IDEA_URL} へ。\n\n[画像1]\n\n## まとめ\n[ご予約はこちら](${KNOWLEDGE_URL})`,
    facts,
    trustedTexts: [`文末に予約リンク ${KNOWLEDGE_URL} を付けること`, `キャンペーンの記事 ${IDEA_URL}`],
  });
  return {
    body: fin.markdown,
    research: { v: 1, status: 'ok', facts, referencedUrls: [SOURCE_URL], dropped: 0, searchCalls: 1, domains: 'any', at: '2026-10-24T00:00:00Z' },
  };
}

describe('★公開・下書き保存の直前のリンク検査（源蔵 再レビューの条件）', () => {
  it('正常系: 仕上げを通った記事（ナレッジ・ネタ・出典〔括弧入りURL〕・note の画像）は下書き保存まで通る', async () => {
    const { body, research } = finalizedBody();
    expect(body).toContain('参考にした情報');
    const { deps, article, sqlite, db } = await setup({ body, research, images: 1 });
    const calls = fakeNote();
    const out = await saveArticleAsDraft(deps, article.id);
    expect(out.editUrl).toContain('nabc');
    expect(calls.some((u) => u.includes('draft_save'))).toBe(true);
    expect(auditCount(sqlite)).toBe(0);
    const saved = (await db.getArticle(article.id))!;
    expect(saved.state).toBe('drafted');
    expect(saved.body_html).toContain(NOTE_IMG);
    expect(saved.body_html).toContain(`href="${KNOWLEDGE_URL}"`);
  });

  it('正常系: 公開も通る（承認済み・note の画像つき）', async () => {
    const { body, research } = finalizedBody();
    const { deps, article, sqlite } = await setup({ body, research, images: 1 });
    const calls = fakeNote();
    const out = await publishArticle(deps, article.id);
    expect(out.url).toContain('/n/nabc');
    expect(calls.some((u) => /\/v1\/text_notes\/123$/.test(u))).toBe(true);
    expect(auditCount(sqlite)).toBe(0);
  });

  it('★引っかかる系（公開）: note には1回も通信せず、監査ログに残し、確認待ちのまま（承認だけ取り消す）', async () => {
    const { deps, article, sqlite, db } = await setup({ body: `## 見出し\n本文です。 ${EVIL} を見てください。` });
    const calls = fakeNote();
    const err = await publishArticle(deps, article.id).catch((e) => e);
    expect(err).toBeInstanceOf(DisallowedLinksError);
    expect((err as DisallowedLinksError).bad).toEqual([EVIL]);
    expect((err as DisallowedLinksError).userMessage).toContain('想定外のリンク');
    expect((err as DisallowedLinksError).userMessage).toContain('修正する');
    expect((err as DisallowedLinksError).userMessage).not.toContain('evil');   // LINE で押せる形にしない
    expect(calls.filter((u) => u.includes('note.com'))).toEqual([]);
    expect(auditCount(sqlite)).toBe(1);
    const after = (await db.getArticle(article.id))!;
    expect(after.state).toBe('awaiting_approval');   // 公開待ちで固まらない（「修正する」が押せる）
    expect(after.approved_at).toBeNull();
    expect(after.error_code).toBe('disallowed_links');
  });

  it('★引っかかる系（下書き保存）: リンク記法・許可リンクと並んだもの・裸のURLも止める', async () => {
    for (const body of [
      `本文 [押して](https://evil.example.com/x)`,
      `[ご予約](${KNOWLEDGE_URL}) と [こちら](https://evil.example.com/y)`,
      `ふつうの文。\n\n${EVIL}`,
    ]) {
      const { deps, article, db } = await setup({ body });
      const calls = fakeNote();
      await expect(saveArticleAsDraft(deps, article.id)).rejects.toBeInstanceOf(DisallowedLinksError);
      expect(calls.filter((u) => u.includes('note.com'))).toEqual([]);
      expect((await db.getArticle(article.id))!.state).toBe('awaiting_approval');
      vi.restoreAllMocks();
    }
  });

  it('出典は research_json の検査済みのものだけ。保存されていない出典URLは止める', async () => {
    const { body } = finalizedBody();
    const { deps, article } = await setup({ body, images: 1 });   // research_json なし
    fakeNote();
    const err = await saveArticleAsDraft(deps, article.id).catch((e) => e);
    expect(err).toBeInstanceOf(DisallowedLinksError);
    expect((err as DisallowedLinksError).bad).toHaveLength(1);
  });

  it('★古い記事（research_json が NULL・仕上げ前）: 本人のURL（前の版のナレッジ含む）と note の画像だけなら通る', async () => {
    const body = `## 見出し\n予約は ${KNOWLEDGE_URL} から。昔のメニュー ${OLD_KNOWLEDGE_URL} 。キャンペーン ${IDEA_URL}\n\n[画像1]\n\n[ご予約](${KNOWLEDGE_URL})`;
    const { deps, article, db, sqlite } = await setup({ body, images: 1 });
    expect(article.research_json ?? null).toBeNull();
    fakeNote();
    await saveArticleAsDraft(deps, article.id);
    expect((await db.getArticle(article.id))!.state).toBe('drafted');
    expect(auditCount(sqlite)).toBe(0);
  });

  it('★古い記事でも、AI が書いた（本人が書いていない）URL は止める', async () => {
    const body = `## 見出し\n予約は ${KNOWLEDGE_URL} から。参考: https://ai-made.example.org/page`;
    const { deps, article } = await setup({ body });
    fakeNote();
    const err = await saveArticleAsDraft(deps, article.id).catch((e) => e);
    expect((err as DisallowedLinksError).bad).toEqual(['https://ai-made.example.org/page']);
  });

  it('修正指示に本人が書いたURLは許可する', async () => {
    const { deps, article, db } = await setup({ body: `本文 https://fix.example.jp/new` });
    await db.updateArticle(article.id, { revision_instruction: 'リンクを https://fix.example.jp/new に変えて' });
    fakeNote();
    await saveArticleAsDraft(deps, article.id);
    expect((await db.getArticle(article.id))!.state).toBe('drafted');
  });

  it('★Cron（待機中 blocked）で引っかかったら failed に落とし、同じ記事を繰り返し試さない。押した人・担当者・持ち主に知らせる', async () => {
    const { db, sqlite, article } = await setup({ body: `本文 ${EVIL}`, state: 'awaiting_approval' });
    // 持ち主が「公開する」を押した記事（担当者は staff1）
    await db.setState(article.id, 'awaiting_approval', 'blocked', 'line:owner', { reason: 'global_throttle' });
    const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
    const env = { DB: db.raw, KV: kv, LINE_OWNER_USER_ID: 'owner', NOTE_URLNAME: 'test', NOTE_COOKIE: '_note_session_v5=x', LINE_CHANNEL_ACCESS_TOKEN: 't' } as unknown as Env;
    const pushed: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.line.me')) pushed.push(JSON.parse(String((init as RequestInit).body)).to);
      return new Response('{}', { status: 200 });
    });
    await retryBlocked(env);
    expect((await db.getArticle(article.id))!.state).toBe('failed');
    expect(auditCount(sqlite)).toBe(1);
    expect(pushed.sort()).toEqual(['owner', 'staff1']);
    // 次の Cron では拾わない（failed は対象外）
    pushed.length = 0;
    await retryBlocked(env);
    expect(pushed).toEqual([]);
    expect(auditCount(sqlite)).toBe(1);
  });

  it('★agent 経路: 手順書を作らず（仕事を積まず）、状態も変えない。目印 {{imageN_url}} と本人のURLは通る', async () => {
    const ok = await setup({ body: `## 見出し\n[画像1]\n\n予約は ${KNOWLEDGE_URL}`, images: 1 });
    const plan = await buildPlan({ db: ok.db, images: ok.deps.images }, ok.article, 'publish');
    const publish = plan.steps.find((s) => s.id === 'publish')!.json as { free_body: string };
    expect(publish.free_body).toContain('{{image1_url}}');

    const bad = await setup({ body: `## 見出し\n[画像1]\n\n${EVIL}`, images: 1 });
    await expect(buildPlan({ db: bad.db, images: bad.deps.images }, bad.article, 'publish')).rejects.toBeInstanceOf(DisallowedLinksError);

    // 拡張に任せる設定＋端末あり → dispatchPublish でも止まり、仕事が積まれない
    await bad.db.updateTenantSettings(DEFAULT_TENANT_ID, { execution_mode: 'agent' }, 'test');
    bad.sqlite.prepare(`INSERT INTO agent_devices (id, tenant_id, token_hash, last_seen_at, created_at) VALUES ('d1', ?, 'h', ?, ?)`)
      .run(DEFAULT_TENANT_ID, new Date().toISOString(), new Date().toISOString());
    await expect(dispatchPublish(bad.deps, bad.article.id, 'publish')).rejects.toBeInstanceOf(DisallowedLinksError);
    expect((bad.sqlite.prepare('SELECT COUNT(*) AS c FROM agent_jobs').get() as { c: number }).c).toBe(0);
    expect((await bad.db.getArticle(bad.article.id))!.state).toBe('awaiting_approval');
  });

  it('agent 経路の正常系: dispatchPublish が仕事を積む（本人のURL・画像の目印は許可）', async () => {
    const ok = await setup({ body: `## 見出し\n[画像1]\n\n予約は ${KNOWLEDGE_URL}`, images: 1 });
    await ok.db.updateTenantSettings(DEFAULT_TENANT_ID, { execution_mode: 'agent' }, 'test');
    ok.sqlite.prepare(`INSERT INTO agent_devices (id, tenant_id, token_hash, last_seen_at, created_at) VALUES ('d1', ?, 'h', ?, ?)`)
      .run(DEFAULT_TENANT_ID, new Date().toISOString(), new Date().toISOString());
    const out = await dispatchPublish(ok.deps, ok.article.id, 'draft');
    expect(out.mode).toBe('agent');
    expect((await ok.db.getArticle(ok.article.id))!.state).toBe('awaiting_agent');
  });

  it('純関数: 目印は数の分だけ許可。リンクが無ければ許可の一覧を読まない', async () => {
    const html = '<figure><img src="{{image1_url}}"></figure><figure><img src="{{image2_url}}"></figure>';
    expect(findArticleLinkProblems(html, [], 2)).toEqual([]);
    expect(findArticleLinkProblems(html, [], 1)).toEqual(['{{image2_url}}']);
    expect(findArticleLinkProblems('<p><a href="https://a.example/x" onclick="y">a</a></p>',
      buildAllowedLinks({ trustedTexts: ['https://a.example/x'] }))).toEqual(['onclick=']);

    // リンクの無い記事は D1 の許可一覧を読まない（db.raw に触れない）
    const article = { id: 'a', tenant_id: DEFAULT_TENANT_ID, body_md: '## 見出し\n[画像1]\n本文', image_alts_json: null } as unknown as ArticleRow;
    const db = { listImages: async () => [{}], get raw(): never { throw new Error('読んではいけない'); } } as unknown as Db;
    await precheckArticleLinks(db, article, 'publish');
    expect(renderWithPlaceholders(article, 1)).toContain('{{image1_url}}');
  });

  it('知らせる相手: 押した人・担当者・持ち主（重複なし）', () => {
    expect(linkBlockRecipients({ requested_by: 'staff1' }, 'owner', 'staff1')).toEqual(['staff1', 'owner']);
    expect(linkBlockRecipients({ requested_by: null }, 'owner', 'owner')).toEqual(['owner']);
    expect(linkBlockRecipients(null, null, 'u')).toEqual(['u']);
  });
});
