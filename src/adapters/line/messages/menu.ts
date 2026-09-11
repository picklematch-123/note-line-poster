/**
 * メニューと記事一覧のメッセージ。
 *
 * LINE には画面が1つしかないので、「いま何ができるか」を
 * 迷わず示せるかどうかが使い勝手を決める。
 */
import type { LineMessage } from '../client';
import { text } from '../client';
import type { ArticleRow } from '../../../ports/storage/db';
import { formatJst } from '../../../lib/time';

/** 状態を、顧客に意味が伝わる日本語にする。 */
export function stateLabel(state: string): string {
  switch (state) {
    case 'received':          return '受付済み';
    case 'generating':        return '作成中';
    case 'preview_ready':     return '作成中';
    case 'awaiting_approval': return '確認待ち';
    case 'editing':           return '修正中';
    case 'blocked':           return '投稿待ち';
    case 'awaiting_session':  return '連携切れ';
    case 'awaiting_agent':    return 'パソコン待ち';
    case 'saving_draft':      return '保存中';
    case 'drafted':           return '下書き保存済み';
    case 'publishing':        return '投稿中';
    case 'published':         return '公開済み';
    case 'failed':            return '失敗';
    case 'expired':           return '期限切れ';
    default:                  return state;
  }
}

/** メインメニュー。 */
export function buildMenu(): LineMessage {
  return {
    type: 'text',
    text:
      'できることは3つです。\n\n' +
      '📝 記事作成\n' +
      '　 ネタを送ると記事にします\n\n' +
      '📚 記事一覧\n' +
      '　 これまでの記事を見る・直す\n\n' +
      '👤 ナレッジ\n' +
      '　 記事の前提になることを覚えさせる\n' +
      '　 （思いついた順にどんどん足せます）\n\n' +
      '画面下のメニューからも選べます。\n' +
      '※ note とつなぎ直すときは「note連携」と送ってください。',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '記事を作成する', data: 'action=menu_new', displayText: '記事を作成する' } },
        { type: 'action', action: { type: 'postback', label: '過去記事一覧', data: 'action=menu_list', displayText: '過去記事一覧・修正' } },
        // ★リッチメニューの画像には「プロフィール登録」と刷ってあるので、
        //   displayText はそのまま残す（画像を差し替えるまで揃えておく）
        { type: 'action', action: { type: 'postback', label: 'ナレッジ', data: 'action=menu_profile', displayText: 'プロフィールを登録する' } },
      ],
    },
  };
}

/** 記事一覧。連番で選べるようにする。 */
export function buildArticleList(articles: ArticleRow[]): LineMessage {
  if (articles.length === 0) {
    return text(
      'まだ記事がありません。\n\n' +
      '「記事作成」と送ってから、記事にしたいネタを送ってください。',
    );
  }

  const lines = articles.map((a, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const label = stateLabel(a.state);
    const title = (a.title ?? '（作成中）').slice(0, 26);
    const when = formatJst(a.created_at);
    return `${num}. ${title}\n     ${label}・${when}`;
  });

  return {
    type: 'text',
    text:
      `【これまでの記事】${articles.length}件\n\n` +
      lines.join('\n\n') +
      '\n\n────────\n' +
      '番号を送ると、その記事を開きます。\n' +
      '（例：1）',
    quickReply: {
      items: [
        ...articles.slice(0, 10).map((_, i) => ({
          type: 'action' as const,
          action: {
            type: 'message' as const,
            label: String(i + 1),
            text: String(i + 1),
          },
        })),
        { type: 'action' as const, action: { type: 'postback' as const, label: 'やめる', data: 'action=menu_cancel', displayText: 'やめる' } },
      ],
    },
  };
}

/** 一覧から選んだ記事の操作メニュー。状態によって出せる操作が変わる。 */
export function buildArticleActions(a: ArticleRow): LineMessage {
  const isPublished = a.state === 'published';
  const items: Array<{ label: string; data: string }> = [];

  items.push({ label: '全文を読む', data: `action=fulltext&id=${a.id}` });

  if (isPublished) {
    items.push({ label: '修正する', data: `action=reopen&id=${a.id}` });
  } else if (a.state === 'drafted') {
    // note に下書きがある。公開も修正もできる
    items.push({ label: '公開する', data: `action=publish&id=${a.id}` });
    items.push({ label: '修正する', data: `action=reopen&id=${a.id}` });
  } else if (a.state === 'awaiting_approval' || a.state === 'editing') {
    items.push({ label: '公開する', data: `action=publish&id=${a.id}` });
    items.push({ label: '下書きに保存', data: `action=savedraft&id=${a.id}` });
    items.push({ label: '修正する', data: `action=revise&id=${a.id}` });
  } else if (a.state === 'failed') {
    items.push({ label: '作り直す', data: `action=retry&id=${a.id}` });
  }
  items.push({ label: '一覧に戻る', data: 'action=menu_list' });

  const head =
    `【${stateLabel(a.state)}】${a.title ?? '（作成中）'}\n` +
    `${formatJst(a.created_at)}` +
    (a.note_url ? `\n${a.note_url}` : '');

  const guide = isPublished
    ? '\n\n「修正する」を押すと、公開済みの記事を書き直して、同じURLのまま更新できます。'
    : a.state === 'drafted'
      ? '\n\nnote に下書きとして保存済みです。このまま公開もできます。'
      : a.state === 'awaiting_approval'
        ? '\n\n内容を確認して「公開する」を押してください。'
        : '';

  return {
    type: 'text',
    text: head + guide,
    quickReply: {
      items: items.slice(0, 13).map((x) => ({
        type: 'action',
        action: { type: 'postback', label: x.label, data: x.data, displayText: x.label },
      })),
    },
  };
}
