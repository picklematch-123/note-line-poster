/**
 * Markdown -> note が受け付ける HTML への変換。
 *
 * ★note は API 経由で受け取った本文を自動でリンク化しない。
 *   URL をリンクとして機能させるには、こちらで <a> にしてから渡す必要がある。
 *
 * Phase 0 の実測で、note は以下のタグをそのまま保持することを確認済み:
 *   h2 / h3 / p / strong / ul / ol / li / blockquote / a / figure / img / hr
 * （a には note 側で rel="nofollow noopener" が自動付与される）
 *
 * 生成する Markdown は自分たちで制御しているので、汎用パーサは使わず
 * 必要な記法だけを扱う。対応外の記法は <p> に丸める。
 */

/** HTML 特殊文字をエスケープする。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 文中の裸のURLを拾う。
 *
 * 日本語の文はURLの直後に句読点や閉じ括弧が続くので、それらは URL に含めない。
 * `&` はこの時点で `&amp;` になっているため、`&` と `;` は許す。
 */
const BARE_URL = /https?:\/\/[^\s<>"'（）()「」『』【】、。，．…]+/g;

/** URL の末尾にくっついた句読点・閉じ括弧を切り離す。 */
function splitTrailing(url: string): [string, string] {
  // `&amp;` で終わる場合の `;` まで削らないよう、`;` は対象にしない
  const m = /[.,!?:）)」』】＞>]+$/.exec(url);
  if (!m) return [url, ''];
  return [url.slice(0, m.index), m[0]];
}

/** 素のテキストに含まれる URL をリンクにする。 */
function linkifyBare(s: string): string {
  return s.replace(BARE_URL, (matched) => {
    const [url, tail] = splitTrailing(matched);
    // スキームだけ、など中身の無いものはそのまま残す
    if (!/^https?:\/\/[^/\s]+/.test(url)) return matched;
    return `<a href="${url}">${url}</a>${tail}`;
  });
}

/**
 * すでに <a> になっている範囲を避けて、裸のURLだけをリンクにする。
 * ★ここを避けないと、href の中の URL を二重にリンク化してタグが壊れる。
 */
function autolink(s: string): string {
  const ANCHOR = /<a\s[^>]*>[\s\S]*?<\/a>/g;
  let out = '';
  let last = 0;
  for (const m of s.matchAll(ANCHOR)) {
    out += linkifyBare(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + linkifyBare(s.slice(last));
}

/** インライン記法（太字・リンク）を HTML にする。 */
export function inline(src: string): string {
  // すでに <figure><img> が埋め込まれている行はそのまま通す
  if (/^\s*<figure>/.test(src)) return src.trim();

  let s = escapeHtml(src);
  // [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
    return `<a href="${url}">${text}</a>`;
  });
  // ★書き手が URL をそのまま書いた場合もリンクにする。
  //   note は API 経由で受け取った本文を自動リンク化しないので、
  //   ここで変換しないと「ただの文字列」のまま公開されてしまう。
  s = autolink(s);
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

interface Block {
  kind: 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'hr' | 'raw';
  lines: string[];
}

/** Markdown をブロックに分割する。 */
function toBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split('\n');
  let cur: Block | null = null;

  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') { flush(); continue; }

    // 埋め込み済みの figure（画像）はそのまま1ブロック
    if (/^\s*<figure>/.test(line)) { flush(); blocks.push({ kind: 'raw', lines: [line.trim()] }); continue; }

    const h = /^(#{2,3})\s+(.+)$/.exec(line);
    if (h) { flush(); blocks.push({ kind: h[1].length === 2 ? 'h2' : 'h3', lines: [h[2].trim()] }); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flush(); blocks.push({ kind: 'hr', lines: [] }); continue; }

    const ul = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      if (cur?.kind !== 'ul') { flush(); cur = { kind: 'ul', lines: [] }; }
      cur.lines.push(ul[1]);
      continue;
    }

    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ol) {
      if (cur?.kind !== 'ol') { flush(); cur = { kind: 'ol', lines: [] }; }
      cur.lines.push(ol[1]);
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      if (cur?.kind !== 'quote') { flush(); cur = { kind: 'quote', lines: [] }; }
      cur.lines.push(q[1]);
      continue;
    }

    if (cur?.kind !== 'p') { flush(); cur = { kind: 'p', lines: [] }; }
    cur.lines.push(line.trim());
  }
  flush();
  return blocks;
}

/** Markdown を note 用の HTML 文字列にする。 */
export function toNoteHtml(md: string): string {
  return toBlocks(md)
    .map((b) => {
      switch (b.kind) {
        case 'h2':    return `<h2>${inline(b.lines[0])}</h2>`;
        case 'h3':    return `<h3>${inline(b.lines[0])}</h3>`;
        case 'hr':    return '<hr>';
        case 'raw':   return b.lines[0];
        case 'ul':    return `<ul>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`;
        case 'ol':    return `<ol>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</ol>`;
        case 'quote': return `<blockquote>${inline(b.lines.join(' '))}</blockquote>`;
        case 'p':     return `<p>${b.lines.map(inline).join('<br>')}</p>`;
      }
    })
    .filter((s) => s && s !== '<p></p>')
    .join('');
}

/** note の body_length に渡す「タグを除いた文字数」。 */
export function plainLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').length;
}
