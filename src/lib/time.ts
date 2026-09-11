/** 日本時間まわりのユーティリティ。D1 には ISO8601 文字列で保存する。 */

export function nowIso(): string {
  return new Date().toISOString();
}

/** JST の 'YYYY-MM-DD'。日次上限のカウントに使う。 */
export function jstDate(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** ISO8601 に秒を足す。 */
export function addSeconds(iso: string, sec: number): string {
  return new Date(new Date(iso).getTime() + sec * 1000).toISOString();
}

/** 2つの時刻の差（秒）。 */
export function secondsBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 1000;
}

/** 人間向けの表示（LINE のメッセージに使う）。 */
export function formatJst(iso: string): string {
  const jst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCMonth() + 1}/${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}
