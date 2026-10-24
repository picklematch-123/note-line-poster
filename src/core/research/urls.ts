/**
 * URL の機械検査（LLM を通さない純関数）。
 *
 * ★Web の調査結果と AI の出力は信用できない入力として扱う。
 *   「どの URL なら記事に残してよいか」はここだけで決める（同じ判定を2か所に書かない）。
 */

/** 短縮URL（行き先が見えない＝検査をすり抜ける）。代表的なものだけで十分。迷ったら捨てる側 */
const SHORTENER_HOSTS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly',
  'lnkd.in', 'amzn.to', 'amzn.asia', 'x.gd', 'v.gd', 'shorturl.at', 'tiny.cc', 'rb.gy', 't.ly',
  'qr.paypay.ne.jp', 'forms.gle', 'youtu.be', 'urx.nu', 'urx2.nu', 'onl.la', 'onl.sc', 'bit.do', 'po.st',
]);

/**
 * 文中の URL（日本語の句読点・括弧は含めない）。html.ts の自動リンク化と同じ切り方にそろえる。
 * ★大文字小文字を区別しない（2026-10-24 源蔵レビュー: `HTTPS://` がすり抜けた）
 */
export const URL_IN_TEXT = /https?:\/\/[^\s<>"'（）()「」『』【】、。，．…\]]+/gi;

/** URL の中身として続いてよい文字（URL_IN_TEXT と同じ切り方） */
const URL_BODY = `[^\\s<>"'（）()「」『』【】、。，．…\\]\\u0000]*`;
/**
 * ホスト名（ラベル.ラベル.英字TLD）。日本語のドメインは対象外（自動リンクもされないため）。
 * ★`Node.js/TypeScript` のような技術用語を URL と取り違えないよう、実在しない TLD の js/ts 系だけは外す
 */
const HOST = `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?!(?:js|ts|jsx|tsx|mjs|cjs)(?![a-z]))[a-z]{2,}(?::\\d+)?`;

/**
 * スキームを省いた URL（`//evil.com/x`）。ブラウザは今のページと同じスキームで開くので、立派なリンクになる。
 * ★2026-10-24 源蔵レビューで実証された経路
 */
const PROTOCOL_RELATIVE = new RegExp(`(?<![A-Za-z0-9:/])\\/\\/${HOST}${URL_BODY}`, 'gi');
/**
 * ドメインとパスだけの URL（`evil.com/path`）。リンクにはならないが、読者が打ち込めば行ける。
 * ★パスの無い `example.com` だけの語は消さない（「note.com で…」のような普通の文まで消えるため）
 */
const DOMAIN_WITH_PATH = new RegExp(`(?<![A-Za-z0-9.@/_-])${HOST}\\/${URL_BODY}`, 'gi');
/** スキームなしの www. */
const WWW = /(?<![A-Za-z0-9.])www\.[^\s、。）)」』】\u0000]+/gi;

/** script / style は中身ごと */
const SCRIPT_BLOCK = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
/** HTML タグと `<https://...>` の形 */
const TAG = /<\/?[a-zA-Z!][^>\n]*>|<https?:[^>\s]*>/gi;

/**
 * HTML タグを「変化しなくなるまで」繰り返し消す。
 * ★1回だけだと `<<figure>figure>` が、内側を消した結果 `<figure>` として組み上がる（2026-10-24 源蔵レビューで実証）
 */
export function stripTagsUntilStable(text: string): string {
  let s = text;
  for (let i = 0; i < 50; i++) {
    const next = s.replace(SCRIPT_BLOCK, '').replace(TAG, '');
    if (next === s) return s;
    s = next;
  }
  // 50回で収まらないのは異常な入力。タグの材料を丸ごと捨てる（安全側）
  return s.replace(/[<>]/g, '');
}

/**
 * `<` `>` を全部消す（行頭の引用記号 `>` だけは残す）。
 * ★本文に生の HTML は要らない（画像の figure は後で fill が足す）。タグを消し損ねても、材料が残らなければ組み上がらない
 */
export function removeAngleBrackets(text: string): string {
  return text.split('\n').map((line) => {
    const m = /^(\s*(?:>\s?)+)/.exec(line);
    const head = m ? m[1] : '';
    return head + line.slice(head.length).replace(/[<>]/g, '');
  }).join('\n');
}

/**
 * 文中の URL を置き換える（スキームつき → スキーム省略 → ドメイン＋パス → www. の順）。
 * スキームつき URL は onUrl の返した文字列に置き換える（残すか消すかは呼び出し側が決める）。
 * スキーム省略・ドメイン＋パス・www. は常に消す（許可リストと照合できる形ではないため）。
 */
export function replaceUrls(text: string, onUrl: (url: string, tail: string) => string): string {
  return text
    .replace(URL_IN_TEXT, (raw) => {
      const url = trimTrailing(raw);
      return onUrl(url, raw.slice(url.length));
    })
    .replace(PROTOCOL_RELATIVE, (raw) => raw.slice(trimTrailing(raw).length))
    .replace(DOMAIN_WITH_PATH, (raw) => raw.slice(trimTrailing(raw).length))
    .replace(WWW, '');
}

/** URL の末尾にくっついた句読点・閉じ括弧を落とす */
export function trimTrailing(url: string): string {
  return url.replace(/[.,!?:;）)」』】＞>]+$/, '');
}

function parse(url: string): URL | null {
  try { return new URL(url.trim()); } catch { return null; }
}

/**
 * 出典として使ってよい URL か。
 * http(s) のみ・ログイン情報つき（user:pass@）は不可・短縮URLは不可・ホスト名が無いものは不可。
 */
export function isSafeSourceUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  if (/[\s<>"]/.test(url.trim())) return false;
  const u = parse(url);
  if (!u) return false;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes('.')) return false;
  if (SHORTENER_HOSTS.has(host) || SHORTENER_HOSTS.has(host.replace(/^www\./, ''))) return false;
  return true;
}

/**
 * 照合用に URL をそろえる。
 * ★OpenAI の引用は `?utm_source=openai` を付けて返すことがある。付いている・いないで
 *   「参照一覧に無い」と誤判定しないよう、計測用のパラメータ・#以降・末尾の / を落として比べる。
 */
export function normalizeUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid') u.searchParams.delete(k);
  }
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  let s = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
  s = s.replace(/\/+$/, '');
  return s;
}

/** URL の集合（そろえた形）を作る */
export function urlSet(urls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (n) out.add(n);
  }
  return out;
}

export function inUrlSet(url: string, set: Set<string>): boolean {
  const n = normalizeUrl(url);
  return n !== null && set.has(n);
}

/** 文中の URL を拾う（同じものは1回だけ） */
export function extractTextUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.match(URL_IN_TEXT) ?? []) {
    const url = trimTrailing(raw);
    if (/^https?:\/\/[^/\s]+/i.test(url)) seen.add(url);
  }
  return [...seen];
}

/**
 * 文章から URL とリンク記法を取り除く（事実メモの claim 用）。
 * ★P0 実測で claim に `([mhlw.go.jp](URL))` が混ざった。そのまま本文に入ると、検査をすり抜ける URL の経路になる。
 */
export function stripUrlsFromText(text: string): string {
  // ★タグとリンク記法は「変化しなくなるまで」繰り返す（入れ子で組み上がる形をつぶす）
  let s = text.replace(/\u0000/g, '');
  for (let i = 0; i < 20; i++) {
    const next = stripTagsUntilStable(s)
      // 画像記法・リンク記法の丸ごと（前後の括弧も）
      .replace(/[（(]\s*!?\[[^\]]*\]\([^)]*\)\s*[）)]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    if (next === s) break;
    s = next;
  }
  // 裸の URL（大文字のスキーム・スキーム省略・ドメイン＋パス・www. も）
  s = replaceUrls(s, (_url, tail) => tail);
  return removeAngleBrackets(s)
    // 中身が空になった括弧
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 公開される HTML の検査（★2026-10-24 源蔵レビュー必須1）。
 * タグの href / src などリンク先になる属性を全部拾い、許可された URL 以外を返す。
 * 「on〜」のイベント属性も、それ自体を許可外として返す。
 *
 * ★検査は「公開する HTML（html.ts の出力）」に対して行う。Markdown の段階で消えたつもりでも、
 *   変換で組み上がる経路があったため（`<<figure>figure>`）。
 */
export function findDisallowedLinks(html: string, allowedUrls: Iterable<string>): string[] {
  const allowed = urlSet(allowedUrls);
  const bad: string[] = [];
  const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const attrs = tag.replace(/^<[a-zA-Z0-9-]+/, '');
    for (const m of attrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const name = m[1].toLowerCase();
      if (/^on/.test(name)) { bad.push(`${name}=`); continue; }
      if (!['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'background', 'data', 'xlink:href'].includes(name)) continue;
      const value = decode((m[2] ?? m[3] ?? m[4] ?? '').trim());
      const ok = /^https?:\/\//i.test(value) && inUrlSet(value, allowed);
      if (!ok) bad.push(value);
    }
  }
  return bad;
}

/** findDisallowedLinks が1件でも返したら例外にする（テスト・公開前の点検用） */
export function assertOnlyAllowedLinks(html: string, allowedUrls: Iterable<string>): void {
  const bad = findDisallowedLinks(html, allowedUrls);
  if (bad.length) throw new Error(`許可されていないリンク先が公開HTMLにあります: ${bad.join(' / ')}`);
}
