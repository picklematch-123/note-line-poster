/**
 * 投稿レートの選択肢と、その言い換え。
 *
 * ★なぜ core に置くか
 *   同じ設定を LINE（クイックリプライ）と `/setup`（ブラウザの選択欄）の
 *   2か所から変えられるようにしたため。片方だけ選択肢が増える、
 *   片方だけ言い回しが違う、という食い違いを構造的に防ぐ。
 *
 * ★この上限が何のためのものか（取り違えないこと）
 *   API 費用の節約ではない。**note のアカウントを守るため**のもの。
 *   note のクリエイター規約 10.1 は「スパムと note 社が判断した場合」
 *   予告なくアカウントを停止できると定めている。
 *
 * ★★ここに出てくる本数・時間は、note が認めた安全な値ではない。
 *   note は基準を公開していない。**分からないので控えめに、**という
 *   こちらの運用方針でしかない。顧客に対しても、そう書くこと。
 *   「3本ならセーフ」と読める書き方は絶対にしない。
 */

/** 1日の投稿本数。0 = 無制限 */
export const DAILY_LIMIT_OPTIONS = [0, 1, 2, 3, 5, 10, 20] as const;

/** 前の投稿からあける時間（秒）。0 = あけない */
export const INTERVAL_OPTIONS = [0, 300, 600, 1800, 3600, 10800, 21600, 86400] as const;

/** 受け付ける範囲。範囲外は端に寄せる（拒否して設定できなくするより害が小さい） */
export const DAILY_LIMIT_MAX = 100;
export const INTERVAL_MAX_SEC = 86400;

/**
 * ★控えめに始めるときの目安。
 *   note の基準ではなく、こちらの運用方針。画面でもそう明示すること。
 */
export const SUGGESTED_DAILY_LIMIT = 3;
export const SUGGESTED_INTERVAL_SEC = 1800;

export function limitLabel(n: number): string {
  return n > 0 ? `1日 ${n} 本まで` : '無制限';
}

export function intervalLabel(sec: number): string {
  if (sec <= 0) return 'なし（連続で投稿できます）';
  if (sec % 3600 === 0) return `${sec / 3600} 時間あけます`;
  return `${Math.round(sec / 60)} 分あけます`;
}

/** 選択肢のボタンに出す短い名前 */
export function limitShortLabel(n: number): string {
  return n === 0 ? '無制限' : `${n}本`;
}

export function intervalShortLabel(sec: number): string {
  if (sec === 0) return 'なし';
  return sec % 3600 === 0 ? `${sec / 3600}時間` : `${sec / 60}分`;
}

/**
 * 入力を数値にする。
 *
 * @returns 読めなければ null（呼び出し側が「変更しない」を選べるように）。
 *   読めた場合、範囲外は端に寄せる。
 */
function parseInRange(raw: string | null | undefined, max: number): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.floor(n), 0), max);
}

export const parseDailyLimit = (raw: string | null | undefined) => parseInRange(raw, DAILY_LIMIT_MAX);
export const parseIntervalSec = (raw: string | null | undefined) => parseInRange(raw, INTERVAL_MAX_SEC);

/**
 * 上限を選ぶ画面に必ず添える説明。
 *
 * ★**根拠のない数字を、根拠があるように見せないこと。**
 *   ここを曖昧にすると「3本までなら安全だと言われた」という受け取り方をされる。
 */
export const RATE_RISK_NOTE =
  '※ この上限は、API の費用ではなく note のアカウントを守るためのものです。\n'
  + 'note は「何本までなら大丈夫か」を公開していません。ここに並ぶ本数は、\n'
  + 'note が認めた安全な数ではなく、分からないので控えめに、という目安です。\n'
  + 'note の規約には、スパムと判断した場合に予告なくアカウントを停止できる、\n'
  + 'と書かれています。上限を外すかどうかは、その前提でお決めください。';
