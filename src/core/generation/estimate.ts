import { DEFAULT_STRUCTURED_MAX_RETRIES } from '../../ports/llm/anthropic';

/** 再試行なしでの標準的な記事生成時間の上限。 */
const BASE_GENERATION_MAX_MINUTES = 3;

/**
 * 修正記事は、各生成ステップが既定の再試行を使い切る場合もある。
 * 通常上限を試行回数ぶんに広げて、実際より短い待ち時間を約束しない。
 */
export function formatRevisionWaitMessage(): string {
  const maxMinutes = BASE_GENERATION_MAX_MINUTES * (DEFAULT_STRUCTURED_MAX_RETRIES + 1);
  return `書き直します。最大${maxMinutes}分お待ちください。`;
}
