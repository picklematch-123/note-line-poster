/**
 * 「記事を生成する」が固まっても、記事を「生成中」のまま止めない（★2026-10-24 源蔵 再レビュー「後でよい」）。
 *  (1) 文章の通信に時間切れ（kind='timeout'・recoverable・再試行の上限内でやり直す）
 *  (2) step そのものが落ちても「失敗を通知する」へ進む
 * 通信はすべて偽物。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAiLlm, TEXT_TIMEOUT_MS } from '../../src/ports/llm/openai';
import { AnthropicLlm, CLAUDE_TIMEOUT_MS } from '../../src/ports/llm/anthropic';
import { LlmError } from '../../src/ports/llm/types';
import { runGenerationStep, notifyGenerationFailure, STEP_STOPPED_MESSAGE } from '../../src/workflows/generate-step';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } },
}));

const ROOT = new URL('../../', import.meta.url).pathname;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const Schema = z.object({ ok: z.boolean() });
const opts = { tier: 'heavy' as const, system: 's', user: 'u', schema: Schema, maxTokens: 100, label: '本文執筆' };

/** 応答が返ってこない相手（時間切れの合図でだけ終わる） */
function hang(init: RequestInit | undefined): Promise<Response> {
  const signal = init?.signal as AbortSignal;
  return new Promise<Response>((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
}

const openAiOk = () => new Response(JSON.stringify({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200 });

describe('(1) 文章の通信の時間切れ', () => {
  it('目安は 180 秒（OpenAI・Claude とも）', () => {
    expect(TEXT_TIMEOUT_MS).toBe(180_000);
    expect(CLAUDE_TIMEOUT_MS).toBe(180_000);
  });

  it('★OpenAI: 応答が返らなければ打ち切り、kind=timeout・recoverable の LlmError（日本語）を投げる', async () => {
    let signalSeen = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => { signalSeen = Boolean(init?.signal); return hang(init); });
    const err = await new OpenAiLlm('sk-test', { textTimeoutMs: 20 }).structured({ ...opts, maxRetries: 0 }).catch((e) => e);
    expect(signalSeen).toBe(true);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('timeout');
    expect((err as LlmError).recoverable).toBe(true);
    expect((err as LlmError).userMessage).toContain('時間がかかりすぎた');
  });

  it('★OpenAI: 時間切れは再試行の上限内でやり直し、2回目で返れば成功する（候補は切り替えない）', async () => {
    const models: string[] = [];
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return n++ === 0 ? hang(init) : openAiOk();
    });
    const r = await new OpenAiLlm('sk-test', { textTimeoutMs: 20, heavy: ['m1', 'm2'] }).structured({ ...opts, maxRetries: 1 });
    expect(r.data).toEqual({ ok: true });
    expect(models).toEqual(['m1', 'm1']);
  }, 10_000);

  it('★OpenAI: 時間切れが上限を超えて続いたら、それ以上は呼ばない（回数が増え続けない）', async () => {
    const calls = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => hang(init));
    await expect(new OpenAiLlm('sk-test', { textTimeoutMs: 10 }).structured({ ...opts, maxRetries: 1 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('★Claude: 同じく打ち切って kind=timeout・recoverable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => hang(init));
    const err = await new AnthropicLlm('sk-ant-test', null, 20).structured({ ...opts, maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('timeout');
    expect((err as LlmError).recoverable).toBe(true);
    expect((err as LlmError).userMessage).toContain('時間がかかりすぎた');
  });
});

describe('(2) step そのものが落ちても「失敗を通知する」へ進む', () => {
  it('runGenerationStep: step が例外で落ちたら、外へ出さずに失敗として返す。成功はそのまま返す', async () => {
    const out = await runGenerationStep(async () => { throw new Error('step timed out after 10 minutes'); });
    expect(out).toEqual({ ok: false, userMessage: STEP_STOPPED_MESSAGE });
    expect(await runGenerationStep(async () => ({ ok: true as const, title: 'T' }))).toEqual({ ok: true, title: 'T' });
  });

  it('notifyGenerationFailure: failed に落とし、LINE に日本語で次の一手まで知らせる', async () => {
    const markFailed = vi.fn(async () => {});
    const push = vi.fn(async () => {});
    await notifyGenerationFailure({ db: { markFailed }, line: { push } }, 'a1', 'u1', STEP_STOPPED_MESSAGE);
    expect(markFailed).toHaveBeenCalledWith('a1', 'system', { reason: STEP_STOPPED_MESSAGE });
    const [to, messages] = push.mock.calls[0] as unknown as [string, Array<{ text: string }>];
    expect(to).toBe('u1');
    expect(messages[0].text).toContain('途中で止まりました');
    expect(messages[0].text).toContain('指示をそのまま送ってください');
  });

  it('★Workflow を実際に動かす: 「記事を生成する」が落ちても、別の step で failed にして LINE に知らせる', async () => {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
    }
    const d1 = { prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...v: unknown[]) { params = v; return api; },
        async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
        async run() { const r = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
      };
      return api;
    } } as unknown as D1Database;
    const db = new Db(d1);
    await db.ensureTenant();
    const article = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ');
    await db.setState(article.id, 'received', 'generating', 'system');   // 1回目の生成が途中まで進んでいた

    const pushed: Array<{ to: string; text: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.line.me')) {
        const b = JSON.parse(String(init?.body));
        pushed.push({ to: b.to, text: b.messages[0].text });
      }
      return new Response('{}', { status: 200 });
    });

    const { GenerateArticleWorkflow } = await import('../../src/workflows/generate-article');
    const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
    const env = { DB: d1, KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'owner' };
    const wf = new (GenerateArticleWorkflow as unknown as new (c: unknown, e: unknown) => {
      run: (ev: unknown, step: unknown) => Promise<void>;
    })({}, env);
    const done: string[] = [];
    const step = {
      sleep: async () => {},
      do: async (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
        // 「記事を生成する」は step ごと時間切れで落ちる（やり直しも同じく固まった状態）
        if (name === '記事を生成する') throw new Error('WorkflowTimeoutError: step timed out');
        done.push(name);
        return fn();
      },
    };
    await wf.run({ payload: { articleId: article.id, lineUserId: 'u1', debounceSec: 0 } }, step);

    expect(done).toContain('失敗を通知する');
    expect(done).not.toContain('プレビューを送る');
    expect((await db.getArticle(article.id))!.state).toBe('failed');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].to).toBe('u1');
    expect(pushed[0].text).toContain('途中で止まりました');
    sqlite.close();
  });
});
