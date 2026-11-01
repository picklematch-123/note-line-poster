/**
 * セットアップで点検する値（scripts/setup-vars.mjs）と、/health の「足りないもの」の言い方を固定する。
 *
 * P4-1（2026-10）: 顧客が用意する外部キーは OpenAI の1つだけ。Claude は既存環境のための任意項目。
 * ★文章の提供元の決め方（chooseProvider）は変えていないことも、ここで確かめる。
 */
import { describe, it, expect } from 'vitest';
import {
  VARS, OPENAI_KEY_GUIDE, validateOpenAiKey, validateAnthropicKey,
  validateAnthropicWorkspaceId, validateLlmProvider, isHealthyCheck,
} from '../../scripts/setup-vars.mjs';
import { chooseProvider, describeMissingLlm } from '../../src/ports/llm';

const byKey = (k: string) => VARS.find((v: { key: string }) => v.key === k);

describe('セットアップで点検する値', () => {
  it('★OpenAI のキーは必須、Claude 系はすべて任意', () => {
    expect(byKey('OPENAI_API_KEY')?.required).toBe(true);
    expect(byKey('ANTHROPIC_API_KEY')?.required).toBe(false);
    expect(byKey('ANTHROPIC_WORKSPACE_ID')?.required).toBe(false);
    expect(byKey('LLM_PROVIDER')?.required).toBe(false);
  });

  it('必須の外部キーは LINE 2つと OpenAI だけ（暗号鍵は自動生成）', () => {
    const required = VARS.filter((v: { required: boolean; generate?: boolean }) => v.required && !v.generate)
      .map((v: { key: string }) => v.key);
    expect(required).toEqual(['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OPENAI_API_KEY']);
  });

  it('OpenAI のキーの形を見る（空は「未設定」として別に扱うので通す）', () => {
    expect(validateOpenAiKey('')).toBeNull();
    expect(validateOpenAiKey('sk-proj-abcdefghijklmnopqrstu')).toBeNull();
    expect(validateOpenAiKey('sk-abcdefghijklmnopqrstuvwx')).toBeNull();
    expect(validateOpenAiKey('abc-abcdefghijklmnopqrstu')).toMatch(/sk-/);
    expect(validateOpenAiKey('sk-short')).toMatch(/短すぎ/);
    expect(validateOpenAiKey('sk-proj-abcdefghij klmnopqrstu')).toMatch(/空白/);
    // ★Claude のキーを OpenAI の欄に貼る取り違え
    expect(validateOpenAiKey('sk-ant-' + 'api03-abcdefghijklmnopqrstu')).toMatch(/Claude/);
  });

  it('Claude 系の形は、値が入っているときだけ見る', () => {
    expect(validateAnthropicKey('')).toBeNull();
    expect(validateAnthropicKey('sk-ant-api03-x')).toBeNull();
    expect(validateAnthropicKey('sk-proj-x')).toMatch(/sk-ant-/);
    expect(validateAnthropicWorkspaceId('')).toBeNull();
    expect(validateAnthropicWorkspaceId('wrkspc_01abc')).toBeNull();
    expect(validateAnthropicWorkspaceId('01abc')).toMatch(/wrkspc_/);
  });

  it('LLM_PROVIDER は openai / anthropic / 空 だけ', () => {
    for (const v of ['', 'openai', 'anthropic', ' OpenAI ']) expect(validateLlmProvider(v)).toBeNull();
    expect(validateLlmProvider('claude')).toMatch(/openai か anthropic/);
  });

  it('OpenAI の案内に、前払い・自動チャージはオフ・組織認証・費用の目安が入っている', () => {
    expect(OPENAI_KEY_GUIDE).toMatch(/前払い/);
    expect(OPENAI_KEY_GUIDE).toMatch(/最低5ドル/);
    expect(OPENAI_KEY_GUIDE).toMatch(/自動チャージ.*オフ/);
    expect(OPENAI_KEY_GUIDE).toMatch(/組織の認証/);
    expect(OPENAI_KEY_GUIDE).toMatch(/約20〜30円/);
  });
});

describe('/health の読み方（setup が「足りないものがある」と誤表示しない）', () => {
  it('llm は提供元の名前、thumbnail は enabled/disabled で正常', () => {
    expect(isHealthyCheck('llm', 'openai')).toBe(true);
    expect(isHealthyCheck('llm', 'anthropic')).toBe(true);
    expect(isHealthyCheck('llm', 'none（OPENAI_API_KEY が未登録）')).toBe(false);
    expect(isHealthyCheck('thumbnail', 'enabled')).toBe(true);
    expect(isHealthyCheck('thumbnail', 'disabled（OPENAI_API_KEY 未登録）')).toBe(true);
    expect(isHealthyCheck('db', 'ok')).toBe(true);
    expect(isHealthyCheck('db', 'no such table')).toBe(false);
    expect(isHealthyCheck('execution_mode', 'server')).toBe(true);
  });

  it('★提供元が決まらない理由を、場合ごとに書き分ける', () => {
    expect(describeMissingLlm({})).toMatch(/OPENAI_API_KEY が未登録/);
    expect(describeMissingLlm({})).toMatch(/変数とシークレット/);
    expect(describeMissingLlm({ provider: 'anthropic', openaiKey: 'sk-x' })).toMatch(/ANTHROPIC_API_KEY が未登録/);
    expect(describeMissingLlm({ provider: 'openai', anthropicKey: 'sk-ant-x' })).toMatch(/LLM_PROVIDER=openai/);
    for (const c of [{}, { provider: 'anthropic' }, { provider: 'openai' }]) {
      expect(describeMissingLlm(c).startsWith('none')).toBe(true);
    }
  });

  it('★選び方は今までどおり（明示 > Claude のキー > OpenAI）', () => {
    expect(chooseProvider({ anthropicKey: 'sk-ant-x', openaiKey: 'sk-x' })).toBe('anthropic');
    expect(chooseProvider({ openaiKey: 'sk-x' })).toBe('openai');
    expect(chooseProvider({ provider: 'openai', anthropicKey: 'sk-ant-x', openaiKey: 'sk-x' })).toBe('openai');
    expect(chooseProvider({ provider: 'anthropic', openaiKey: 'sk-x' })).toBeNull();
    expect(chooseProvider({})).toBeNull();
  });
});
