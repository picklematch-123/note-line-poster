/**
 * 文中画像（P3）の LINE の文面。AI設定の選択画面と、作り直しの結果。
 * ★プレビューへの表示は preview.ts の中（既存の Flex メッセージの中に載せる＝LINE の通数を増やさない）。
 * ★画像そのものは LINE に送らない。見たいときは「下書きに保存する」で note の画面で確認する（サムネと同じ導線）。
 */
import { textWithActions, type LineMessage } from '../client';
import {
  COUNT_OPTIONS, DAILY_LIMIT_OPTIONS, MAX_INLINE_PER_ARTICLE, COST_NOTE,
  type InlineSettings, type InlineImagesView,
} from '../../../core/image/inline';

export function buildInlineCountChoices(s: InlineSettings): LineMessage {
  return textWithActions(
    `文中の画像の枚数（いま: ${s.count === 0 ? '作らない' : `1記事${s.count}枚`}）\n\n` +
    '記事の見出しの下に、AI が作ったイラストを入れます。\n' +
    `・費用: ${COST_NOTE}\n` +
    '・1枚作るごとに、記事が届くまで最大1分ほど長くかかります\n' +
    '・画像に文字は入れません。実在の人物・ロゴ・実物の写真に見える絵は描きません\n' +
    '・入れたときは、記事の末尾に「AIで作成したイメージです」と1行入ります\n' +
    `・1つの記事で作れるのは合計${MAX_INLINE_PER_ARTICLE}枚までです（作り直しを含む）`,
    COUNT_OPTIONS.map((n) => ({ label: n === 0 ? '作らない（0枚）' : `${n}枚`, data: `action=ai_img_set&n=${n}` })),
  );
}

export function buildInlineLimitChoices(s: InlineSettings): LineMessage {
  return textWithActions(
    `文中の画像の1日の上限（いま: ${s.dailyLimit}枚）\n\n` +
    '上限に達した日は、文中の画像を作らずに記事を届けます（サムネの上限とは別に数えます）。',
    DAILY_LIMIT_OPTIONS.map((n) => ({ label: `1日${n}枚まで`, data: `action=ai_ilimit_set&n=${n}` })),
  );
}

/** プレビュー（Flex の中）に載せる行。何も無ければ空 */
export function inlinePreviewLines(v: InlineImagesView | undefined): Array<{ text: string; warn: boolean }> {
  if (!v || v.slots === 0) return [];
  const rows: Array<{ text: string; warn: boolean }> = [];
  rows.push({ text: `文中画像 ${v.created.length}枚（AIが作成）`, warn: false });
  // ★画像は LINE のプレビューには出ない。公開前に必ず見てもらう（源蔵レビュー P3 必須3）
  if (v.created.length > 0) rows.push({ text: AI_IMAGE_REVIEW_NOTE, warn: true });
  if (v.missing > 0) {
    rows.push({
      text: `作れなかった画像が${v.missing}枚あります` + (v.reasons.length ? `：${v.reasons.join('／')}` : '') +
        '（その位置には画像を入れずに公開されます）',
      warn: true,
    });
  }
  if (v.reusedMismatch) {
    rows.push({ text: '文中の画像は前回のものを使っています。見出しに合わなければ「文中画像を作り直す」を押してください', warn: true });
  }
  return rows;
}

/** プレビューに常に出す1行（AI 画像が1枚でも本文にあるとき） */
export const AI_IMAGE_REVIEW_NOTE = '画像は『下書きに保存する』で note の画面で確認してから公開してください';

/**
 * AI 画像をまだ誰も見ていないまま「公開する」が押されたときの確認（一度だけ）。
 * 『このまま公開する』は確認済みの印を付けて、通常の公開へ進む
 */
export function buildAiImageReviewPrompt(articleId: string): LineMessage {
  return textWithActions(
    'AI画像がまだ確認されていません。このまま公開しますか？\n\n' +
    'AI が作った画像は LINE には表示されません。「下書きに保存する」を押すと、note の画面で仕上がりを確認できます（公開はされません）。',
    [
      { label: 'このまま公開する', data: `action=publish_confirm&id=${articleId}` },
      { label: '下書きに保存する', data: `action=savedraft&id=${articleId}` },
    ],
  );
}

/** 作り直しの結果（押した人への1通） */
export function buildInlineRegenResult(articleId: string, v: InlineImagesView | undefined, reasons: string[]): LineMessage {
  const created = v?.created.length ?? 0;
  const missing = v?.missing ?? 0;
  const head = created > 0 ? `文中の画像を作り直しました（${created}枚）。` : '文中の画像を作り直せませんでした。';
  const fail = missing > 0 || reasons.length
    ? `\n作れなかった画像: ${missing}枚` + (reasons.length ? `（${reasons.join('／')}）` : '')
    : '';
  return textWithActions(
    `${head}${fail}\n「下書きに保存する」を押すと、note の画面で仕上がりを確認できます。\n` +
    `（1つの記事で作れるのは合計${MAX_INLINE_PER_ARTICLE}枚までです）`,
    [
      { label: '下書きに保存する', data: `action=savedraft&id=${articleId}` },
      { label: '公開する', data: `action=publish&id=${articleId}` },
    ],
  );
}
