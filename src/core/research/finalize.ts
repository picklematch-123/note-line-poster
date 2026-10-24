/**
 * 最終 Markdown の仕上げ（LLM を通さない純関数）。
 *
 *   1. 本文の〔n〕の目印を拾って取り除く（どの事実メモが使われたかを知るため）
 *   2. 残してよい URL 以外を消す（★源蔵必須2）
 *      残してよいのは「ナレッジの URL」「本人が送ったネタ・修正指示の URL」「検査を通った出典 URL」だけ。
 *      html.ts は裸の URL も自動でリンクにするので、ここで消さないと AI が書いた（または
 *      Web から持ち込まれた）URL がそのままクリックできる形で公開される
 *   3. HTML タグ・画像記法を消す（本文の記法は Markdown の一部だけ。<script> などは要らない）
 *   4. 末尾に「参考にした情報」を固定の書式で付ける（URL は AI に書かせず、検査済みの事実メモから作る）
 *
 * ★generateArticle が保存する直前に必ず通す（調査の有無に関わらず）。
 */
import {
  trimTrailing, urlSet, inUrlSet, extractTextUrls, replaceUrls, stripTagsUntilStable, removeAngleBrackets,
} from './urls';
import type { VettedFact } from './vet';

export const REFERENCES_HEADING = '## 参考にした情報';

/** 〔1〕〔1,2〕〔1・3〕など。半角・全角の数字どちらも */
const MARKER = /[〔［]\s*[0-9０-９]+(?:\s*[,，、・]\s*[0-9０-９]+)*\s*[〕］]/g;

function toHalf(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 目印の番号を拾う（存在する事実メモの番号だけ） */
export function collectCitationIds(markdown: string, factCount: number): number[] {
  const ids = new Set<number>();
  for (const m of markdown.match(MARKER) ?? []) {
    for (const d of toHalf(m).match(/\d+/g) ?? []) {
      const n = Number(d);
      if (n >= 1 && n <= factCount) ids.add(n);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export function stripCitationMarkers(markdown: string): string {
  return markdown.replace(MARKER, '');
}

/**
 * 残してよい URL 以外を消す。
 * ・[表示](URL) は、URL が許可されていれば残し、そうでなければ表示の文字だけ残す
 * ・裸の URL・www. で始まる文字列は、許可されていなければ消す
 * ・HTML タグ（script/style は中身ごと）と画像記法は消す
 */
export function sanitizeArticleMarkdown(markdown: string, allowedUrls: Iterable<string>): string {
  const allowed = urlSet(allowedUrls);
  const kept: string[] = [];
  const hold = (s: string) => `\u0000${kept.push(s) - 1}\u0000`;
  /** スキームは小文字にそろえる（html.ts は小文字の http(s) だけをリンクにする） */
  const lowerScheme = (u: string) => u.replace(/^https?/i, (m) => m.toLowerCase());
  const isAllowed = (u: string) => /^https?:\/\//i.test(u) && !/[<>"'\s]/.test(u) && inUrlSet(u, allowed);
  /** 文中の URL を、許可されたものだけ残して消す（退避はしない。リンクの表示文字用） */
  const scrub = (text: string) => replaceUrls(text, (url, tail) => (isAllowed(url) ? lowerScheme(url) + tail : tail));

  // ★タグと画像記法は「変化しなくなるまで」繰り返し消す（2026-10-24 源蔵レビュー必須1:
  //   `<<figure>figure>` が1回の除去で `<figure>` に組み上がり、html.ts がそのまま通していた）
  let s = markdown.replace(/\u0000/g, '');
  for (let i = 0; i < 20; i++) {
    const next = stripTagsUntilStable(s).replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    if (next === s) break;
    s = next;
  }

  // [表示](URL)。許可されたものは退避して、後の裸URLの処理で壊さない。
  // ★表示の文字に書かれた URL も、許可されていなければ消す（表示だけ別のサイトを名乗る形を作らない）
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_m, text: string, url: string) => {
    const u = trimTrailing(url);
    if (!isAllowed(u)) return text;
    const label = removeAngleBrackets(scrub(text)).trim() || lowerScheme(u);
    return hold(`[${label}](${lowerScheme(u)})`);
  });

  // 裸の URL（大文字のスキーム・スキーム省略の //host・ドメイン＋パス・www. も消す）
  s = replaceUrls(s, (url, tail) => (isAllowed(url) ? hold(lowerScheme(url)) + tail : tail));

  // ★最後に `<` `>` を全部消す（行頭の引用記号だけ残す）。本文に生の HTML は要らない
  //   （画像の figure は、公開の直前に fill が [画像N] から作る）
  s = removeAngleBrackets(s);

  // 中身が空になった括弧・行末の空白
  s = s.replace(/[（(]\s*[）)]/g, '').replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ').replace(/[ \t]+$/gm, '');

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
}

/** URL を Markdown のリンク記法に安全に入れる（html.ts は `)` と空白で URL を切るため） */
function linkSafe(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

/**
 * 出典の見出し（ページ名にドメインを添える）。例: `腰痛対策（www.mhlw.go.jp）`
 * ★ページ名だけだと、それらしい名前で別のサイトを名乗れる。どこのページかを読者が見て分かるようにする
 *   （2026-10-24 源蔵レビュー）。ページ名がドメインそのものなら重ねない
 */
export function referenceLabel(title: string, url: string): string {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* 検査済みの URL なので通常ここには来ない */ }
  const t = title.replace(/[[\]]/g, '').trim();
  if (!host) return t || '出典';
  if (!t || t === host || t === host.replace(/^www\./, '')) return host;
  return `${t}（${host}）`;
}

/** 末尾の「参考にした情報」（固定の書式）。使われた事実メモの出典だけを、同じ URL は1回だけ載せる */
export function buildReferences(facts: VettedFact[], usedIds: number[]): string {
  const used = facts.filter((f) => usedIds.includes(f.id));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of used) {
    // ★URL は new URL().href の形にそろえる（`HTTPS://` のままだと html.ts がリンクにしない）
    let href: string;
    try { href = new URL(f.sourceUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    lines.push(`- [${referenceLabel(f.sourceTitle, href)}](${linkSafe(href)})`);
  }
  return lines.length ? `${REFERENCES_HEADING}\n\n${lines.join('\n')}` : '';
}

/**
 * 「参考にした情報」を付ける位置。
 *
 * ★ナレッジに「記事の文末に『ご予約はコチラから』のリンクを付ける」のような指示があるとき、
 *   その行が最後に来る必要がある（2026-10-24 実機確認で、出典を後ろに付けたため
 *   リンクが文末でなくなった）。最後の段落が「リンク1つだけの行」なら、その手前に出典を入れる。
 */
export function insertReferences(body: string, refs: string): string {
  const lines = body.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  const isLinkOnly = last >= 0 && /^\[[^\]]+\]\([^)\s]+\)[\s！!。]*$/.test(lines[last].trim());
  if (!isLinkOnly) return `${body}\n\n${refs}\n`;
  const head = lines.slice(0, last).join('\n').trimEnd();
  return `${head}\n\n${refs}\n\n${lines[last].trim()}\n`;
}

export interface FinalizeInput {
  markdown: string;
  facts: VettedFact[];
  /** 本人が書いたもの（ナレッジの原文・ネタ・修正指示）。ここにある URL は残してよい */
  trustedTexts: Array<string | null | undefined>;
}

export interface FinalizeOutput {
  /** 「参考にした情報」を付ける前の本文（照合はこちらに対して行う） */
  body: string;
  /** 最終 Markdown（保存・公開するもの） */
  markdown: string;
  usedIds: number[];
  referenceCount: number;
}

export function finalizeArticle(input: FinalizeInput): FinalizeOutput {
  const usedIds = collectCitationIds(input.markdown, input.facts.length);
  const trustedUrls = input.trustedTexts.flatMap((t) => (t ? extractTextUrls(t) : []));
  const allowed = [...trustedUrls, ...input.facts.map((f) => f.sourceUrl)];
  // ★AI が自分で「参考文献」の節を書いた場合も、許可されていない URL はここで消える
  const body = sanitizeArticleMarkdown(stripCitationMarkers(input.markdown), allowed).trimEnd();
  const refs = buildReferences(input.facts, usedIds);
  const referenceCount = refs ? refs.split('\n').filter((l) => l.startsWith('- ')).length : 0;
  return { body, markdown: refs ? insertReferences(body, refs) : `${body}\n`, usedIds, referenceCount };
}
