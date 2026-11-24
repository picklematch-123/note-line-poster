/**
 * note に送るハッシュタグの形をそろえる（純関数）。
 *
 * ★実測（2026-11-24・自社の note アカウントで試験記事を作り、公開→公開API で確認→削除）:
 *   ・公開（PUT /v1/text_notes/{id}）の `hashtags` は **先頭に「#」を付けた文字列の配列**でないと付かない。
 *     「#」なしの文字列は**エラーにならず黙って捨てられる**（これまで1つも付いていなかった原因）
 *   ・公開API（/api/v3/notes/<key>）の hashtag_notes[].hashtag.name も「#〇〇」の形で返る
 *   ・空白・「_」「-」「!」「?」を含むタグ、「##」で始まるタグも**黙って捨てられる**
 *   ・「・」・全角英数・60字のタグは通った
 *   ・公開済み記事に送り直すと、タグは**送った内容で置き換わる**（足し算ではない）
 *
 * だからここでは「note が黙って捨てる形」を送る前に直しておく。
 */

/** 1記事に付けるタグの上限（生成側のスキーマ上限と同じ。note 側の上限は未確認） */
export const MAX_HASHTAGS = 8;

/** 1つのタグの長さの上限（実測で60字までは通った） */
export const MAX_HASHTAG_LENGTH = 60;

/**
 * タグ名を1つ整える（「#」を付けない名前だけを返す。使えなければ空文字）。
 * ・先頭の「#」「＃」は何個あっても外す
 * ・空白は詰める（note は空白入りのタグを捨てる）
 * ・文字・数字・「・」以外の記号は落とす（「_」「-」「!」「?」入りは捨てられたため）
 */
export function cleanHashtagName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw
    .trim()
    .replace(/^[#＃\s]+/u, '')
    .replace(/[^\p{L}\p{N}\p{M}・]/gu, '');
  return [...name].slice(0, MAX_HASHTAG_LENGTH).join('');
}

/**
 * タグの並びを整える（「#」なしの名前の配列）。
 * 重複（大文字小文字・全角半角の違いだけのものを含む）は先に出たほうを残す。
 */
export function normalizeHashtags(raw: unknown, max = MAX_HASHTAGS): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = cleanHashtagName(item);
    if (!name) continue;
    const key = name.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/** note の公開 API に渡す形（「#名前」の配列）にする。 */
export function toNoteHashtags(raw: unknown, max = MAX_HASHTAGS): string[] {
  return normalizeHashtags(raw, max).map((n) => `#${n}`);
}

/** articles.hashtags_json を読む。壊れていても例外にせず空にする（タグのせいで公開を止めない）。 */
export function parseHashtagsJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    return normalizeHashtags(JSON.parse(json));
  } catch {
    return [];
  }
}

/** 付け直しで1記事に送るタグの上限（既存＋追加。note 側の上限は未確認なので控えめに） */
export const MAX_HASHTAGS_AFTER_MERGE = 10;

/**
 * いま note に付いているタグに、付けたいタグを足した「送る並び」を作る。
 *
 * ★既存タグは**受け取った文字列のまま**送る（整えない。2026-11 源蔵レビュー必須1）。
 *   整えると形が変わる既存タグ（記号入り・「#」なし など）が1つでもあれば unsafe=true を返す。
 *   その記事は送らないこと（送ると、顧客が付けたタグが別物に変わる・消えるおそれがある）。
 * ★置き換えではなく足し算（note は送った並びで置き換えるので、既存タグも必ず一緒に送る）。
 *
 * @returns send … note にそのまま送る並び（既存はそのまま＋足すものは「#名前」）
 *          missing … 今回足すタグ（空なら送り直す必要は無い）
 */
export function mergeHashtags(
  current: readonly string[], desired: unknown, max = MAX_HASHTAGS_AFTER_MERGE,
): { unsafe: boolean; send: string[]; missing: string[] } {
  const unsafe = current.some((c) => {
    if (typeof c !== 'string') return true;
    const name = cleanHashtagName(c);
    return !name || `#${name}` !== c;
  });
  if (unsafe) return { unsafe: true, send: [...current], missing: [] };

  const key = (n: string) => n.normalize('NFKC').toLowerCase();
  const haveKeys = new Set(current.map((c) => key(cleanHashtagName(c))));
  const room = Math.max(0, max - current.length);
  // 上限で入りきらないものは「足せない」ので、足りないものに数えない（無駄に送り直さない）
  const missing = normalizeHashtags(desired).filter((n) => !haveKeys.has(key(n))).slice(0, room);
  return { unsafe: false, send: [...current, ...missing.map((n) => `#${n}`)], missing };
}
