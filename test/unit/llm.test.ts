import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { AnthropicLlm, LlmError, extractJson } from '../../src/ports/llm/anthropic';

const KEY = 'sk-ant-test-key';
const Schema = z.object({ ok: z.boolean() });

/** Claude API のレスポンスを模したもの。 */
function okResponse(body: unknown) {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200 });
}

function errResponse(status: number, body = '{"error":{"type":"x","message":"y"}}') {
  return new Response(body, { status });
}

afterEach(() => vi.restoreAllMocks());

describe('ワークスペースIDの扱い', () => {
  // 2026-08-30 実地で発生:
  //   .dev.vars に「wrkspc_」を付け忘れた値を入れていたため、Claude が
  //   400「anthropic-workspace-id header must be a valid workspace ID」を返し、
  //   アプリは「ワークスペースIDの設定が必要です」と案内した。
  //   ★設定はされていた。値の形が違っただけ。案内が原因を隠していた。

  it('正しい形なら、そのままヘッダに載せる', async () => {
    let sent: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent = new Headers((init as RequestInit).headers);
      return okResponse({ ok: true });
    });

    await new AnthropicLlm(KEY, 'wrkspc_01ABC').structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
    expect(sent!.get('anthropic-workspace-id')).toBe('wrkspc_01ABC');
  });

  it('★形が違うIDは送らない（送ると必ず失敗するため）', async () => {
    let sent: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent = new Headers((init as RequestInit).headers);
      return okResponse({ ok: true });
    });

    // wrkspc_ が抜けている＝実地で起きた形
    await new AnthropicLlm(KEY, '01NkFodsrFE3').structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
    expect(sent!.has('anthropic-workspace-id')).toBe(false);
  });

  it('空欄や空白だけなら送らない', async () => {
    let sent: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent = new Headers((init as RequestInit).headers);
      return okResponse({ ok: true });
    });
    await new AnthropicLlm(KEY, '   ').structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
    expect(sent!.has('anthropic-workspace-id')).toBe(false);
  });

  it('★残高不足のときは、チャージ先まで案内する', async () => {
    // 「不足しています」だけだと、顧客はどこで何をすればいいか分からない
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      errResponse(400, '{"error":{"message":"credit balance is too low"}}'));
    try {
      await new AnthropicLlm(KEY).structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
      throw new Error('ここには来ないはず');
    } catch (e) {
      const msg = (e as LlmError).userMessage;
      expect(msg).toContain('platform.claude.com/settings/billing');
      expect(msg).toContain('5ドル');
      expect(msg).toContain('書きかけの内容は残っています');
    }
  });

  it('★IDを送っていないときの案内は、どこで登録するかまで書く', async () => {
    // 配備画面に入力欄が無いので、「必要です」だけだと顧客が詰む
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      errResponse(400, '{"error":{"message":"workspace required"}}'));
    try {
      await new AnthropicLlm(KEY).structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
      throw new Error('ここには来ないはず');
    } catch (e) {
      const msg = (e as LlmError).userMessage;
      expect(msg).toContain('ANTHROPIC_WORKSPACE_ID');
      expect(msg).toContain('変数とシークレット');
      expect(msg).toContain('ターミナルは不要');
    }
  });

  it('★IDを送ったうえで断られたら、「未設定」ではなく「値が違う」と伝える', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      errResponse(400, '{"error":{"message":"anthropic-workspace-id header must be a valid workspace ID."}}'));

    try {
      await new AnthropicLlm(KEY, 'wrkspc_01ABC').structured({ tier: 'fast', system: 's', user: 'u', schema: Schema, maxTokens: 100, label: 'テスト' });
      throw new Error('ここには来ないはず');
    } catch (e) {
      const msg = (e as LlmError).userMessage;
      expect(msg).toContain('登録されているワークスペースID');
      expect(msg).not.toContain('設定が必要です');
    }
  });
});

describe('AnthropicLlm — キーの検証', () => {
  it('sk-ant- で始まらないキーは即座に拒否する', () => {
    expect(() => new AnthropicLlm('wrong-key')).toThrow(LlmError);
    try {
      new AnthropicLlm('wrong-key');
    } catch (e) {
      expect((e as LlmError).userMessage).toContain('sk-ant-');
      expect((e as LlmError).recoverable).toBe(false);
    }
  });
});

describe('AnthropicLlm — ワークスペースID', () => {
  it('指定があればヘッダに載せる', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({ ok: true }));
    await new AnthropicLlm(KEY, 'wrkspc_123').structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['anthropic-workspace-id']).toBe('wrkspc_123');
  });

  it('指定がなければヘッダを付けない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({ ok: true }));
    await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['anthropic-workspace-id']).toBeUndefined();
  });
});

describe('AnthropicLlm — エラーの振り分け', () => {
  it('401 はキー不正として、待っても直らない扱いにする', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => errResponse(401));
    const llm = new AnthropicLlm(KEY);
    await expect(llm.structured({ tier: 'light', system: 's', user: 'u', schema: Schema, label: 'T' }))
      .rejects.toMatchObject({ recoverable: false, status: 401 });
  });

  it('残高不足は原因が分かる文言にする', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => errResponse(400, '{"error":{"message":"credit balance is too low"}}'));
    try {
      await new AnthropicLlm(KEY).structured({ tier: 'light', system: 's', user: 'u', schema: Schema, label: 'T' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      expect((e as LlmError).userMessage).toContain('残高');
      expect((e as LlmError).recoverable).toBe(false);
    }
  });

  it('ワークスペース未指定は直し方を案内する（BYOK で最も多い躓き）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => errResponse(400, '{"error":{"message":"anthropic-workspace-id is required"}}'));
    try {
      await new AnthropicLlm(KEY).structured({ tier: 'light', system: 's', user: 'u', schema: Schema, label: 'T' });
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).userMessage).toContain('Workspaces');
    }
  });
});

describe('AnthropicLlm — ★一時エラーの自動再試行', () => {
  it('混雑(429)のあと成功すれば、記事作成は失敗させない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    vi.spyOn(globalThis, 'setTimeout' as never).mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

    const result = await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('一時障害(500)も再試行する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    vi.spyOn(globalThis, 'setTimeout' as never).mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

    const result = await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('★キー不正は待っても直らないので再試行しない（無駄な待ちを作らない）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => errResponse(401));
    await expect(new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    })).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicLlm — 出力の検証', () => {
  it('既定では不正な出力を2回まで作り直し、3回目の成功を返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResponse({ wrong: 'shape' }))
      .mockResolvedValueOnce(okResponse({ wrong: 'shape' }))
      .mockResolvedValueOnce(okResponse({ ok: true }));

    const result = await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('スキーマに合わない出力は作り直させる', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResponse({ wrong: 'shape' }))
      .mockResolvedValueOnce(okResponse({ ok: true }));

    const result = await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('使用トークンを積み上げて返す（コスト把握のため）', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResponse({ wrong: 'shape' }))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    const result = await new AnthropicLlm(KEY).structured({
      tier: 'light', system: 's', user: 'u', schema: Schema, label: 'テスト',
    });
    // 2回呼んだので 10x2 / 5x2
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
  });
});

describe('extractJson', () => {
  it('素の JSON を読む', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('コードフェンス付きでも読む', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('前置きが付いていても読む', () => {
    expect(extractJson('はい:\n{"a":1}')).toEqual({ a: 1 });
  });
  it('壊れていれば null', () => {
    expect(extractJson('{"a":')).toBeNull();
    expect(extractJson('ただの文章')).toBeNull();
  });
});
