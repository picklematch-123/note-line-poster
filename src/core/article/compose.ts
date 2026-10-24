/**
 * 公開する本文（Markdown）の組み立て。サーバー公開・下書き保存・拡張の手順書・公開前のリンク検査が
 * すべてここを通る（★組み立てを1か所にする。ずれると「拡張だと崩れる」「検査した本文と送る本文が違う」が起きる）。
 *
 *   1. 写真の目印を枚数に合わせて整える（normalize・今までどおり）
 *   2. 写真の `[画像N]` を画像に差し替える（今までどおり）
 *   3. AI が作った文中画像の `[AI画像N]` を画像に差し替える（P3）。画像が無い番号は消える（壊れた画像は出さない）
 *   4. AI 画像が1枚でも本文に入ったときだけ、末尾に「AIで作成したイメージです」の1行を足す（設計書 18-10 の5）
 *
 * ★LLM を通さない純関数。
 */
import { fill, normalize, parse } from './placeholders';
import { insertReferences } from '../research/finalize';

export interface GeneratedFill {
  /** note に上げた画像の URL（拡張の手順書では目印 `{{image(100+N)_url}}`） */
  url: string;
  alt?: string | null;
}

export interface ComposeInput {
  bodyMd: string;
  photoCount: number;
  photoUrls: Record<number, string>;
  photoAlts: Record<string, string>;
  /** AI 画像の番号 → 画像。無ければ AI 画像は入らない */
  generated?: Record<number, GeneratedFill>;
}

/**
 * AI 作成の明示（★景表法・note の扱いが未確認のうちは安全側。設計書 18-3）。
 * 写真と混ざるときは「一部の画像は」、AI 画像だけなら「画像は」と書き分ける（写真まで AI 製と読ませない）。
 */
export function aiImageNote(hasPhotos: boolean): string {
  return hasPhotos
    ? '※記事中の一部の画像は、AIで作成したイメージです。'
    : '※記事中の画像は、AIで作成したイメージです。';
}

/** 公開する Markdown を組み立てる */
export function composeArticleMarkdown(input: ComposeInput): string {
  let md = normalize(input.bodyMd, input.photoCount);
  const hasPhotos = parse(md).some((p) => Boolean(input.photoUrls[p.index]));
  md = fill(md, input.photoUrls, input.photoAlts);

  const gen = input.generated ?? {};
  const placed = parse(md, 'generated').filter((p) => Boolean(gen[p.index]?.url));
  const urls: Record<number, string> = {};
  const alts: Record<string, string> = {};
  for (const [slot, g] of Object.entries(gen)) {
    if (!g?.url) continue;
    urls[Number(slot)] = g.url;
    if (g.alt) alts[slot] = g.alt;
  }
  md = fill(md, urls, alts, 'generated');

  // ★1枚も入らなかった（生成に失敗・0枚設定）ときは足さない。入っていないのに「AIで作成」と書かない
  if (placed.length === 0) return md;
  // 「文末に予約リンク」などナレッジの指示を壊さないよう、最後がリンク1行ならその手前に入れる（出典一覧と同じ）
  return insertReferences(md.replace(/\s+$/, ''), aiImageNote(hasPhotos));
}
