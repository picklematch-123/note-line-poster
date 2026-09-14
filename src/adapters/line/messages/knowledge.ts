/**
 * ナレッジ（メニューでは「プロフィール登録」）の返事。
 *
 * ★2026-09-14 から、返事は2回に分かれる。
 *   1. 送った直後に「覚えました」（原文はもう保存済みで、次の記事から使われる）
 *   2. 整理が終わったら「整理が終わりました」（読み取ったルールや言い回しを見せる）
 *   長文でも1が必ず先に届くので、「返事が来ない」は起きない。
 */
import { textWithActions, type LineMessage } from '../client';
import type { KnowledgeDigest } from '../../../core/generation/schema';

const NEXT_ACTIONS = [
  { label: 'さらに書き足す', data: 'action=ctx_append' },
  { label: '記事を作る', data: 'action=menu_new' },
];

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
