import { describe, expect, it } from 'vitest';
import { formatRevisionWaitMessage } from '../../src/core/generation/estimate';

describe('修正記事の所要時間案内', () => {
  it('各生成ステップが既定の再試行を使い切っても収まる上限を案内する', () => {
    expect(formatRevisionWaitMessage()).toBe('書き直します。最大9分お待ちください。');
  });
});
