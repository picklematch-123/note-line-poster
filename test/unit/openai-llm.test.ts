import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAiLlm, DEFAULT_CANDIDATES, parseCandidates, ensureJsonWord } from '../../src/ports/llm/openai';
import { createLlm, chooseProvider } from '../../src/ports/llm';
import { LlmError } from '../../src/ports/llm/types';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const Schema = z.object({ ok: z.boolean() });
const opts = (tier: 'heavy' | 'light' = 'heavy') => ({ tier, system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });

function okBody(obj: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  }), { status: 200 });
}
const err = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('OpenAI 文章モデルの窓口', () => {
  it('正しい形で呼び、JSON を検証して返す（使用量も数える）', async () => {
    let sent: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent = JSON.parse(String((init as RequestInit).body)); return okBody({ ok: true });
    });
    const r = await new OpenAiLlm('sk-test').structured(opts());
    expect(r.data).toEqual({ ok: true });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(sent.model).toBe(DEFAULT_CANDIDATES.heavy[0]);
    expect(String(sent.instructions)).toContain('JSON');
    // ★考える分を出力の上限に数えるモデルがあるので、上限に余裕を足している
    expect(sent.max_output_tokens as number).toBeGreaterThan(100);
  });

  it('★使えないモデルは飛ばして次の候補を使う。使えたものは覚えて、次回は最初から使う', async () => {
    const tried: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const m = JSON.parse(String((init as RequestInit).body)).model as string;
      tried.push(m);
      if (m === 'a1') return err(404, { error: { code: 'model_not_found', message: 'The model a1 does not exist' } });
      return okBody({ ok: true });
    });
    const llm = new OpenAiLlm('sk-test', { heavy: ['a1', 'a2'] });
    await llm.structured(opts());
    await llm.structured(opts());
    expect(tried).toEqual(['a1', 'a2', 'a2']);
  });

  it('★どの候補も使えなければ、日本語で運用側への連絡を案内する', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => err(404, { error: { message: 'model not found' } }));
    const e = await new OpenAiLlm('sk-test', { heavy: ['a1', 'a2'] }).structured(opts()).catch((x) => x as LlmError);
    expect(e.kind).toBe('model_unavailable');
    expect(e.userMessage).toContain('候補も使えない');
    expect(e.userMessage).toContain('書きかけの内容は残っています');
  });

  it('★残高不足は次の候補へ進まず、チャージ先を案内する', async () => {
    const calls = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => err(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }));
    const e = await new OpenAiLlm('sk-test').structured(opts()).catch((x) => x as LlmError);
    expect(e.kind).toBe('billing');
    expect(e.userMessage).toContain('platform.openai.com');
    expect(e.userMessage).toContain('書きかけの内容は残っています');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('キー不正は待っても直らないので再試行しない', async () => {
    const calls = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => err(401, { error: { message: 'bad key' } }));
    const e = await new OpenAiLlm('sk-test').structured(opts()).catch((x) => x as LlmError);
    expect(e.kind).toBe('auth');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('一時エラー(混雑)は待って再試行し、直れば成功する', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (n++ === 0 ? err(429, { error: { message: 'rate limit' } }) : okBody({ ok: true })));
    const p = new OpenAiLlm('sk-test').structured(opts());
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).data).toEqual({ ok: true });
  });

  it('出力が不正なら、指摘つきで再試行する（上限あり）', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      bodies.push(String((init as RequestInit).body));
      return bodies.length < 2 ? okBody({ wrong: 1 }) : okBody({ ok: true });
    });
    const r = await new OpenAiLlm('sk-test').structured(opts());
    expect(r.data).toEqual({ ok: true });
    expect(bodies[1]).toContain('前回の出力が不正でした');
  });

  it('途中で切れた出力は、不正として再試行の対象になる', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (n++ === 0
      ? new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok": tr' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
      : okBody({ ok: true })));
    expect((await new OpenAiLlm('sk-test').structured(opts())).data).toEqual({ ok: true });
  });

  it('キーの形が違えば作れない。候補は環境変数で上書きできる', () => {
    expect(() => new OpenAiLlm('')).toThrow(LlmError);
    expect(parseCandidates(' x1 , x2,, ')).toEqual(['x1', 'x2']);
    expect(parseCandidates('')).toBeUndefined();
  });
});

describe('どの提供元を使うか', () => {
  it('★Claude のキーがある既存の環境は、勝手に切り替わらない', () => {
    expect(chooseProvider({ anthropicKey: 'sk-ant-x', openaiKey: 'sk-x' })).toBe('anthropic');
  });
  it('OpenAI のキーだけの新しい環境は OpenAI', () => {
    expect(chooseProvider({ openaiKey: 'sk-x' })).toBe('openai');
  });
  it('LLM_PROVIDER で明示すれば従う（キーが無ければ使えない扱い）', () => {
    expect(chooseProvider({ provider: 'openai', anthropicKey: 'sk-ant-x', openaiKey: 'sk-x' })).toBe('openai');
    expect(chooseProvider({ provider: 'openai', anthropicKey: 'sk-ant-x' })).toBeNull();
  });
  it('どちらのキーも無ければ、OpenAI のキー登録を案内する', () => {
    let e: LlmError | undefined;
    try { createLlm({}); } catch (x) { e = x as LlmError; }
    expect(e?.userMessage).toContain('OPENAI_API_KEY');
  });
});

describe('OpenAI 向けの書き方の補足', () => {
  it('★構成・本文・仕上げにだけ足し、分類やナレッジ整理には足さない', async () => {
    const sent: Record<string, string> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const b = JSON.parse(String((init as RequestInit).body));
      sent[b.instructions.includes('書き方の補足') ? 'with' : 'without'] = b.instructions; return okBody({ ok: true });
    });
    const llm = new OpenAiLlm('sk-test');
    for (const label of ['構成作成', '本文執筆', 'SEO仕上げ']) await llm.structured({ ...opts(), label });
    expect(sent.with).toContain('表は使わない');
    expect(sent.with).toContain('記事自身についての断り書き');
    delete sent.with;
    for (const label of ['修正指示の分類', 'ナレッジの整理', 'キーワード分析', 'サムネの指示文']) await llm.structured({ ...opts(), label });
    expect(sent.with).toBeUndefined();
  });
});


describe('入力に json の語を必ず含める（OpenAI の json_object の条件）', () => {
  it('★ユーザー文に JSON と書かれていなくても、窓口が足す（実機で 400 になった実例）', async () => {
    let sent = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => { sent = JSON.parse(String((init as RequestInit).body)).input; return okBody({ ok: true }); });
    await new OpenAiLlm('sk-test').structured({ ...opts(), user: '見出しと本文から、画像の指示文を作ってください。' });
    expect(/json/i.test(sent)).toBe(true);
  });
  it('すでに書かれているときは足さない', () => {
    expect(ensureJsonWord('JSON で出力してください')).toBe('JSON で出力してください');
    expect(ensureJsonWord('出力は json で')).toBe('出力は json で');
  });
});


describe('保存しない指定（store: false）', () => {
  it('★文章の呼び出しは、OpenAI 側に応答を保存させない指定で送る', async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => { body = JSON.parse(String((init as RequestInit).body)); return okBody({ ok: true }); });
    await new OpenAiLlm('sk-test').structured(opts());
    expect(body.store).toBe(false);
  });
});
