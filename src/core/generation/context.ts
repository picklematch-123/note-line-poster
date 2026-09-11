/**
 * 溜めたナレッジを、生成プロンプトに差し込む文字列へ組み立てる。
 *
 * ★考え方: 要約は「必要になってから」かける。
 *   メモが短いうちは**原文をそのまま渡すのが一番正確**で、費用もほとんど変わらない。
 *   長くなってきて初めて、AIが整理したもの（digest）に切り替える。
 *
 * ★決まりごとと URL は、どちらの場合でも**原文から機械的に拾い直して**付ける。
 *   要約に混ぜると落ちるため（「文末にリンクを貼ること」が効かなかった
 *   2026-08-29 の不具合はこれが原因）。ここは LLM を通さない。
 */

/** 文中の URL。日本語は URL の直後に句読点や閉じ括弧が続くので、それらは含めない。 */
const URL_RE = /https?:\/\/[^\s<>"'（）()「」『』【】、。，．…]+/g;

/** URL の節の見出し。ここを目印に、二重に足さないようにする。 */
const URL_HEADING = '【記事で使うURL】';

/**
 * 原文をそのまま渡す上限（文字数）。
 * これを超えたら、AIが整理したもの（digest）だけに切り替える。
 *
 * ★4つの生成ステップすべてに差し込まれるので、丸ごと渡せるのはこの辺まで。
 *   1500字 ≒ 750トークン × 4ステップ ≒ 3000トークン（記事1本で1円未満）。
 */
export const RAW_PASSTHROUGH_LIMIT = 1500;

/** URL の末尾にくっついた句読点・閉じ括弧を落とす。 */
function trimTrailing(url: string): string {
  return url.replace(/[.,!?:;）)」』】＞>]+$/, '');
}

/**
 * 本人が書いた文章から URL を拾う。
 * 同じ URL は1回だけ、書かれた順に返す。
 */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    const url = trimTrailing(raw);
    // スキームだけ、ホスト名が無いものは捨てる
    if (!/^https?:\/\/[^/\s]+/.test(url)) continue;
    seen.add(url);
  }
  return [...seen];
}

/**
 * 溜めたメモを1件ずつに分ける。
 * 送るたびに空行区切りで積み増しているので、その区切りで数える。
 */
export function listEntries(rawText: string): string[] {
  return rawText
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 指定した番号（1始まり）のメモを取り除く。範囲外なら何も変えない。 */
export function removeEntry(rawText: string, index: number): string {
  const entries = listEntries(rawText);
  if (index < 1 || index > entries.length) return rawText;
  entries.splice(index - 1, 1);
  return entries.join('\n\n');
}

export interface AnalyzedContext {
  /** AI が整理した本文 */
  digest: string;
  /** 呼び方・言い回しの指定 */
  wording?: string[];
  /** 本人が明示した「必ず守ること」。原文のまま */
  rules?: string[];
  /** 書いてほしくないこと */
  avoid?: string[];
}

function urlBlock(urls: string[]): string {
  return (
    URL_HEADING + '\n' +
    '★以下は本人が指定したURLです。**一字一句そのまま**使ってください。\n' +
    '　省略・短縮・改変をしない。ここに無いURLを作らない。\n' +
    urls.map((u) => `- ${u}`).join('\n')
  );
}

/**
 * 生成プロンプトに差し込む最終形を作る。
 *
 * 　1. AI が整理した本文
 * 　2. 原文（短いうちだけ。要約による取りこぼしをそもそも起こさない）
 * 　3. 決まりごと・書かないこと（原文のまま）
 * 　4. URL（原文から機械的に抽出）
 */
export function buildContextSnippet(rawText: string, analyzed: AnalyzedContext): string {
  const parts: string[] = [analyzed.digest.trim()];

  const wording = (analyzed.wording ?? []).map((w) => w.trim()).filter(Boolean);
  if (wording.length > 0) {
    parts.push('【言い方の指定】\n' + wording.map((w) => `- ${w}`).join('\n'));
  }

  // まだ短いうちは、原文をそのまま渡すのが一番確実
  const raw = rawText.trim();
  if (raw.length > 0 && raw.length <= RAW_PASSTHROUGH_LIMIT) {
    parts.push('【本人のメモ（原文）】\n' + raw);
  }

  const rules = (analyzed.rules ?? []).map((r) => r.trim()).filter(Boolean);
  const avoid = (analyzed.avoid ?? []).map((r) => r.trim()).filter(Boolean);
  if (rules.length > 0 || avoid.length > 0) {
    parts.push(
      '【必ず守ること（本人が書いた指示）】\n' +
      [...rules.map((r) => `- ${r}`), ...avoid.map((a) => `- ${a}（書かない）`)].join('\n'),
    );
  }

  const urls = extractUrls(rawText);
  if (urls.length > 0) parts.push(urlBlock(urls));

  return parts.join('\n\n');
}

/**
 * 保存済みの差し込み文に、原文の URL が欠けていれば足す。
 *
 * ★以前に登録されたメモは、URL が要約から落ちたまま保存されている。
 *   登録し直してもらわなくても効くように、読み出すたびに補う。
 *   すでに入っていれば何もしない（何度通しても結果は同じ）。
 */
export function ensureContextUrls(rawText: string | null, snippet: string | null): string | null {
  if (!snippet) return snippet;
  const urls = extractUrls(rawText ?? '');
  if (urls.length === 0) return snippet;

  const missing = urls.filter((u) => !snippet.includes(u));
  if (missing.length === 0) return snippet;

  return snippet.includes(URL_HEADING)
    ? `${snippet}\n${missing.map((u) => `- ${u}`).join('\n')}`
    : `${snippet}\n\n${urlBlock(missing)}`;
}
