/**
 * ナレッジ（リッチメニューの「ナレッジ」）の返事。
 *
 * ★2026-09-14 から、返事は2回に分かれる。
 *   1. 送った直後に「覚えました」（原文はもう保存済みで、次の記事から使われる）
 *   2. 整理が終わったら「整理が終わりました」（読み取ったルールや言い回しを見せる）
 *   長文でも1が必ず先に届くので、「返事が来ない」は起きない。
 */
import { text, textWithActions, type LineMessage } from '../client';
import type { KnowledgeDigest } from '../../../core/generation/schema';
import { listEntries } from '../../../core/generation/context';

const NEXT_ACTIONS = [
  { label: 'さらに書き足す', data: 'action=ctx_append' },
  { label: 'ナレッジを確認', data: 'action=ctx_view' },
  { label: '記事を作る', data: 'action=menu_new' },
];

// ── 入口を2つに分ける（2026-11 オーナー指示）──────────────────
//   「ナレッジを確認」= LINE でそのまま全文を見る（コード不要・投稿者も可）
//   「ナレッジを修正」= 書き足す／○番を消す／全部消す（削除系は持ち主・管理者だけ）
//   Web でまとめて直したいときだけ「セットアップ」→ 設定画面（/setup）を使う。

/** LINE の1通の上限（5000字）に余裕を持たせた、1通あたりの字数 */
export const FULL_CHUNK_SIZE = 4000;
/** 1回の返信で送れるのは5通まで */
export const FULL_MAX_MESSAGES = 5;

/** 「ナレッジ」ボタン（リッチメニュー）を押したとき。確認か修正かを選ばせる */
export function buildKnowledgeHub(count: number): LineMessage {
  return textWithActions(
    `【ナレッジ】いま ${count} 件覚えています。\n` +
    'ここに書いたことは、これから作る記事すべての前提になります。\n\n' +
    'どちらにしますか？\n' +
    '・確認する … 覚えている内容を、そのまま全部表示します\n' +
    '・修正する … 書き足す・消す',
    [
      { label: '確認する', data: 'action=ctx_view' },
      { label: '修正する', data: 'action=ctx_modify' },
      { label: 'やめる', data: 'action=menu_cancel' },
    ],
  );
}

/** まだ何も覚えていないとき（次に送った文章をそのまま覚える） */
export function buildKnowledgeFirst(): LineMessage {
  return textWithActions(
    'ここに書いたことは、これから作る記事すべての前提になります。\n' +
    '思いついたものから、どんどん送ってください。あとから足していけます。\n\n' +
    'たとえば こんなこと:\n' +
    '・何をやっているか、どんなお客さんが来るか\n' +
    '・使っている材料、こだわり、店の決まりごと\n' +
    '・「文末に https://... のリンクを貼る」のような毎回のルール\n' +
    '・「店主は大将と書く」のような呼び方の指定\n\n' +
    '次に送るメッセージをそのまま覚えます。',
    [{ label: 'やめる', data: 'action=ctx_cancel' }],
  );
}

/**
 * 長い文章を、1通の上限に収まるよう切り分ける。
 * ★できるだけ段落（空行）の切れ目で分ける。1段落が長すぎるときだけ途中で切る。
 */
export function splitIntoChunks(body: string, size = FULL_CHUNK_SIZE): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of body.split(/\n{2,}/)) {
    const piece = cur ? `${cur}\n\n${para}` : para;
    if (piece.length <= size) { cur = piece; continue; }
    if (cur) out.push(cur);
    // 1段落だけで上限を超えるものは、上限ごとに切る
    let rest = para;
    while (rest.length > size) { out.push(rest.slice(0, size)); rest = rest.slice(size); }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

/**
 * 「ナレッジを確認」: 覚えている内容を、番号付きでそのまま全部見せる。
 * ★番号は「修正」で1件消すときの番号と同じ（listEntries の並び）。
 * ★5通に収まらないときは、送れたところまで見せて、続きの見方を案内する。
 *   投稿者は設定画面のコードを受け取れないので、案内を分ける。
 * @param canEdit 持ち主・管理者か（続きの案内の出し分けに使う）
 */
export function buildKnowledgeFull(rawText: string, canEdit: boolean): LineMessage[] {
  const entries = listEntries(rawText);
  const head = `【覚えていること】全${entries.length}件\n（番号は「ナレッジを修正」で消すときに使います）`;
  const body = [head, ...entries.map((e, i) => `【${i + 1}】\n${e}`)].join('\n\n');

  const more = canEdit
    ? '\n\n（ここまでで表示しきれませんでした。続きは LINE で「セットアップ」と送ると、設定画面で確認できます）'
    : '\n\n（ここまでで表示しきれませんでした。続きは、持ち主の方に設定画面で確認してもらってください）';

  let chunks = splitIntoChunks(body);
  const overflow = chunks.length > FULL_MAX_MESSAGES;
  if (overflow) {
    chunks = chunks.slice(0, FULL_MAX_MESSAGES);
    // 案内の分だけ最後の1通を削る（1通の上限を超えないように）
    const last = chunks[FULL_MAX_MESSAGES - 1];
    chunks[FULL_MAX_MESSAGES - 1] = last.slice(0, FULL_CHUNK_SIZE - more.length) + more;
  }

  const actions = [
    { label: '修正する', data: 'action=ctx_modify' },
    { label: '記事を作る', data: 'action=menu_new' },
  ];
  return chunks.map((c, i) => (i === chunks.length - 1 ? textWithActions(c, actions) : text(c)));
}

/**
 * 「ナレッジを修正」: できることを示す。既定は「送った文章を書き足す」。
 * @param canEdit 持ち主・管理者か（消す・入れ替えるを出すか）
 */
export function buildKnowledgeModify(count: number, canEdit: boolean): LineMessage {
  const ops = canEdit
    ? '\n\nほかにできること:\n' +
      '・1件消す … 番号で選びます（例：「3番を消す」と送ってもOK）\n' +
      '・入れ替える … 全部を新しい内容に置き換えます\n' +
      '・全部消す\n\n' +
      'Web でまとめて直したいときは「セットアップ」と送ってください（設定画面のリンクと確認コードが届きます）。'
    : '';
  return textWithActions(
    `【ナレッジの修正】いま ${count} 件覚えています。\n\n` +
    'このあと送った文章を、そのまま書き足します。いまの内容は残ります。' +
    ops +
    '\n\nやめるときは「やめる」と送ってください。',
    [
      ...(canEdit ? [
        { label: '1件消す', data: 'action=ctx_delete' },
        { label: '入れ替える', data: 'action=ctx_replace' },
        { label: '全部消す', data: 'action=ctx_clear' },
      ] : []),
      { label: '確認する', data: 'action=ctx_view' },
      { label: 'やめる', data: 'action=ctx_cancel' },
    ],
  );
}

/** 1件消すときの番号選び。番号を見ずに来た人のため、短い一覧を添える */
export function buildKnowledgeDeletePicker(rawText: string): LineMessage {
  const entries = listEntries(rawText);
  const shown = entries.slice(0, 20).map((e, i) => {
    const body = e.replace(/\n/g, ' ');
    return `${i + 1}. ${body.length > 40 ? `${body.slice(0, 40)}…` : body}`;
  });
  return {
    type: 'text',
    text:
      '消したいものの番号を送ってください。\n\n' +
      shown.join('\n') +
      (entries.length > shown.length ? `\n（ほか ${entries.length - shown.length} 件）` : '') +
      '\n\n（全文は「ナレッジを確認」で見られます）',
    quickReply: {
      items: [
        ...entries.slice(0, 12).map((_, i) => ({
          type: 'action' as const,
          action: { type: 'message' as const, label: String(i + 1), text: String(i + 1) },
        })),
        { type: 'action' as const, action: { type: 'postback' as const, label: 'やめる', data: 'action=ctx_cancel', displayText: 'やめる' } },
      ],
    },
  };
}

/** 送った直後 */
export function buildKnowledgeReceived(count: number, mode: 'append' | 'replace'): LineMessage {
  return textWithActions(
    `${mode === 'append' ? '覚えました' : '入れ替えました'}。（全${count}件）\n\n` +
    '書いてくれた内容は、次の記事からもう使われます。\n' +
    '続けて内容を整理しています（長い文章だと数分かかります）。終わったらお知らせします。',
    NEXT_ACTIONS,
  );
}

/** 整理が終わったとき */
export function buildKnowledgeSaved(data: KnowledgeDigest, count: number): LineMessage {
  return textWithActions(
    `整理が終わりました。（全${count}件）\n\n` +
    `【立場】${data.standpoint}\n` +
    (data.facts.length ? `【記事に使えること】${data.facts.length}件\n` : '') +
    (data.rules.length ? `【毎回のルール】\n${data.rules.map((r) => `・${r}`).join('\n')}\n` : '') +
    (data.wording.length ? `【言い方の指定】${data.wording.join('、')}\n` : '') +
    (data.avoid.length ? `【書かないこと】${data.avoid.join('、')}\n` : '') +
    '\nこの前提で記事を書きます。',
    NEXT_ACTIONS,
  );
}

/** 整理に失敗したとき。★覚えた内容は消えていないことを必ず伝える */
export function buildKnowledgeOrganizeFailed(reason: string | null): string {
  return '内容の整理が、うまくいきませんでした。\n\n' +
    '書いてくれた内容はそのまま覚えていて、記事にも使われています。' +
    (reason ? `\n\n${reason}` : '') +
    '\n\n時間をおいて書き足すと、もう一度整理します。';
}
