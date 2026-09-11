/**
 * 秘密情報のマスキング。
 * ★ログ・エラーメッセージ・LINE返信に出す前に必ずこれを通すこと。
 * console.log(session) を1回書いた瞬間に事故になる。
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(_note_session_v5=)[^;"'\s]+/g, '$1***'],
  [/(XSRF-TOKEN=)[^;"'\s]+/g, '$1***'],
  [/(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***'],
  [/("?[Cc]ookie"?\s*[:=]\s*"?)[^"',}\n]{20,}/g, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{20,}/g, '$1***'],
  [/("channel_?[Ss]ecret"\s*:\s*")[^"]+/g, '$1***'],
  [/("access_?[Tt]oken"\s*:\s*")[^"]+/g, '$1***'],
];

export function mask(input: unknown): string {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** マスク済みのログ出力。アプリ内ではこれだけを使う。 */
export const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[info] ${msg}${data !== undefined ? ' ' + mask(data) : ''}`),
  warn: (msg: string, data?: unknown) =>
    console.warn(`[warn] ${msg}${data !== undefined ? ' ' + mask(data) : ''}`),
  error: (msg: string, data?: unknown) =>
    console.error(`[error] ${msg}${data !== undefined ? ' ' + mask(data) : ''}`),
};
