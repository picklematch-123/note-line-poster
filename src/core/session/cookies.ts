/**
 * ブラウザ拡張から届いた Cookie を、note へ送るヘッダに組み立てる。
 *
 * ★拡張側では判断しない。拡張は「集めて送る」だけにして、
 *   何を捨てて何を使うかの判断は全部ここに置く。
 *   拡張は顧客の PC に配られてしまうと直せないが、ここは即日直せる。
 */

export interface RawCookie {
  name: string;
  value: string;
  /** '.note.com' や 'editor.note.com' など */
  domain?: string;
}

/** note のログインを保持している本体。これが無ければ連携は成立しない。 */
export const SESSION_COOKIE = '_note_session_v5';

/**
 * 計測・広告系の Cookie。note のログインには一切関係しないので預からない。
 * ★預かる情報は少ないほどよい。漏れたときの被害も、説明の手間も減る。
 */
const TRACKER = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_uetsid|_uetvid|_clck|_clsk|__utm|_hj|ajs_|amplitude|mp_|IDE|NID|_yj|_td|cto_|_pin_|_rdt|_tt_|_scid|_pk_|_ttp|OptanonConsent|__adroll|_uetmsclkid|ab\.storage|_ym|kntu|adcs)/i;

/** note.com 本体の Cookie かどうか（サブドメイン固有のものより優先する）。 */
function isApexDomain(domain: string | undefined): boolean {
  const d = (domain ?? '').replace(/^\./, '');
  return d === 'note.com' || d === '';
}

/**
 * 送られてきた Cookie から、note へ送るぶんだけを選ぶ。
 *
 * 同じ名前が複数ドメインで来ることがあるので（note.com と editor.note.com など）、
 * note.com 本体のものを優先して1つに寄せる。
 */
export function pickNoteCookies(cookies: RawCookie[]): RawCookie[] {
  const chosen = new Map<string, RawCookie>();

  for (const c of cookies) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    const name = c.name.trim();
    if (!name || TRACKER.test(name)) continue;

    const prev = chosen.get(name);
    // 先に入っているものが note.com 本体なら、サブドメインのもので上書きしない
    if (prev && isApexDomain(prev.domain) && !isApexDomain(c.domain)) continue;
    chosen.set(name, { name, value: c.value, domain: c.domain });
  }

  return [...chosen.values()];
}

/** note へ送る Cookie ヘッダを組み立てる。 */
export function buildCookieHeader(cookies: RawCookie[]): string {
  return pickNoteCookies(cookies)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** ログイン本体の Cookie が含まれているか。 */
export function hasSessionCookie(cookies: RawCookie[]): boolean {
  return pickNoteCookies(cookies).some((c) => c.name === SESSION_COOKIE && c.value.length > 0);
}

/**
 * User-Agent が使えるものか。
 * Cookie と UA はセットで固定する決まりなので、空だと後で不整合の原因になる。
 */
export function isUsableUserAgent(ua: unknown): ua is string {
  return typeof ua === 'string' && ua.length >= 20 && ua.length <= 512;
}

/**
 * Cookie ヘッダ文字列を、預かる方針でならし直す。
 *
 * note は投稿のたびに Set-Cookie を返すので、そのまま保存し続けると
 * 計測系の Cookie まで溜め込むことになる。保存前にここを通す。
 */
export function filterCookieHeader(header: string): string {
  return buildCookieHeader(parseCookieHeader(header));
}

/** Cookie ヘッダ文字列を配列に戻す。 */
export function parseCookieHeader(header: string): RawCookie[] {
  const cookies: RawCookie[] = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    cookies.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: 'note.com' });
  }
  return cookies;
}
