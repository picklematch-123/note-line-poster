/**
 * 2026-11 顧客環境で見つかった不具合3つの再現と固定。
 *  1. ★「公開しない」と送ると公開された（先頭一致で「公開」と判定していた・取り消せない）
 *  2. 公開済み記事の「修正」を途中でやめると、記事ごと取りやめ（cancelled）になり一覧から消えた
 *  3. 修正指示の分類が「どれにも当てはまらない」と「分かりませんでした」で止まった
 *  ついで: 書き直し中に古い「公開する」を押したときの返事が分かりにくかった
 * node:sqlite へ全マイグレーションを流して動かす。OpenAI・LINE・note への通信はすべて偽物（本物は呼ばない）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID, type ArticleRow } from '../../src/ports/storage/db';
import {
  isPublishApproval, isDraftRequest, isCancelRequest, isHoldRequest,
} from '../../src/adapters/line/commands';
import {
  revertOrCancel, revertTargetOf, notReadyToPublishMessage, cancelReplyText, REOPEN_REASON,
} from '../../src/core/article/cancel';
import { canTransition, REVERTIBLE_STATES, MUST_ALLOW_CANCEL } from '../../src/core/article/state';
import { generateArticle, reopenPublished, GenerationWithdrawnError, type ServiceDeps } from '../../src/core/article/service';
import { notifyGenerationFailure } from '../../src/workflows/generate-step';
import { signLineBody } from '../../src/adapters/line/signature';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

const ROOT = new URL('../../', import.meta.url).pathname;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach((d) => d.close()); });

function asD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let params: unknown[] = [];
    const api = {
      bind(...v: unknown[]) { params = v; return api; },
      async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
      async run() { const r = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return api;
  } } as unknown as D1Database;
}

function memKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

const KEY = 'sk-openai-test';
const SECRET = 'line-secret';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ORIGINAL_BODY = '元の本文です。\n\n## 見出し1\n公開している版の本文。';

async function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const d1 = asD1(sqlite);
  const db = new Db(d1);
  await db.ensureTenant();
  return { sqlite, d1, db };
}

/** note に公開済みの記事（または下書き保存済み）を作る */
async function noteArticle(db: Db, state: 'published' | 'drafted' = 'published'): Promise<ArticleRow> {
  const a = await db.createArticle(DEFAULT_TENANT_ID, '焼き鳥のネタ', 'owner');
  await db.updateArticle(a.id, {
    state, title: '元のタイトル', body_md: ORIGINAL_BODY, body_html: '<p>元</p>', meta_description: '元の説明',
    hashtags_json: '["元"]', note_id: '123', note_key: 'nkey', note_url: 'https://note.com/x/n/nkey',
    published_at: state === 'published' ? new Date().toISOString() : null,
  });
  return (await db.getArticle(a.id))!;
}

/** 修正の書き直しが終わってプレビューが届いた、という状態まで進める（本文は書き換わっている） */
async function simulateRevision(db: Db, id: string, until: 'generating' | 'preview_ready' | 'awaiting_approval' = 'awaiting_approval') {
  await db.updateArticle(id, { title: '新しいタイトル', body_md: '書き直した本文', meta_description: '新しい説明', revision_instruction: '短くして' });
  await db.setState(id, 'editing', 'generating', 'system');
  if (until === 'generating') return;
  await db.setState(id, 'generating', 'preview_ready', 'system');
  if (until === 'preview_ready') return;
  await db.setState(id, 'preview_ready', 'awaiting_approval', 'system');
}

interface Net { texts: string[]; line: Array<{ url: string; body: string }> }
function mockNet(onResponses: (input: string) => Response): Net {
  const net: Net = { texts: [], line: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u === RESPONSES_URL) {
      const input = String((JSON.parse(String((init as RequestInit).body)) as { input: string }).input);
      net.texts.push(input);
      return onResponses(input);
    }
    if (u.includes('api.line.me')) {
      net.line.push({ url: u, body: String((init as RequestInit).body ?? '') });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`想定外の通信: ${u}`);
  });
  return net;
}

function structured(obj: unknown) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200 });
}

/** 修正指示の分類（軽いモデル）の偽物 */
function classifyAs(action: string) {
  return () => structured({ action, imageIndex: null, secondImageIndex: null, headingIndex: null, instruction: '' });
}

async function postWebhook(env: Record<string, unknown>, events: Array<{ userId: string; data?: string; text?: string }>) {
  const body = JSON.stringify({ events: events.map((e, i) => (e.data
    ? { type: 'postback', replyToken: `rt${i}`, source: { userId: e.userId }, postback: { data: e.data } }
    : { type: 'message', replyToken: `rt${i}`, source: { userId: e.userId }, message: { type: 'text', id: `m${i}`, text: e.text } })) });
  const { handleLineWebhook } = await import('../../src/adapters/line/webhook');
  const pending: Array<Promise<unknown>> = [];
  const res = await handleLineWebhook(new Request('https://x/webhook', {
    method: 'POST', body, headers: { 'x-line-signature': await signLineBody(body, SECRET) },
  }), env as never, { waitUntil: (p) => { pending.push(p); } });
  expect(res.status).toBe(200);
  await Promise.all(pending);
}

function lineEnv(d1: D1Database, create = vi.fn(async () => ({ id: 'wf' }))) {
  return {
    DB: d1, KV: memKv(), LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner',
    LLM_PROVIDER: 'openai', OPENAI_API_KEY: KEY, GENERATE: { create },
  };
}

const replies = (net: Net) => net.line.filter((l) => l.url.includes('/reply')).map((l) => l.body);

// ── 1. 公開の合図 ───────────────────────────────────────────
describe('不具合1: 公開してよいのは、はっきりした承認の言葉だけ', () => {
  it('★否定・保留・長い文は公開の合図ではない', () => {
    for (const t of [
      '公開しない', '投稿しないで', '公開はまだ', '公開しないでください', 'はい、でもタイトル直して',
      '公開は待って', 'まだ公開しないで', 'OKじゃない', '投稿はやめて', '公開する前に■2を直して',
      'はいはい、それより画像を移して', 'ok?でも短くして', '公開NG', 'いいえ', 'やめる',
      // ★疑問形は承認ではない・「お願いします」単独も承認ではない（源蔵レビュー必須1）
      '公開？', 'OK？', 'はい？', 'これ公開？', '公開?', 'ok?', 'お願いします', 'おねがいします', 'お願いします！',
    ]) {
      expect(isPublishApproval(t), t).toBe(false);
    }
  });

  it('承認の言葉は、全角半角・前後の空白・末尾の句点や感嘆符があっても公開の合図', () => {
    for (const t of [
      '公開', '公開する', '公開して', '公開します', '投稿', '投稿する', '投稿して', 'OK', 'ok', 'Ok', 'ＯＫ',
      'はい', ' 公開する ', '公開する。', '公開して！', 'OK!', 'はい。', '公開　する',
    ]) {
      expect(isPublishApproval(t), t).toBe(true);
    }
  });

  it('下書き・やめるも完全一致だけ（「やめないで」で記事を消さない）', () => {
    expect(isDraftRequest('下書きに保存する')).toBe(true);
    expect(isDraftRequest('下書き。')).toBe(true);
    expect(isDraftRequest('下書きにしないで')).toBe(false);
    expect(isDraftRequest('下書きの前に■2を直して')).toBe(false);
    for (const t of ['やめる', 'やめて', 'キャンセル', '中止', '修正をやめる', 'やめます。']) expect(isCancelRequest(t), t).toBe(true);
    // ★「いいえ」はやめるではなく保留（何もしない）
    expect(isCancelRequest('いいえ')).toBe(false);
    expect(isHoldRequest('いいえ')).toBe(true);
    for (const t of ['やめないで', 'いいえ、■2だけ直して', 'キャンセルしないで', 'やめる前にタイトルを変えて']) expect(isCancelRequest(t), t).toBe(false);
  });

  it('「公開しない」「まだ」だけの短い返事は保留として受ける（長い修正指示は保留にしない）', () => {
    for (const t of ['公開しない', '投稿しないで', '公開はまだ', '公開しないでください', 'まだ', '待って', '公開は待って']) {
      expect(isHoldRequest(t), t).toBe(true);
    }
    for (const t of ['公開しないで、タイトルをもっと短くしてほしい', '■2をもっと具体的に', 'はい、でもタイトル直して']) {
      expect(isHoldRequest(t), t).toBe(false);
    }
  });

  it('★webhook: 確認待ちの記事に「公開しない」と送っても、承認も公開もされず、書き直しも起動しない', async () => {
    const { d1, db } = await setup();
    const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', 'owner');
    await db.updateArticle(a.id, { state: 'awaiting_approval', title: 't', body_md: ORIGINAL_BODY });
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const create = vi.fn(async () => ({ id: 'wf' }));
    for (const t of ['公開しない', '投稿しないで', '公開はまだ', '公開しないでください']) {
      await postWebhook(lineEnv(d1, create), [{ userId: 'owner', text: t }]);
    }
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('awaiting_approval');
    expect(after.approved_at).toBeNull();
    expect(after.published_at).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(net.texts).toHaveLength(0);
    expect(replies(net).every((r) => r.includes('公開はしていません'))).toBe(true);
  });

  it('webhook: 「はい、でもタイトル直して」は公開せず、修正指示として扱う', async () => {
    const { d1, db } = await setup();
    const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', 'owner');
    await db.updateArticle(a.id, { state: 'awaiting_approval', title: 't', body_md: ORIGINAL_BODY });
    mockNet(classifyAs('change_title'));
    const create = vi.fn(async () => ({ id: 'wf' }));
    await postWebhook(lineEnv(d1, create), [{ userId: 'owner', text: 'はい、でもタイトル直して' }]);
    const after = (await db.getArticle(a.id))!;
    expect(after.approved_at).toBeNull();
    expect(after.state).toBe('editing');
    expect(after.revision_instruction).toBe('はい、でもタイトル直して');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ── 2. 修正をやめたら元に戻す ─────────────────────────────────
describe('不具合2: note に出た記事の修正をやめても、記事は取りやめにならない', () => {
  it('遷移表: 修正中の各状態から published / drafted へ戻れる。published から出られるのは editing だけ（従来どおり）', () => {
    for (const s of REVERTIBLE_STATES) {
      expect(canTransition(s, 'published'), `${s} -> published`).toBe(true);
      expect(canTransition(s, 'drafted'), `${s} -> drafted`).toBe(true);
    }
    expect(canTransition('received', 'published')).toBe(false);
    expect(canTransition('saving_draft', 'published')).toBe(false);
    expect(canTransition('publishing', 'drafted')).toBe(false);
    for (const s of MUST_ALLOW_CANCEL) expect(canTransition(s, 'cancelled'), s).toBe(true);
  });

  it('戻り先の判定: 記録があれば記録どおり、無ければ公開日時・note のキーから', () => {
    const base = { state: 'awaiting_approval' as const, published_at: null, note_key: null, note_id: null };
    expect(revertTargetOf(base, null)).toBeNull();
    expect(revertTargetOf({ ...base, published_at: 'x', note_key: 'k', note_id: '1' }, null)).toBe('published');
    expect(revertTargetOf({ ...base, note_key: 'k', note_id: '1' }, null)).toBe('drafted');
    expect(revertTargetOf({ ...base, published_at: 'x', note_key: 'k', note_id: '1' }, { from_state: 'drafted' })).toBe('drafted');
    expect(revertTargetOf({ ...base, state: 'received', published_at: 'x', note_key: 'k', note_id: '1' }, null)).toBeNull();
  });

  it('★webhook: 公開済み → 修正する → 書き直し → 「やめる」 で published に戻り、本文も元に戻り、一覧に出る', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db);
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const env = lineEnv(d1);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
    expect((await db.getArticle(a.id))!.state).toBe('editing');
    await simulateRevision(db, a.id);

    await postWebhook(env, [{ userId: 'owner', text: 'やめる' }]);
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('published');
    expect(after.title).toBe('元のタイトル');
    expect(after.body_md).toBe(ORIGINAL_BODY);
    expect(after.meta_description).toBe('元の説明');
    expect(after.revision_instruction).toBeNull();
    expect(after.note_url).toBe('https://note.com/x/n/nkey');
    expect((await db.listRecentArticles(DEFAULT_TENANT_ID)).map((x) => x.id)).toContain(a.id);
    expect(replies(net).at(-1)).toContain('note の記事は前のまま公開されています');
    // もう一度「修正する」から始められる
    expect(canTransition(after.state, 'editing')).toBe(true);
  });

  it('★プレビューの「やめる」ボタン（postback）・生成中の「やめる」でも同じく戻る', async () => {
    const { d1, db } = await setup();
    mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const env = lineEnv(d1);
    for (const until of ['generating', 'preview_ready', 'awaiting_approval'] as const) {
      const a = await noteArticle(db);
      await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
      await simulateRevision(db, a.id, until);
      await postWebhook(env, [{ userId: 'owner', data: `action=cancel&id=${a.id}` }]);
      const after = (await db.getArticle(a.id))!;
      expect(after.state, until).toBe('published');
      expect(after.body_md, until).toBe(ORIGINAL_BODY);
    }
    // 生成中にテキストで「やめる」
    const b = await noteArticle(db);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${b.id}` }]);
    await simulateRevision(db, b.id, 'generating');
    await postWebhook(env, [{ userId: 'owner', text: 'やめる' }]);
    expect((await db.getArticle(b.id))!.state).toBe('published');
  });

  it('修正を始めてすぐ（指示を送る前）にやめても published に戻る', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db);
    mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const env = lineEnv(d1);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
    await postWebhook(env, [{ userId: 'owner', text: 'キャンセル' }]);
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('published');
    expect(after.body_md).toBe(ORIGINAL_BODY);
  });

  it('下書き保存済みの記事も「修正する」で開け（以前は開けなかった）、やめると drafted に戻る', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db, 'drafted');
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const env = lineEnv(d1);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
    expect((await db.getArticle(a.id))!.state).toBe('editing');
    await simulateRevision(db, a.id);
    await postWebhook(env, [{ userId: 'owner', text: 'やめる' }]);
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('drafted');
    expect(after.body_md).toBe(ORIGINAL_BODY);
    expect(replies(net).at(-1)).toContain('note の下書きは前のまま');
  });

  it('★新しく作っている記事は、従来どおり取りやめ（cancelled）になり一覧から消える', async () => {
    const { d1, db } = await setup();
    const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', 'owner');
    await db.updateArticle(a.id, { state: 'awaiting_approval', title: 't', body_md: 'b' });
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    await postWebhook(lineEnv(d1), [{ userId: 'owner', text: 'やめる' }]);
    expect((await db.getArticle(a.id))!.state).toBe('cancelled');
    expect((await db.listRecentArticles(DEFAULT_TENANT_ID)).map((x) => x.id)).not.toContain(a.id);
    expect(replies(net).at(-1)).toContain('この記事は取りやめました');
  });

  it('拡張が仕事を受け取っている（awaiting_agent）ときにやめたら、「前のまま」と断言せず note の確認を促す', async () => {
    const { db } = await setup();
    const a = await noteArticle(db);
    await reopenPublished({ db } as unknown as ServiceDeps, a.id);
    await simulateRevision(db, a.id);
    await db.setState(a.id, 'awaiting_approval', 'awaiting_agent', 'system');
    const out = await revertOrCancel({ db }, a.id, 'line:owner');
    expect(out).toMatchObject({ kind: 'reverted', to: 'published', agentInFlight: true });
    const msg = cancelReplyText(out);
    expect(msg).toContain('note 側の記事をご確認ください');
    expect(msg).not.toContain('前のまま公開されています');
  });

  it('webhook: 確認待ちの記事に「いいえ」と送っても、取りやめにも書き直しにもならない', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db);
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const create = vi.fn(async () => ({ id: 'wf' }));
    const env = lineEnv(d1, create);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
    await simulateRevision(db, a.id);
    await postWebhook(env, [{ userId: 'owner', text: 'いいえ' }]);
    expect((await db.getArticle(a.id))!.state).toBe('awaiting_approval');
    expect(create).not.toHaveBeenCalled();
    expect(replies(net).at(-1)).toContain('公開はしていません');
  });

  it('控えが無い古い記事（この仕組みより前に修正を始めたもの）は、状態だけ戻す', async () => {
    const { db } = await setup();
    const a = await noteArticle(db);
    await db.setState(a.id, 'published', 'editing', 'system'); // 控え無しの古い記録
    await simulateRevision(db, a.id);
    const out = await revertOrCancel({ db }, a.id, 'line:owner');
    expect(out).toMatchObject({ kind: 'reverted', to: 'published', contentRestored: false });
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('published');
    expect(after.body_md).toBe('書き直した本文'); // 戻す元が無いので本文はそのまま
    expect(cancelReplyText(out)).toContain('前のまま公開されています');
  });

  it('控えは「修正を始めたとき」の記録にだけ付く（reopen の記録に本文が残る）', async () => {
    const { db } = await setup();
    const a = await noteArticle(db);
    await reopenPublished({ db } as unknown as ServiceDeps, a.id);
    const ev = await db.getLastExitFromNote(a.id);
    expect(ev?.from_state).toBe('published');
    expect(ev?.to_state).toBe('editing');
    const detail = JSON.parse(ev!.detail_json!) as { reason: string; restore: { body_md: string } };
    expect(detail.reason).toBe(REOPEN_REASON);
    expect(detail.restore.body_md).toBe(ORIGINAL_BODY);
  });

  it('★生成を待つ間に元に戻した記事は、生成が始まっても何もしない（失敗にもしない）', async () => {
    const { db } = await setup();
    const a = await noteArticle(db);
    await reopenPublished({ db } as unknown as ServiceDeps, a.id);
    await db.updateArticle(a.id, { revision_instruction: '短くして' });
    await revertOrCancel({ db }, a.id, 'line:owner');
    mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const deps = { db, llm: { provider: 'openai', openaiKey: KEY } } as unknown as ServiceDeps;
    await expect(generateArticle(deps, a.id)).rejects.toBeInstanceOf(GenerationWithdrawnError);
    expect((await db.getArticle(a.id))!.state).toBe('published');
  });

  it('★生成の最中に元に戻した記事は、届いた生成結果で上書きしない', async () => {
    const { sqlite, db } = await setup();
    const a = await noteArticle(db);
    await reopenPublished({ db } as unknown as ServiceDeps, a.id);
    await db.updateArticle(a.id, { revision_instruction: '短くして' });
    let flipped = false;
    mockNet((input) => {
      // 最初の AI 呼び出しの最中に、利用者が「やめる」を押した
      if (!flipped) {
        flipped = true;
        sqlite.prepare("UPDATE articles SET state = 'published', body_md = ? WHERE id = ?").run(ORIGINAL_BODY, a.id);
      }
      if (input.includes('キーワード設計をしてください')) return structured({ primaryKeyword: '焼き鳥', secondaryKeywords: ['炭火'], searchIntent: 'i', targetReader: 'r', competitorAngle: 'c' });
      const heads = ['見出し1', '見出し2', '見出し3', '見出し4'];
      if (input.includes('記事の構成を作ってください')) return structured({ workingTitle: 'w', leadIntent: 'l', sections: heads.map((h) => ({ heading: h, level: 2, intent: 'x', keywords: [], targetChars: 300, wantsImage: false })) });
      if (input.includes('本文を書いてください')) return structured({ markdown: ['新しい本文。', ...heads.flatMap((h) => [`## ${h}`, '炭火で丁寧に焼きます。'.repeat(4)])].join('\n\n') });
      return structured({ titles: ['新しいタイトル'], leadParagraph: 'l', metaDescription: 'm', hashtags: [], imageAlts: {}, revisedMarkdown: null });
    });
    // 状態は editing（reopen 直後）から始まり、generateArticle が generating へ進める
    const deps = { db, llm: { provider: 'openai', openaiKey: KEY }, images: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as ServiceDeps;
    await expect(generateArticle(deps, a.id)).rejects.toBeInstanceOf(GenerationWithdrawnError);
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('published');
    expect(after.body_md).toBe(ORIGINAL_BODY);
    expect(after.title).toBe('元のタイトル');
  });

  it('★Workflow: 元に戻した記事の生成は、失敗の通知もプレビューも送らずに静かに終わる', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db);
    await reopenPublished({ db } as unknown as ServiceDeps, a.id);
    await revertOrCancel({ db }, a.id, 'line:owner');
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const { GenerateArticleWorkflow } = await import('../../src/workflows/generate-article');
    const env = { DB: d1, KV: memKv(), LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner', LLM_PROVIDER: 'openai', OPENAI_API_KEY: KEY };
    const wf = new (GenerateArticleWorkflow as unknown as new (c: unknown, e: unknown) => {
      run: (ev: unknown, step: unknown) => Promise<void>;
    })({}, env);
    const step = {
      sleep: async () => {},
      do: async (_name: string, x: unknown, y?: unknown) => ((typeof x === 'function' ? x : y) as () => Promise<unknown>)(),
    };
    await wf.run({ payload: { articleId: a.id, lineUserId: 'owner', debounceSec: 0 }, instanceId: 'i1' }, step);
    expect((await db.getArticle(a.id))!.state).toBe('published');
    expect(net.line).toHaveLength(0);
  });

  it('生成が失敗しても、その前に元に戻した記事を「失敗」に落とさない', async () => {
    const { db } = await setup();
    const a = await noteArticle(db);
    const push = vi.fn(async () => {});
    await notifyGenerationFailure({ db, line: { push } as never }, a.id, 'owner', '失敗しました');
    expect((await db.getArticle(a.id))!.state).toBe('published');
    expect(push).not.toHaveBeenCalled();
  });
});

// ── 3. 分類できない修正指示 ─────────────────────────────────
describe('不具合3: 本文の直しは書き直しに分類させ、分類できない文は聞き返す（源蔵レビュー必須2）', () => {
  it('★webhook: 本文を直す指示（分類=regenerate_all）は書き直し（Workflow 起動）に回る', async () => {
    for (const instruction of ['先程追加したナレッジを元に修正', 'ライン公式などのリンクを追加して']) {
      const { d1, db } = await setup();
      const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', 'owner');
      await db.updateArticle(a.id, { state: 'awaiting_approval', title: 't', body_md: ORIGINAL_BODY });
      const net = mockNet(classifyAs('regenerate_all'));
      const create = vi.fn(async () => ({ id: 'wf' }));
      await postWebhook(lineEnv(d1, create), [{ userId: 'owner', text: instruction }]);
      const after = (await db.getArticle(a.id))!;
      expect(after.state).toBe('editing');
      expect(after.revision_instruction).toBe(instruction);
      expect(create).toHaveBeenCalledTimes(1);
      expect(replies(net).join()).not.toContain('分かりませんでした');
      vi.restoreAllMocks();
    }
  });

  it('★webhook: 「ありがとう」「公開されましたか」（分類=unknown）は書き直さず・公開もせず、例文つきで聞き返す（公開ボタンは付けない）', async () => {
    for (const t of ['ありがとう', '公開されましたか', 'うん']) {
      const { d1, db } = await setup();
      const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', 'owner');
      await db.updateArticle(a.id, { state: 'awaiting_approval', title: 't', body_md: ORIGINAL_BODY });
      const net = mockNet(classifyAs('unknown'));
      const create = vi.fn(async () => ({ id: 'wf' }));
      await postWebhook(lineEnv(d1, create), [{ userId: 'owner', text: t }]);
      const after = (await db.getArticle(a.id))!;
      expect(create, t).not.toHaveBeenCalled();
      expect(after.state, t).toBe('awaiting_approval');
      expect(after.approved_at, t).toBeNull();
      expect(after.revision_instruction, t).toBeNull();
      const last = replies(net).at(-1)!;
      expect(last).toContain('分かりませんでした');
      expect(last).toContain('例:');
      expect(last).not.toContain('action=publish');
      expect(last).not.toContain('このまま公開する');
      vi.restoreAllMocks();
    }
  });

  it('分類の指示文に、リンクの追加・ナレッジに合わせる・文体の変更は書き直しだと書いてある', async () => {
    const { classifyRevision } = await import('../../src/core/generation/prompts');
    const p = classifyRevision.user('x', ['h'], 0);
    expect(p).toContain('リンク');
    expect(p).toContain('ナレッジ');
    expect(p).toContain('文体');
  });
});

// ── ついで: 書き直し中の古い「公開する」 ─────────────────────────
describe('ついで: 書き直し中に古い「公開する」を押したら、何が起きているかを伝える', () => {
  it('判定', () => {
    expect(notReadyToPublishMessage('generating')).toContain('いま書き直しています');
    expect(notReadyToPublishMessage('preview_ready')).toContain('届いたプレビューから');
    expect(notReadyToPublishMessage('editing')).toContain('修正中');
    expect(notReadyToPublishMessage('awaiting_approval')).toBeNull();
    expect(notReadyToPublishMessage(undefined)).toBeNull();
  });

  it('webhook: 生成中の記事の「公開する」ボタンは、承認を付けずに案内だけ返す', async () => {
    const { d1, db } = await setup();
    const a = await noteArticle(db);
    const net = mockNet(() => { throw new Error('AI を呼んではいけない'); });
    const env = lineEnv(d1);
    await postWebhook(env, [{ userId: 'owner', data: `action=reopen&id=${a.id}` }]);
    await simulateRevision(db, a.id, 'generating');
    await postWebhook(env, [{ userId: 'owner', data: `action=publish&id=${a.id}` }]);
    const after = (await db.getArticle(a.id))!;
    expect(after.state).toBe('generating');
    expect(after.approved_at).toBeNull();
    expect(replies(net).at(-1)).toContain('いま書き直しています');
  });
});
