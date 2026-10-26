/** サムネイルの作り直し結果と、設定画面の文面。 */
import { textWithActions, type LineMessage } from '../client';
import type { ThumbnailOutcome } from '../../../core/image/thumbnail';
import { MAX_PER_ARTICLE, MAX_GENERATIONS_PER_ARTICLE, DAILY_LIMIT_OPTIONS, type ThumbSettings } from '../../../core/image/thumbnail';

export function buildThumbnailResult(articleId: string, out: ThumbnailOutcome): LineMessage {
  if (out.status === 'created') {
    return textWithActions(
      'サムネイルを作り直しました。\n' +
      '「下書きに保存する」を押すと、note の画面で仕上がりを確認できます。\n' +
      `（1つの記事でサムネを作れるのは、作成${MAX_PER_ARTICLE}回・画像${MAX_GENERATIONS_PER_ARTICLE}枚までです。作り直しを含みます）`,
      [
        { label: 'また作り直す', data: `action=thumb_regen&id=${articleId}` },
        { label: '下書きに保存する', data: `action=savedraft&id=${articleId}` },
      ],
    );
  }
  // ★検品で不合格（rejected）も、もう一度作れる（上限は core 側で守る）
  const retry = (out.status === 'failed' && out.kind !== 'billing' && out.kind !== 'auth' && out.kind !== 'verification')
    || out.status === 'rejected'
    ? [{ label: 'もう一度作る', data: `action=thumb_regen&id=${articleId}` }] : [];
  return textWithActions(out.note, retry);
}

export function buildThumbSettings(s: ThumbSettings, hasKey: boolean): LineMessage {
  return textWithActions(
    'サムネイルの自動生成\n\n' +
    `・キーの登録: ${hasKey ? '済み' : '未登録（登録するまで動きません）'}\n` +
    `・自動生成: ${s.auto ? 'オン' : 'オフ'}\n` +
    `・1日の上限: ${s.dailyLimit}枚\n\n` +
    '※ 画像の費用は、ご自身の OpenAI アカウントにかかります（1枚 約6〜9円の目安）。\n' +
    `※ 1つの記事で作れるのは、作成${MAX_PER_ARTICLE}回・画像${MAX_GENERATIONS_PER_ARTICLE}枚までです（AI の確認での作り直しも枚数に数えます）。`,
    [
      { label: s.auto ? '自動生成をオフにする' : '自動生成をオンにする', data: `action=thumb_auto&on=${s.auto ? 0 : 1}` },
      ...DAILY_LIMIT_OPTIONS.slice(0, 3).map((n) => ({ label: `1日${n}枚まで`, data: `action=thumb_limit&n=${n}` })),
    ],
  );
}
