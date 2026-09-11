/** UUID v4 を生成する。Workers 標準の crypto を使う。 */
export function newId(): string {
  return crypto.randomUUID();
}

/** 推測されにくいトークン（Webhook パス等に使う）。 */
export function newToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
