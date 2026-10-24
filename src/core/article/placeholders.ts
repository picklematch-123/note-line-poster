/**
 * 本文中の画像プレースホルダの解析と移動。
 *   写真（LINE で送られた画像）= `[画像N]`
 *   AI が作った文中画像（P3）    = `[AI画像N]`
 *
 * ★ここは LLM を一切使わない決定的な純関数として書く。
 *   - 位置修正が数秒で終わる（本文を再生成しない）
 *   - 顧客の API 費用がかからない
 *   - ユニットテストで守れる
 *
 * ★2つの系統を別の目印にした理由（設計書 18-2）: 写真の後ろの番号を続けて使うと、確認待ちの間に写真が
 *   1枚増えただけで対応がずれ、AI 画像の位置に写真が入る。normalize は写真の枚数で番号を詰めるので、
 *   同じ目印だと生成画像の目印が消える・増える事故が起きる。
 *   各関数は「目印の種類」を引数に取り、既定は写真。既存の呼び出し（写真だけ）は今までと同じ動きのまま。
 *   ★正規表現は互いにぶつからない（`\[画像` は `[AI画像` の中に一致しない。`[` の直後が `画像` でないため）
 */

export const PLACEHOLDER_RE = /\[画像(\d+)\]/g;
/** AI が作った文中画像の目印 */
export const GENERATED_PLACEHOLDER_RE = /\[AI画像(\d+)\]/g;

export type PlaceholderKind = 'photo' | 'generated';

const LABEL: Record<PlaceholderKind, string> = { photo: '画像', generated: 'AI画像' };

/** 目印の文字列（`[画像3]` / `[AI画像1]`） */
export function placeholderToken(index: number, kind: PlaceholderKind = 'photo'): string {
  return `[${LABEL[kind]}${index}]`;
}

function reOf(kind: PlaceholderKind): RegExp {
  return kind === 'photo' ? PLACEHOLDER_RE : GENERATED_PLACEHOLDER_RE;
}

export interface Placeholder {
  /** [画像N] の N */
  index: number;
  /** 本文を行分割したときの行番号（0始まり） */
  line: number;
  /** 直前の見出し（無ければ null） */
  heading: string | null;
  /** 直前の見出しが何番目か（0始まり、無ければ -1） */
  headingIndex: number;
}

export interface Heading {
  /** 見出しテキスト（記号を除く） */
  text: string;
  /** 見出しレベル（2 or 3） */
  level: number;
  line: number;
}

/** 本文中の見出しを列挙する。 */
export function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  md.split('\n').forEach((raw, line) => {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(raw);
    if (m) out.push({ level: m[1].length, text: m[2], line });
  });
  return out;
}

/** 本文中のプレースホルダを列挙する。 */
export function parse(md: string, kind: PlaceholderKind = 'photo'): Placeholder[] {
  const headings = parseHeadings(md);
  const out: Placeholder[] = [];
  md.split('\n').forEach((raw, line) => {
    for (const m of raw.matchAll(reOf(kind))) {
      let headingIndex = -1;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].line < line) headingIndex = i;
        else break;
      }
      out.push({
        index: Number(m[1]),
        line,
        heading: headingIndex >= 0 ? headings[headingIndex].text : null,
        headingIndex,
      });
    }
  });
  return out;
}

/** 指定番号のプレースホルダを本文から取り除く（空行になった行ごと消す）。 */
function stripPlaceholder(md: string, index: number, kind: PlaceholderKind): string {
  const re = new RegExp(`\\[${LABEL[kind]}${index}\\]`, 'g');
  return md
    .split('\n')
    .map((line) => (re.test(line) ? line.replace(re, '').trimEnd() : line))
    .filter((line, i, arr) => {
      // プレースホルダのみの行が空になった場合は削除する
      if (line !== '') return true;
      const prev = arr[i - 1];
      const next = arr[i + 1];
      // 連続した空行にならないよう、片方が空なら落とす
      return !(prev === '' || next === '');
    })
    .join('\n');
}

/**
 * プレースホルダを指定の見出しの直下へ移動する。
 * @param headingIndex 0始まり。範囲外なら末尾に置く。
 */
export function move(md: string, index: number, headingIndex: number, kind: PlaceholderKind = 'photo'): string {
  const token = placeholderToken(index, kind);
  if (!parse(md, kind).some((p) => p.index === index)) {
    throw new Error(`${token} は本文にありません`);
  }

  const stripped = stripPlaceholder(md, index, kind);
  const headings = parseHeadings(stripped);
  const lines = stripped.split('\n');

  if (headings.length === 0 || headingIndex < 0) {
    return [...lines, '', token].join('\n');
  }
  const target = headings[Math.min(headingIndex, headings.length - 1)];
  lines.splice(target.line + 1, 0, '', token);
  return lines.join('\n');
}

/** 2つのプレースホルダの位置を入れ替える。 */
export function swap(md: string, a: number, b: number, kind: PlaceholderKind = 'photo'): string {
  const A = placeholderToken(a, kind);
  const B = placeholderToken(b, kind);
  // ★写真の目印 `[画像1]` は `[AI画像1]` の部分文字列ではない（`[` の位置が違う）ので、split で混ざらない
  if (!md.includes(A) || !md.includes(B)) {
    throw new Error(`${A} または ${B} が本文にありません`);
  }
  const TMP = '__SWAP_TMP__';
  return md.split(A).join(TMP).split(B).join(A).split(TMP).join(B);
}

/** プレースホルダを取り除く。 */
export function remove(md: string, index: number, kind: PlaceholderKind = 'photo'): string {
  return stripPlaceholder(md, index, kind);
}

/** 出現順に 1,2,3... へ振り直す。 */
export function renumber(md: string, kind: PlaceholderKind = 'photo'): string {
  let n = 0;
  return md.replace(reOf(kind), () => placeholderToken(++n, kind));
}

/**
 * 実際に送られた画像枚数と本文中のプレースホルダ数を突き合わせて整える。
 * - 画像が多い   → 余りを末尾の見出し直下に順に追加
 * - 画像が少ない → 余分なプレースホルダを削除
 * ★写真だけを扱う（`[AI画像N]` には触らない）。
 */
export function normalize(md: string, imageCount: number): string {
  let out = renumber(md);
  let current = parse(out).length;

  while (current > imageCount) {
    out = remove(out, current);
    current--;
  }

  if (current < imageCount) {
    const headings = parseHeadings(out);
    const lines = out.split('\n');
    const extras: string[] = [];
    for (let i = current + 1; i <= imageCount; i++) extras.push('', `[画像${i}]`);
    if (headings.length > 0) {
      lines.splice(headings[headings.length - 1].line + 1, 0, ...extras);
      out = lines.join('\n');
    } else {
      out = [...lines, ...extras].join('\n');
    }
  }
  return renumber(out);
}

/**
 * 生成直後の本文（`[画像1]`〜`[画像k+m]`）を、写真 k 枚と AI 画像 m 枚に分ける（設計書 18-2）。
 * 出現順で前から k 個を写真（`[画像1]`〜`[画像k]`）、k+1 個目以降を `[AI画像1]`〜 に書き換える。
 * ★LLM を通さない。保存の直前に1回だけ呼ぶ。
 * ★本文にすでに `[AI画像N]` があれば（AI が勝手に書いた・ネタに書かれていた）先に消す。
 *   番号の出どころをこの関数1つにするため。
 */
export function splitGeneratedPlaceholders(md: string, photoCount: number): string {
  let out = md;
  for (const p of [...parse(out, 'generated')].reverse()) out = remove(out, p.index, 'generated');
  let n = 0;
  return out.replace(PLACEHOLDER_RE, () => {
    n++;
    return n <= photoCount ? placeholderToken(n, 'photo') : placeholderToken(n - photoCount, 'generated');
  });
}

/**
 * `[画像N]`（または `[AI画像N]`）を note の画像URLに差し替える。
 * URL が無い番号のプレースホルダは削除する。
 *
 * ★alt は note 側でそのまま保持されることを実測で確認済み（SEO・アクセシビリティ両面で有効）。
 */
export function fill(
  md: string,
  urls: Record<number, string>,
  alts: Record<string, string> = {},
  kind: PlaceholderKind = 'photo',
): string {
  return md.replace(reOf(kind), (_m, n) => {
    const url = urls[Number(n)];
    if (!url) return '';
    const alt = alts[String(n)];
    const altAttr = alt ? ` alt="${escapeAttr(alt)}"` : '';
    return `<figure><img src="${url}"${altAttr}></figure>`;
  });
}

/** 属性値に入れても壊れないようにする。 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
