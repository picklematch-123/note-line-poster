/**
 * 本文の照合（LLM を通さない純関数・★源蔵必須3）。
 *
 * 本文に出てくる数字と固有名詞らしい語が、「事実メモ・元ネタ・ナレッジ」のどれかに書かれているかを調べる。
 * 書かれていないものは**落とさず**、プレビューに「要確認」の印を付けて人が判断する（オーナー 承認 2026-10-24）。
 *   ★本物の URL に偽の主張がつく捏造（出典は実在するのに中身が違う）は、URL の検査では防げない。
 *     数字・固有名詞の出どころを機械で確かめるのが、いちばん安い歯止め。
 * ★判定は簡易（語の切り出しは正規表現）。取りこぼしと誤検知の両方がありうる。最後は承認ボタンの前に人が見る。
 */

export interface UnverifiedTerm {
  term: string;
  kind: 'number' | 'name';
  /** 本文の該当箇所の抜粋（前後を少し） */
  excerpt: string;
  /**
   * 印の理由。unsupported = 事実メモ・ネタ・ナレッジのどこにも無い（既定・省略時もこれ）／
   * miscited = 〔n〕を付けた文の語が、メモ n に無い（出典の付け違い・中身のすり替え）
   */
  reason?: 'unsupported' | 'miscited';
}

export interface VerifyResult {
  flags: UnverifiedTerm[];
  /** 見つかった件数の合計（表示は先頭の数件だけ） */
  total: number;
}

/** 数字の後ろに付く単位。ここに無い単位は数字だけで照合する */
const UNIT = '(?:%|％|パーセント|万円|億円|円|万人|万件|万|億|人|件|歳|才|年|か月|ヶ月|カ月|月|日|時間|分|秒|kg|mg|g|km|cm|mm|ml|mL|m|L|倍|割|回|杯|個|本|種類|kcal|cal|度|℃)';
/** 小さい数でも照合する単位（量・割合・お金）。「1日」「3回」「5分」のような言い回しは数えない */
const MEASURE_UNIT = /^(%|％|パーセント|万円|億円|円|万人|万件|万|億|kg|mg|g|km|cm|mm|ml|mL|L|倍|割|kcal|cal|度|℃)$/;
const NUMBER = new RegExp(`(\\d+(?:[.,]\\d+)*)\\s*(${UNIT})?`, 'g');

/** よく使うカタカナ語（固有名詞ではない）。外しても「要確認」が増えるだけなので、代表的なものだけ */
const COMMON_KATAKANA = new Set([
  'ポイント', 'メリット', 'デメリット', 'ストレス', 'バランス', 'チェック', 'スタート', 'リラックス', 'イメージ',
  'サポート', 'タイミング', 'スタッフ', 'メニュー', 'サービス', 'スケジュール', 'コミュニケーション', 'アドバイス',
  'ストレッチ', 'トレーニング', 'エネルギー', 'リスク', 'ケース', 'パターン', 'スタイル', 'テーマ', 'シーン',
  'コツ', 'ステップ', 'プロセス', 'システム', 'ルール', 'マナー', 'アイデア', 'アイディア', 'ヒント', 'カテゴリー',
  'ユーザー', 'オーナー', 'グループ', 'チーム', 'メンバー', 'パートナー', 'コミュニティ', 'イベント', 'キャンペーン',
  'プラン', 'コース', 'レッスン', 'セミナー', 'オンライン', 'オフライン', 'インターネット', 'スマートフォン', 'スマホ',
  'パソコン', 'アプリ', 'ホームページ', 'サイト', 'ページ', 'ブログ', 'コンテンツ', 'メッセージ', 'メール', 'リンク',
  'デスクワーク', 'ウォーキング', 'ランニング', 'ジョギング', 'リフレッシュ', 'モチベーション', 'コンディション',
  'カロリー', 'タンパク質', 'ビタミン', 'ミネラル', 'バランス', 'リズム', 'ペース', 'レベル', 'クオリティ', 'スペース',
  'エリア', 'スポット', 'ショップ', 'カフェ', 'レストラン', 'ランチ', 'ディナー', 'デザート', 'ドリンク', 'コーヒー',
  'スイーツ', 'フルーツ', 'アイスクリーム', 'サイズ', 'カラー', 'デザイン', 'アイテム', 'グッズ', 'プレゼント',
  'ギフト', 'セット', 'オプション', 'プライベート', 'ビジネス', 'マーケティング', 'ブランド', 'ターゲット', 'ニーズ',
  'トラブル', 'メンテナンス', 'ケア', 'セルフケア', 'ホッと', 'ワクワク', 'ドキドキ', 'ゆったり', 'リピーター',
  'フォロー', 'フォロワー', 'シェア', 'コメント', 'ハッシュタグ', 'プロフィール', 'スキル', 'キャリア', 'ライフスタイル',
]);
const COMMON_LATIN = new Set(['SEO', 'OK', 'NG', 'LINE', 'SNS', 'AI', 'PC', 'URL', 'FAQ', 'DIY', 'PR', 'Q', 'A', 'Web', 'WEB', 'TV', 'DM', 'QR']);

const KATAKANA = /[ァ-ヴ][ァ-ヴー・]{3,}/g;
const LATIN = /\b[A-Z][A-Za-z0-9&'\-]{1,}\b/g;
const ORG = /[一-龠々ァ-ヴーA-Za-z0-9]{2,}(?:大学病院|大学|省|庁|協会|学会|研究所|研究センター|病院|機構|財団|センター|クリニック|組合|連盟)|株式会社[一-龠々ァ-ヴーA-Za-z0-9]{2,}/g;

function norm(s: string): string {
  return s.normalize('NFKC').replace(/[\s,，]/g, '').toLowerCase();
}

/** 照合の対象にする本文（見出しは残す。画像の目印・リンクの URL・URL は外す） */
function plainBody(markdown: string): string {
  return markdown
    .replace(/\[画像\d+\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .normalize('NFKC');
}

function excerptAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 15);
  const end = Math.min(text.length, index + len + 15);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** 照合する元（事実メモ・ネタ・ナレッジ）から、数字の集合を作る */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g)) out.add(m[0].replace(/,/g, ''));
  return out;
}

interface Term { term: string; kind: 'number' | 'name'; index: number; length: number; core?: string }

/** 照合の対象になる語（数字・組織名・カタカナ語・英字の固有名詞）を、本文の位置つきで拾う（同じ語は1回） */
function extractTerms(body: string): Term[] {
  const out: Term[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(NUMBER)) {
    const core = m[1].replace(/,/g, '');
    const unit = m[2] ?? '';
    const value = Number(core);
    if (!Number.isFinite(value)) continue;
    if (value < 10 && !MEASURE_UNIT.test(unit)) continue;
    const term = `${m[1]}${unit}`;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push({ term, kind: 'number', index: m.index ?? 0, length: m[0].length, core });
  }

  // 組織名（〜大学・〜省など）を先に見て、その中のカタカナ・英字は二重に数えない
  const names: Array<{ term: string; index: number }> = [];
  const covered: Array<[number, number]> = [];
  for (const re of [ORG, KATAKANA, LATIN]) {
    for (const m of body.matchAll(re)) {
      const i = m.index ?? 0;
      if (covered.some(([s, e]) => i >= s && i < e)) continue;
      if (re === ORG) covered.push([i, i + m[0].length]);
      names.push({ term: m[0], index: i });
    }
  }
  for (const { term, index } of names) {
    const t = term.replace(/・+$/, '');
    if (seen.has(t)) continue;
    seen.add(t);
    if (COMMON_KATAKANA.has(t) || COMMON_LATIN.has(t)) continue;
    out.push({ term: t, kind: 'name', index, length: t.length });
  }
  return out;
}

/** 語が照合元（数字の集合・正規化した文）にあるか */
function supported(t: Term, numbers: Set<string>, corpus: string): boolean {
  return t.kind === 'number' ? numbers.has(t.core ?? '') : corpus.includes(norm(t.term));
}

export function findUnverifiedTerms(markdown: string, sources: Array<string | null | undefined>, maxFlags = 5): VerifyResult {
  const corpusText = sources.filter(Boolean).join('\n');
  const corpus = norm(corpusText);
  const corpusNumbers = numbersIn(corpusText);
  const body = plainBody(markdown);
  const found = extractTerms(body)
    .filter((t) => !supported(t, corpusNumbers, corpus))
    .map((t) => ({ term: t.term, kind: t.kind, index: t.index, excerpt: excerptAround(body, t.index, t.length) }));
  found.sort((a, b) => a.index - b.index);
  return { flags: found.slice(0, maxFlags).map(({ term, kind, excerpt }) => ({ term, kind, excerpt })), total: found.length };
}

/** 〔1〕〔1,2〕など（finalize.ts と同じ形） */
const MARKER = /[〔［]\s*[0-9０-９]+(?:\s*[,，、・]\s*[0-9０-９]+)*\s*[〕］]/g;
/**
 * 文の切り出し。文末の記号の後ろに続く〔n〕も、その文に含める（「…です。〔1〕」と「…です〔1〕。」の両方）。
 */
const SENTENCE = /[^。！？!?\n]+[。！？!?]*(?:\s*[〔［]\s*[0-9０-９]+(?:\s*[,，、・]\s*[0-9０-９]+)*\s*[〕］])*/g;

/**
 * 出典の付け違いの照合（★2026-10-24 源蔵レビュー）。
 * 〔n〕を付けた文に出てくる数字・固有名詞が、**メモ n**（複数なら、そのどれか）に書かれているかを調べる。
 * 書かれていなければ「要確認」（reason='miscited'）。ほかのメモやナレッジにあっても、メモ n に無ければ印を付ける
 * （本物の出典に、別の中身を付けて見せる形を拾うため）。
 * @param markdown 〔n〕の目印を消す前の本文
 */
export function findMiscitedTerms(
  markdown: string, facts: ReadonlyArray<{ id: number; claim: string; sourceTitle?: string }>, maxFlags = 5,
): VerifyResult {
  const byId = new Map(facts.map((f) => [f.id, `${f.claim}\n${f.sourceTitle ?? ''}`]));
  const found: UnverifiedTerm[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split('\n')) {
    for (const m of line.matchAll(SENTENCE)) {
      const sentence = m[0];
      const ids = new Set<number>();
      for (const mk of sentence.match(MARKER) ?? []) {
        for (const d of mk.normalize('NFKC').match(/\d+/g) ?? []) ids.add(Number(d));
      }
      const memo = [...ids].map((id) => byId.get(id)).filter((x): x is string => Boolean(x)).join('\n');
      if (!memo) continue; // 目印が無い文・存在しない番号は、ここでは見ない（全体の照合が受ける）
      const body = plainBody(sentence.replace(MARKER, ''));
      const numbers = numbersIn(memo);
      const corpus = norm(memo);
      for (const t of extractTerms(body)) {
        if (supported(t, numbers, corpus) || seen.has(t.term)) continue;
        seen.add(t.term);
        found.push({ term: t.term, kind: t.kind, excerpt: excerptAround(body, t.index, t.length), reason: 'miscited' });
      }
    }
  }
  return { flags: found.slice(0, maxFlags), total: found.length };
}

/** 2つの照合の結果をまとめる（同じ語は1回。先に渡したほうを残す） */
export function mergeVerifyResults(a: VerifyResult, b: VerifyResult, maxFlags = 5): VerifyResult {
  const terms = new Set(a.flags.map((f) => f.term));
  const extra = b.flags.filter((f) => !terms.has(f.term));
  const hiddenDup = b.total - b.flags.length; // 表示外の件数は重なりを確かめられないので、そのまま足す
  return { flags: [...a.flags, ...extra].slice(0, maxFlags), total: a.total + extra.length + Math.max(0, hiddenDup) };
}
