/**
 * 「画像のルール」の LINE の文面（AI設定 → 画像のルール。2026-10-26）。
 *
 * ★ルール本文・参考画像は LINE に出さない（登録の有無・文字数・枚数だけ）。
 * ★登録・変更は /setup の画面で行う（長い文章と画像を LINE で扱わないため）。
 *   ボタンは「セットアップ」という文字を送る形にして、ふだんのコマンドと同じ経路（持ち主チェック）を通す。
 */
import type { LineMessage } from '../client';
import { REF_MAX_COUNT, type ImageRulesSummary } from '../../../core/image/rules';

export function buildImageRulesSummary(s: ImageRulesSummary, hasKey: boolean): LineMessage {
  const t = s.thumbnail;
  const lines = [
    '画像のルール',
    '',
    `・サムネ用のルール: ${t.registered && t.chars ? `登録済み（${t.chars}字）` : '未登録'}`,
    `・サムネのタイトル: ${t.titleMode === 'title' ? '記事タイトルを入れる' : '入れない'}`,
    `・確認と作り直し: ${t.registered ? (t.inspectRetries === 0 ? '作り直さない' : `${t.inspectRetries}回まで`) : '確認しない（今までどおり）'}`,
    `・文中の画像用のルール: ${s.inline.registered && s.inline.chars ? `登録済み（${s.inline.chars}字）` : '未登録'}`,
    `・参考画像: ${s.refs.length} / ${REF_MAX_COUNT} 枚`,
    '',
    '登録・変更は設定画面で行います。下の「設定画面を開く」を押すと、画面で使う確認コードが届きます。',
  ];
  if (!hasKey) lines.push('', '※ OpenAI の API キーが未登録のため、いまは画像を作りません。');
  return {
    type: 'text',
    text: lines.join('\n'),
    quickReply: {
      items: [{ type: 'action', action: { type: 'message', label: '設定画面を開く', text: 'セットアップ' } }],
    },
  };
}
