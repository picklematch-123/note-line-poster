/**
 * 事実メモの機械検査（LLM を通さない純関数）。
 *
 * 調査担当の AI が返した「事実メモ」を、記事に使ってよいものだけに絞る。
 *   1. 出典URLが「実際に参照したURL一覧（web_search_call.action.sources）＋引用（url_citation）」に無ければ捨てる
 *      ★P0 実測で gpt-5.5 が参照一覧に無い URL を1件出した（捏造か書き換え）
 *   2. http(s) 以外・ログイン情報つき・短縮URLは捨てる
 *   3. claim の文中の URL・リンク記法・HTML は取り除く（出典は sourceUrl の欄だけから作る）
 *   4. AI への指示のような文（「以前の指示を無視して」など）は捨てる
 *      ★Web 上の文章は信用できない。ページに仕込まれた指示文が、事実メモの形で紛れ込みうる
 *   5. 「調べる先」を限定しているとき、そのドメインに合わない出典は捨てる（2026-10-24 源蔵レビュー）
 *      ★検索側の絞り込み（allowed_domains）だけに頼らない。開いたページの URL や引用は範囲外を指しうる
 *   6. 出典名は OpenAI が返した参照一覧のページ名を使う。AI が書いた名前は使わない（それらしい名前で名乗れるため）
 *   7. 出典 URL は new URL().href の形にそろえて保存する（`HTTPS://` のままだと参考一覧がリンクにならない）
 */
import { z } from 'zod';
import { isSafeSourceUrl, inUrlSet, normalizeUrl, stripUrlsFromText, urlSet } from './urls';

/** 事実メモの最大件数（多いほど本文に混ぜる量と照合の手間が増える） */
export const MAX_FACTS = 8;
/** claim の長さの上限。長文の丸写し（著作権）と、長い指示文の持ち込みを防ぐ */
export const MAX_CLAIM_CHARS = 240;

/** 調査担当の出力の形（検査前） */
export const RawFacts = z.object({
  facts: z.array(z.object({
    id: z.union([z.number(), z.string()]).optional(),
    claim: z.string(),
    sourceUrl: z.string(),
    sourceTitle: z.string().optional().default(''),
  })).max(30),
});
export type RawFacts = z.infer<typeof RawFacts>;

/** 検査を通った事実メモ。id は 1 から振り直す（本文の〔n〕と対応させる） */
export interface VettedFact {
  id: number;
  claim: string;
  sourceUrl: string;
  sourceTitle: string;
}

export type DropReason = 'not_referenced' | 'unsafe_url' | 'off_domain' | 'instruction' | 'empty' | 'duplicate' | 'over_limit';

/** 参照一覧の1件（OpenAI の応答から機械的に取ったもの。title はページ名・無いこともある） */
export type ReferencedUrl = string | { url: string; title?: string };

/**
 * ホストが、調べる先のドメインに入っているか（サフィックス一致）。
 * `go.jp` は `maff.go.jp` を含み、`evilgo.jp` は含まない（ラベルの境目で比べる）。
 * domains が空（調べる先=指定なし）なら常に true。
 */
export function hostInDomains(url: string, domains: readonly string[]): boolean {
  if (!domains.length) return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  return domains.some((d) => {
    const dd = d.toLowerCase().replace(/^\.+|\.$/g, '');
    return host === dd || host.endsWith(`.${dd}`);
  });
}

export interface VetResult {
  facts: VettedFact[];
  dropped: Array<{ reason: DropReason }>;
}

/**
 * AI への指示・誘導らしい文。事実の記述ではありえない言い回しだけを並べる（取りこぼしは、
 * 後段の URL 除去・本文の照合・承認ゲートで受ける）。
 */
const INSTRUCTION_LIKE = new RegExp([
  '(以前|これまで|上記|前)の(指示|命令|ルール|プロンプト)',
  '指示を(無視|忘れ|破棄|上書き)',
  '(無視|忘れ)して(くだ|下)さい',
  'ignore\\s+(all\\s+)?(previous|prior|above)',
  'disregard\\s+(all\\s+)?(previous|prior|above)',
  'system\\s*prompt', 'システムプロンプト',
  'あなたは(今から|これから|AI|アシスタント)',
  '(必ず|かならず)(この|次の|以下の)?(URL|リンク|サイト)',
  '(記事|本文)に(必ず|かならず)',
  '(URL|リンク)を(必ず|かならず)?(記事|本文)?に?(入れ|載せ|貼|掲載)',
  'you\\s+must', 'as\\s+an\\s+ai', 'jailbreak',
  'クリックして', 'こちらをクリック', '今すぐ(登録|購入|申し込)',
].join('|'), 'i');

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_LIKE.test(text);
}

/** タイトルを固定書式に載せられる形にする（記法・改行・URL を落として短く）。空ならホスト名 */
export function cleanTitle(title: string | undefined | null, url: string): string {
  const t = stripUrlsFromText(String(title ?? ''))
    .replace(/[[\]()<>`*_#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (t) return t;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '出典'; }
}

/**
 * 事実メモを検査する。
 * @param referenced 参照したURL一覧＋引用（OpenAI の応答から機械的に取ったもの）
 */
export function vetFacts(
  raw: ReadonlyArray<{ claim: string; sourceUrl: string; sourceTitle?: string }>,
  referenced: Iterable<ReferencedUrl>,
  opts: { allowedDomains?: readonly string[] } = {},
): VetResult {
  const refs = [...referenced].map((r) => (typeof r === 'string' ? { url: r, title: undefined } : r));
  const allowed = urlSet(refs.map((r) => r.url));
  // 参照一覧のページ名（先に出てきたもの＝検索の参照一覧を優先。引用はその後ろに並んでいる）
  const titles = new Map<string, string>();
  for (const r of refs) {
    const key = normalizeUrl(r.url);
    const t = String(r.title ?? '').trim();
    if (key && t && !titles.has(key)) titles.set(key, t);
  }
  const domains = opts.allowedDomains ?? [];
  const facts: VettedFact[] = [];
  const dropped: VetResult['dropped'] = [];
  const seen = new Set<string>();

  for (const f of raw) {
    const url = String(f.sourceUrl ?? '').trim();
    if (!isSafeSourceUrl(url)) { dropped.push({ reason: 'unsafe_url' }); continue; }
    if (!inUrlSet(url, allowed)) { dropped.push({ reason: 'not_referenced' }); continue; }
    if (!hostInDomains(url, domains)) { dropped.push({ reason: 'off_domain' }); continue; }
    // ★指示文の判定は、URL を落とす前の原文と、落とした後の文の両方で行う
    //   （原文: 「このURLを必ず…」を取りこぼさない／後: 「[クリック](URL)して」のように記法で分断された文も拾う）
    const claim = stripUrlsFromText(f.claim).replace(/\s+/g, ' ').trim().slice(0, MAX_CLAIM_CHARS);
    const title = f.sourceTitle ?? '';
    if ([f.claim, claim, title, stripUrlsFromText(title)].some(looksLikeInstruction)) {
      dropped.push({ reason: 'instruction' }); continue;
    }
    if (claim.length < 4) { dropped.push({ reason: 'empty' }); continue; }
    const key = `${claim}|${normalizeUrl(url)}`;
    if (seen.has(key)) { dropped.push({ reason: 'duplicate' }); continue; }
    if (facts.length >= MAX_FACTS) { dropped.push({ reason: 'over_limit' }); continue; }
    seen.add(key);
    const href = new URL(url).href;
    // ★AI が書いたページ名（f.sourceTitle）は使わない。参照一覧にページ名が無ければホスト名にする
    facts.push({ id: facts.length + 1, claim, sourceUrl: href, sourceTitle: cleanTitle(titles.get(normalizeUrl(url) ?? ''), href) });
  }
  return { facts, dropped };
}
