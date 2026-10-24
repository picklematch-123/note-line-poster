/**
 * 使う LLM を決める入口。呼び出し側は「Llm」しか知らない。
 *
 * 選び方（既存の環境を勝手に切り替えない）:
 *   LLM_PROVIDER が 'openai' / 'anthropic' ならそれに従う。
 *   未指定なら、Claude のキーがある環境は Claude のまま（今まで通り）、
 *   無ければ OpenAI（新しく配る環境は OpenAI のキーだけで動く）。
 */
import { AnthropicLlm } from './anthropic';
import { OpenAiLlm, parseCandidates } from './openai';
import { LlmError, type Llm } from './types';

export interface LlmConfig {
  provider?: string | null;
  openaiKey?: string | null;
  openaiModelHeavy?: string | null;
  openaiModelLight?: string | null;
  anthropicKey?: string | null;
  anthropicWorkspaceId?: string | null;
}

export type Provider = 'openai' | 'anthropic';

export function chooseProvider(cfg: LlmConfig): Provider | null {
  const p = cfg.provider?.trim().toLowerCase();
  if (p === 'openai') return cfg.openaiKey ? 'openai' : null;
  if (p === 'anthropic') return cfg.anthropicKey ? 'anthropic' : null;
  if (cfg.anthropicKey) return 'anthropic';
  if (cfg.openaiKey) return 'openai';
  return null;
}

/**
 * 文章の提供元が決まらないとき、何が足りないかを人が読める形で返す（/health 用。秘密は出さない）。
 * ★chooseProvider の決め方は変えない。ここは「なぜ決まらなかったか」の説明だけ。
 *   LLM_PROVIDER=anthropic なのに Claude のキーが無い場合に「OpenAI のキーが無い」と出すと、
 *   見当違いの場所を探させてしまうため、場合を分けて書く。
 */
export function describeMissingLlm(cfg: LlmConfig): string {
  const p = cfg.provider?.trim().toLowerCase();
  const where = 'Cloudflare の画面 → Worker → 設定 → 変数とシークレット で登録';
  if (p === 'anthropic' && !cfg.anthropicKey) {
    return `none（LLM_PROVIDER=anthropic ですが ANTHROPIC_API_KEY が未登録。OpenAI で書くなら LLM_PROVIDER を消すか openai に）`;
  }
  if (p === 'openai' && !cfg.openaiKey) return `none（LLM_PROVIDER=openai ですが OPENAI_API_KEY が未登録。${where}）`;
  return `none（OPENAI_API_KEY が未登録。${where}）`;
}

export function createLlm(cfg: LlmConfig): Llm {
  const provider = chooseProvider(cfg);
  if (provider === 'openai') {
    return new OpenAiLlm(cfg.openaiKey!, {
      heavy: parseCandidates(cfg.openaiModelHeavy),
      light: parseCandidates(cfg.openaiModelLight),
    });
  }
  if (provider === 'anthropic') return new AnthropicLlm(cfg.anthropicKey!, cfg.anthropicWorkspaceId);
  throw new LlmError('LLM のキーが未設定', 'OpenAI の API キーが登録されていません。Cloudflare の画面で OPENAI_API_KEY を登録してください。', false, undefined, 'auth');
}

/** Worker の環境変数から設定を作る */
export function llmConfigFromEnv(env: {
  LLM_PROVIDER?: string; OPENAI_API_KEY?: string; OPENAI_MODEL_HEAVY?: string; OPENAI_MODEL_LIGHT?: string;
  ANTHROPIC_API_KEY?: string; ANTHROPIC_WORKSPACE_ID?: string;
}): LlmConfig {
  return {
    provider: env.LLM_PROVIDER,
    openaiKey: env.OPENAI_API_KEY,
    openaiModelHeavy: env.OPENAI_MODEL_HEAVY,
    openaiModelLight: env.OPENAI_MODEL_LIGHT,
    anthropicKey: env.ANTHROPIC_API_KEY,
    anthropicWorkspaceId: env.ANTHROPIC_WORKSPACE_ID,
  };
}

/**
 * Webリサーチの窓口を作る。OpenAI のキーが無ければ null（＝調査の機能そのものを出さない）。
 *
 * ★文章の提供元（Claude / OpenAI）とは別に決める。Claude のまま動いている環境でも、
 *   サムネのために OpenAI のキーを足していれば調査は使える（調査は OpenAI にしかない機能のため）。
 */
export function createResearchLlm(env: { OPENAI_API_KEY?: string; OPENAI_MODEL_RESEARCH?: string }): OpenAiLlm | null {
  if (!env.OPENAI_API_KEY?.startsWith('sk-')) return null;
  return new OpenAiLlm(env.OPENAI_API_KEY, { research: parseCandidates(env.OPENAI_MODEL_RESEARCH) });
}
