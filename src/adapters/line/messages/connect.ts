/**
 * note 連携まわりの案内文。
 *
 * ★読む人は非エンジニア。手順は「いま何をすればいいか」1つに絞って書く。
 *   選択肢を並べると、そこで止まってしまう。
 */
import type { LineMessage } from '../client';
import { text } from '../client';
import { formatJst } from '../../../lib/time';

/** 連携コードを渡すときの案内。 */
export function buildConnectGuide(code: string, isFirstTime: boolean): LineMessage {
  const steps = isFirstTime
    ? '1. パソコンの Chrome に「note連携ツール」を追加\n' +
      '2. note.com を開いてログイン\n' +
      '3. ツールを開いて、上のコードを貼る\n\n' +
      '※ ツールの追加方法は、お渡しした手順書をご覧ください。'
    : '1. パソコンの Chrome で note.com を開いてログイン\n' +
      '2. 画面右上の「note連携ツール」を開く\n' +
      '3. 上のコードを貼って「note と連携する」を押す';

  return text(
    '【連携コード】\n' +
    `${code}\n` +
    '（15分で切れます）\n\n' +
    '────────\n' +
    steps + '\n\n' +
    '終わったら、このトークにお知らせします。'
  );
}

/** いまの連携状況。 */
export function buildConnectStatus(info: {
  connected: boolean;
  urlname: string;
  status: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  viaEnv: boolean;
}): LineMessage {
  if (!info.connected && !info.viaEnv) {
    return text(
      'note とまだ連携していません。\n\n' +
      '「note連携」と送ってください。連携コードをお渡しします。'
    );
  }

  if (info.viaEnv && !info.connected) {
    return text(
      'note とはつながっています（手動設定）。\n\n' +
      '連携ツールに切り替える場合は「note連携」と送ってください。'
    );
  }

  const label = info.status === 'active' ? '正常' : info.status === 'expiring' ? 'まもなく切れます' : '切れています';
  return text(
    '【note の連携状況】\n' +
    `状態: ${label}\n` +
    `投稿先: @${info.urlname}\n` +
    (info.lastVerifiedAt ? `最終確認: ${formatJst(info.lastVerifiedAt)}\n` : '') +
    (info.expiresAt ? `目安の期限: ${formatJst(info.expiresAt)}\n` : '') +
    '\n' +
    (info.status === 'active'
      ? 'そのままお使いいただけます。\nつなぎ直すときは「note連携」と送ってください。'
      : 'つなぎ直しが必要です。「note連携」と送ってください。')
  );
}

/** 連携が切れて投稿できないときの案内。 */
export function buildSessionExpired(waiting: number): LineMessage {
  return text(
    'note との連携が切れました。\n' +
    'お手数ですが、つなぎ直しをお願いします。\n\n' +
    '「note連携」と送ると、連携コードをお渡しします。\n\n' +
    (waiting > 0
      ? `お預かり中の記事が ${waiting} 件あります。\nつなぎ直せば、そのまま自動で投稿します。`
      : '記事はそのまま残っています。')
  );
}
