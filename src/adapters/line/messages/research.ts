/**
 * Webリサーチの LINE の文面（AI設定の画面と、プレビューに載せる一言）。
 *
 * ★プレビューの一言は、既存の Flex メッセージの中に載せる（LINE の通数を増やさない）。
 */
import { textWithActions, type LineMessage } from '../client';
import {
  DOMAIN_PRESETS, DOMAIN_PRESET_KEYS, DAILY_LIMIT_OPTIONS, MAX_RESEARCH_PER_ARTICLE, MAX_TOOL_CALLS, DOMAIN_HINT,
  type ResearchSettings,
} from '../../../core/research/settings';
import type { ResearchRecord } from '../../../core/research/run';
import type { InlineSettings } from '../../../core/image/inline';

const MODE_LABEL = { none: '与えた情報だけで書く', web: 'Webで調べて出典つきで書く' } as const;

/**
 * 「AI設定」の画面。調べ方・調べる先・1日の上限・文中の画像（P3）と、サムネの設定への入り口。
 * ★OpenAI のキーが無い環境では、調査・文中の画像の操作ボタンを出さない（使えない機能を見せない）。
 */
export function buildAiSettings(s: ResearchSettings, hasKey: boolean, inline?: InlineSettings): LineMessage {
  if (!hasKey) {
    return textWithActions(
      'AI設定\n\n' +
      '・Webで調べる機能: OpenAI の API キーが未登録のため使えません（記事は、ナレッジとネタだけから書きます）\n\n' +
      'キーを登録すると、Webで調べて出典つきで書く設定と、サムネの自動生成が使えるようになります。',
      [{ label: 'サムネの設定', data: 'action=ai_thumb' }],
    );
  }
  return textWithActions(
    'AI設定\n\n' +
    `・調べ方: ${MODE_LABEL[s.mode]}\n` +
    `・調べる先: ${DOMAIN_PRESETS[s.domains].label}\n` +
    `・1日に調べる記事数の上限: ${s.dailyLimit}件\n` +
    (inline ? `・文中の画像: ${inline.count === 0 ? '作らない' : `1記事${inline.count}枚（AIが作成）`}（1日の上限 ${inline.dailyLimit}枚）\n` : '') +
    '\n' +
    '※ Webで調べると、記事の末尾に「参考にした情報」として出典が付きます。出典があっても内容の正しさを保証するものではないので、公開前に目を通してください。\n' +
    `※ 調べる費用は、ご自身の OpenAI アカウントにかかります（1記事 約2〜15円の目安。1回の調査で検索は${MAX_TOOL_CALLS}回まで、1つの記事で調べ直せるのは合計${MAX_RESEARCH_PER_ARTICLE}回まで）。`,
    [
      s.mode === 'web'
        ? { label: '与えた情報だけにする', data: 'action=ai_mode&v=none' }
        : { label: 'Webで調べるにする', data: 'action=ai_mode&v=web' },
      { label: '調べる先を選ぶ', data: 'action=ai_domains' },
      { label: '調べる上限を選ぶ', data: 'action=ai_rlimit' },
      ...(inline ? [
        { label: '文中の画像の枚数', data: 'action=ai_img' },
        { label: '文中画像の1日上限', data: 'action=ai_ilimit' },
      ] : []),
      { label: 'サムネの設定', data: 'action=ai_thumb' },
      // 2026-10-26 画像のルール（状態の要約と、設定画面への入り口）
      { label: '画像のルール', data: 'action=ai_imgrules' },
    ],
  );
}

export function buildDomainChoices(s: ResearchSettings): LineMessage {
  return textWithActions(
    `調べる先（いま: ${DOMAIN_PRESETS[s.domains].label}）\n\n` +
    '健康・医療・お金の話題は、信頼できるサイトに絞ると安心です。絞ると、見つかる情報は少なくなります。',
    DOMAIN_PRESET_KEYS.map((k) => ({ label: DOMAIN_PRESETS[k].label.replace(/（.*$/, ''), data: `action=ai_domains_set&v=${k}` })),
  );
}

export function buildResearchLimitChoices(s: ResearchSettings): LineMessage {
  return textWithActions(
    `1日に調べる記事数の上限（いま: ${s.dailyLimit}件）\n\n上限に達した日は、与えた情報だけで書きます（記事は作れます）。`,
    DAILY_LIMIT_OPTIONS.map((n) => ({ label: `1日${n}件まで`, data: `action=ai_rlimit_set&n=${n}` })),
  );
}

/**
 * 健康・医療・お金のテーマで、Webで調べた事実を使ったときの注意（プレビューに1行だけ）。
 * ★調べた事実（一般論）の直後に商品の話が続くと、商品の効果として読めてしまう（薬機法・景表法）。
 *   本文の指示でも禁じているが、最後は承認ボタンの前に人が見る（2026-10-24 源蔵レビュー）
 */
export const SENSITIVE_RESEARCH_NOTE = '調べた事実は一般的な情報です。商品の効果として読めないか、公開前にご確認ください';

/** プレビューに載せる形 */
export interface ResearchView {
  /** 「Webで調べました（出典N件）」など */
  summary: string;
  /** 調べられなかった（目立たせる） */
  warn: boolean;
  /** 失敗・上限の理由、調べる先の案内 */
  notes: string[];
  /** 要確認の語（先頭の数件） */
  flags: Array<{ term: string; excerpt: string }>;
  flagTotal: number;
  /** 「もう一度調べる」を出すか */
  canRedo: boolean;
}

export function toResearchView(r: ResearchRecord | null, canRedo: boolean): ResearchView | undefined {
  if (!r) return undefined;
  const refs = r.check?.referenceCount ?? 0;
  const notes: string[] = [];
  let summary: string;
  switch (r.status) {
    case 'ok':
      summary = refs > 0 ? `Webで調べました（出典${refs}件）` : 'Webで調べましたが、本文で使われた出典はありませんでした';
      break;
    case 'off':
      summary = '与えた情報だけで書きました';
      break;
    case 'limit':
      summary = '調べる上限に達したので、与えた情報だけで書きました';
      if (r.note) notes.push(r.note);
      break;
    default:
      // ★黙って品質を落とさない。調べられなかったことを明示する
      summary = '出典を確認できなかったので、与えた情報だけで書きました';
      if (r.note) notes.push(r.note);
  }
  if (r.domainHint) notes.push(DOMAIN_HINT);
  if (r.status === 'ok' && r.sensitive) notes.push(SENSITIVE_RESEARCH_NOTE);
  return {
    summary,
    warn: r.status === 'failed' || r.status === 'empty' || r.status === 'limit',
    notes,
    // 出典の付け違い（〔n〕の文の語がメモ n に無い）は、そうと分かるように書き添える
    flags: (r.check?.flags ?? []).slice(0, 3).map(({ term, excerpt, reason }) => ({
      term, excerpt: reason === 'miscited' ? `（付けた出典の内容に無い）${excerpt}` : excerpt,
    })),
    flagTotal: r.check?.total ?? 0,
    canRedo: canRedo && r.status !== 'ok' && r.status !== 'off',
  };
}
