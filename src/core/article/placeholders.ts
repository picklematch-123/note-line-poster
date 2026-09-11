/**
 * 本文中の画像プレースホルダ `[画像N]` の解析と移動。
 *
 * ★ここは LLM を一切使わない決定的な純関数として書く。
 *   - 位置修正が数秒で終わる（本文を再生成しない）
 *   - 顧客の API 費用がかからない
 *   - ユニットテストで守れる
 */

export const PLACEHOLDER_RE = /\[画像(\d+)\]/g;

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
export function parse(md: string): Placeholder[] {
  const headings = parseHeadings(md);
  const out: Placeholder[] = [];
  md.split('\n').forEach((raw, line) => {
    for (const m of raw.matchAll(PLACEHOLDER_RE)) {
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
function stripPlaceholder(md: string, index: number): string {
  const re = new RegExp(`\\[画像${index}\\]`, 'g');
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
export function move(md: string, index: number, headingIndex: number): string {
  if (!parse(md).some((p) => p.index === index)) {
    throw new Error(`[画像${index}] は本文にありません`);
  }

  const stripped = stripPlaceholder(md, index);
  const headings = parseHeadings(stripped);
  const lines = stripped.split('\n');

  if (headings.length === 0 || headingIndex < 0) {
    return [...lines, '', `[画像${index}]`].join('\n');
  }
  const target = headings[Math.min(headingIndex, headings.length - 1)];
  lines.splice(target.line + 1, 0, '', `[画像${index}]`);
  return lines.join('\n');
}

/** 2つのプレースホルダの位置を入れ替える。 */
export function swap(md: string, a: number, b: number): string {
  const A = `[画像${a}]`;
  const B = `[画像${b}]`;
  if (!md.includes(A) || !md.includes(B)) {
    throw new Error(`[画像${a}] または [画像${b}] が本文にありません`);
  }
  const TMP = '__SWAP_TMP__';
  return md.split(A).join(TMP).split(B).join(A).split(TMP).join(B);
}

/** プレースホルダを取り除く。 */
export function remove(md: string, index: number): string {
  return stripPlaceholder(md, index);
}

/** 出現順に 1,2,3... へ振り直す。 */
export function renumber(md: string): string {
  let n = 0;
  return md.replace(PLACEHOLDER_RE, () => `[画像${++n}]`);
}

/**
 * 実際に送られた画像枚数と本文中のプレースホルダ数を突き合わせて整える。
 * - 画像が多い   → 余りを末尾の見出し直下に順に追加
 * - 画像が少ない → 余分なプレースホルダを削除
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
 * `[画像N]` を note の画像URLに差し替える。
 * URL が無い番号のプレースホルダは削除する。
 *
 * ★alt は note 側でそのまま保持されることを実測で確認済み（SEO・アクセシビリティ両面で有効）。
 */
export function fill(
  md: string,
  urls: Record<number, string>,
  alts: Record<string, string> = {},
): string {
  return md.replace(PLACEHOLDER_RE, (_m, n) => {
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
