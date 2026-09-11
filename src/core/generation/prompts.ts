/**
 * 記事生成のプロンプト。
 *
 * スタイルプロファイル（その人の文体・思考プロセス）があれば全ステップに差し込む。
 * ここが「AIが書いた記事」と「その人が書いた記事」の分かれ目になる。
 */
import type { KeywordAnalysis, Outline } from './schema';

/**
 * 事業コンテキストの差し込み。
 * ★これが記事の「中身」を決める。文体より効く。
 *   例: 「焼き鳥屋を経営」が分かれば、黒ごまアイスの記事は
 *       第三者の実食レビューではなく「うちの店で出すデザート」の話になる。
 */
function contextBlock(snippet?: string | null): string {
  if (!snippet) return '';
  return `
【この記事を書く人について】
記事はこの人の立場で書きます。第三者の紹介記事にしないこと。
ここに書かれた決まりごとと URL は、要約せずそのまま守ること。

${snippet}
`;
}

/** スタイルプロファイルの差し込み。無ければ空文字（＝汎用の書き方になる）。 */
function styleBlock(snippet?: string | null): string {
  if (!snippet) return '';
  return `
【書き手の文体・思考の癖】
以下は、この記事の書き手が過去に書いたものから抽出した特徴です。
**内容の正しさより優先はしませんが、文章の見た目と運びは必ずこれに寄せてください。**
一般的な「AIっぽい優等生の文章」にしないこと。

${snippet}
`;
}

const COMMON = `あなたは日本語のSEO記事を書くプロの編集者兼ライターです。
検索エンジンにも読者にも評価される記事を作ります。

守ること:
- キーワードの不自然な詰め込みをしない。読んで自然な日本語を最優先する
- 主キーワードは、タイトル・リード文・見出しのどれかに自然な形で入れる。
  同じ語を機械的に繰り返さず、言い換えや関連語で自然に広げる
- 中身のない一般論・水増しを書かない。具体を書く
- 断定できないことを断定しない
- 薬機法・景表法に触れる表現（効果効能の断定、最上級表現）を避ける`;

export const analyzeKeywords = {
  system: COMMON,
  user: (sourceText: string, hintKeywords: string[], style?: string | null, context?: string | null) => `
次のネタから、SEO記事にするためのキーワード設計をしてください。
${contextBlock(context)}${styleBlock(style)}
【ネタ】
${sourceText}

${hintKeywords.length ? `【指定キーワード】\n${hintKeywords.join(', ')}\n` : ''}
次のJSONで出力してください:
{
  "primaryKeyword": "狙う主キーワード",
  "secondaryKeywords": ["関連キーワード", "..."],
  "searchIntent": "読者がこのキーワードで検索するとき、本当に知りたいこと",
  "targetReader": "想定読者像（状況・悩み・知識レベル）",
  "competitorAngle": "既存記事にありがちな型と、この記事でどう差をつけるか"
}`.trim(),
};

export const buildOutline = {
  system: COMMON,
  user: (sourceText: string, kw: KeywordAnalysis, imageCount: number, style?: string | null, context?: string | null) => `
以下の設計に基づいて、記事の構成を作ってください。
${contextBlock(context)}${styleBlock(style)}
【ネタ】
${sourceText}

【キーワード設計】
主キーワード: ${kw.primaryKeyword}
関連キーワード: ${kw.secondaryKeywords.join(', ')}
検索意図: ${kw.searchIntent}
想定読者: ${kw.targetReader}
差別化方針: ${kw.competitorAngle}

【画像】
この記事には画像が ${imageCount} 枚あります。${imageCount > 0
  ? `画像を置くとよい見出しを ${imageCount} 個選び、その見出しの wantsImage を true にしてください。`
  : '画像はないので wantsImage はすべて false にしてください。'}

次のJSONで出力してください:
{
  "workingTitle": "仮タイトル",
  "leadIntent": "リード文で読者をどう引き込むか",
  "sections": [
    { "heading": "見出し", "level": 2, "intent": "この見出しで読者に渡すもの",
      "keywords": ["この見出しで自然に使うキーワード"], "targetChars": 400, "wantsImage": false }
  ]
}`.trim(),
};

export const writeBody = {
  system: COMMON,
  user: (sourceText: string, kw: KeywordAnalysis, outline: Outline, imageCount: number, style?: string | null, context?: string | null) => `
以下の構成で本文を書いてください。
${contextBlock(context)}${styleBlock(style)}
【ネタ】
${sourceText}

【主キーワード】${kw.primaryKeyword}
【想定読者】${kw.targetReader}
【リード方針】${outline.leadIntent}

【構成】
${outline.sections.map((s, i) =>
  `${i + 1}. ${'#'.repeat(s.level)} ${s.heading}（${s.targetChars}字目安${s.wantsImage ? '・画像あり' : ''}）\n   狙い: ${s.intent}`
).join('\n')}

【出力形式】
- Markdown で書く
- 見出しは ## と ### のみ使う（# は使わない。note ではタイトルが h1 になる）
- 見出しは「読者の疑問」の形にする。単語だけの見出しにしない
  （悪い例「材料」／良い例「材料は3つだけ。家にあるもので足りる」）
- 使ってよい記法: 見出し、段落、箇条書き(-)、番号リスト(1.)、引用(>)、**太字**、[リンク](URL)
- ★URLを書くときは [何のページか分かる表示テキスト](URL) の形式にする
  （URLをそのまま並べない。ただしURL自体は一字一句そのまま使い、変更・創作をしない）
- 表・コードブロック・画像記法は使わない
${imageCount > 0
  ? `- 画像を置く位置に [画像1] 〜 [画像${imageCount}] を、その行だけの独立した行として書く\n- 構成で「画像あり」とした見出しの直下に置く`
  : '- 画像プレースホルダは書かない'}
- タイトルは本文に含めない（見出しから始める必要はなく、リード文から始めてよい）

次のJSONで出力してください:
{ "markdown": "本文のMarkdown全文" }`.trim(),
};

export const polishSeo = {
  system: COMMON,
  user: (markdown: string, kw: KeywordAnalysis, imageCount: number, style?: string | null, context?: string | null) => `
以下の本文を、SEOと読みやすさの観点で仕上げてください。
${contextBlock(context)}${styleBlock(style)}
【主キーワード】${kw.primaryKeyword}
【関連キーワード】${kw.secondaryKeywords.join(', ')}
【検索意図】${kw.searchIntent}

【本文】
${markdown}

【やること】
1. タイトル案を3つ。主キーワードを含め、32文字以内を目安にする
   （検索結果でタイトルは約30字で切られるため、大事な語を前半に置く）

2. ★最重要：リード文（本文の1段落目）を書き直す
   **note は本文の冒頭をそのまま検索結果の説明文（メタディスクリプション）に使います。**
   つまり1段落目は「記事の導入」であると同時に「検索結果に出る文章」です。
   次を満たすように書いてください:
   - 最初の60字以内に主キーワードを自然に入れる
   - 記事を読むと何が分かるのかを、その1段落だけで伝える
   - 「〜について解説します」のような中身のない前置きにしない
   - 120〜160字程度（検索結果で切られる長さ）

3. metaDescription には、上で書いたリード文の冒頭120字をそのまま入れる
   （note 側の仕様で別指定はできないため、記録用）
4. note のハッシュタグを5個まで
${imageCount > 0 ? `5. 各画像の alt テキスト（"1" から "${imageCount}" のキーで）
   画像に何が写っているかを具体的に書く。キーワードを詰め込まない。
   note は alt をそのまま残すので、画像検索とアクセシビリティの両方に効きます` : ''}
6. 見出しを調整した方がよければ本文全体を書き直す。不要なら revisedMarkdown は null

**本文を書き直す場合も [画像N] プレースホルダは必ず残してください。**
**本文中のリンクとURLも必ず残してください。URLは一字一句変えないこと。**

次のJSONで出力してください:
{
  "titles": ["案1", "案2", "案3"],
  "leadParagraph": "リード文",
  "metaDescription": "120字前後の説明",
  "hashtags": ["タグ1", "..."],
  "imageAlts": ${imageCount > 0 ? '{ "1": "altテキスト" }' : '{}'},
  "revisedMarkdown": null
}`.trim(),
};

export const classifyRevision = {
  system: '日本語の修正指示を、決められた操作のどれかに分類します。JSONのみを出力します。',
  user: (instruction: string, headings: string[], imageCount: number) => `
記事の修正指示を分類してください。

【現在の見出し】
${headings.map((h, i) => `■${i + 1}（headingIndex=${i}）: ${h}`).join('\n') || '（見出しなし）'}

※ ユーザーは「■3」のように1始まりで指示します。headingIndex は0始まりなので、■3 なら headingIndex=2 です。

【画像】${imageCount}枚（[画像1]〜[画像${imageCount}]）

【ユーザーの指示】
${instruction}

【操作の種類】
- move_image: 画像の位置を変える（headingIndex は0始まり。「■3の下」「3番目の見出しの下」なら headingIndex=2）
- swap_image: 2つの画像を入れ替える
- remove_image: 画像を消す
- set_eyecatch: 画像をサムネイル（見出し画像・トップ画像・アイキャッチ）にする
  「この画像をサムネに」「1枚目をアイキャッチにして」「見出し画像に使って」など。
  どの画像か分かれば imageIndex に入れる（分からなければ null）
- clear_eyecatch: サムネイルを外す
- rewrite_section: 特定の部分を書き直す
- change_title: タイトルを変える
- regenerate_all: 全部作り直す
- unknown: どれにも当てはまらない

次のJSONで出力してください:
{ "action": "move_image", "imageIndex": 1, "secondImageIndex": null,
  "headingIndex": 2, "instruction": "" }`.trim(),
};

export const analyzeStyle = {
  system: `あなたは文体分析の専門家です。
書き手が書いた文章から、その人の「らしさ」を構造的に抽出します。
褒めるのではなく、再現可能な特徴として言語化してください。`,
  user: (samples: string[]) => `
以下は同じ書き手が書いた文章です。この人の文体と思考の癖を分析してください。

${samples.map((s, i) => `【サンプル${i + 1}】\n${s.slice(0, 6000)}`).join('\n\n')}

次のJSONで出力してください:
{
  "tone": "全体のトーン（です・ます／だ・である、読者との距離感、温度）",
  "vocabulary": ["よく使う語や言い回し"],
  "avoidList": ["この人が使わない語・避けている表現"],
  "sentenceRhythm": "文の長さ、句読点の打ち方、改行の癖",
  "structurePatterns": ["記事の組み立て方の癖"],
  "openingPatterns": ["書き出しの型"],
  "closingPatterns": ["締めの型"],
  "thinkingStyle": "思考の運び方（具体から入るか抽象からか、根拠の示し方、脱線の仕方）",
  "promptSnippet": "この人になりきって書くための指示を400字以内でまとめたもの。他のAIがこれだけ読めば文体を再現できる密度で書く"
}`.trim(),
};

export const analyzeContext = {
  system: `あなたは、書き手が溜めたメモを「記事を書くための前提条件」に整理する編集者です。

守ること:
- **書かれていないことを補わない。** 推測で埋めず、無いものは空のままにする
- **情報を捨てない。** 短くまとめることより、記事に効く内容を残すことを優先する
- 数字・固有名詞・URL・言い回しの指定は、**原文の表記のまま**使う
- これは人に見せる文書ではない。読みやすさより、記事に反映されることを優先する`,
  user: (rawText: string) => `
次のメモを、記事を書くときの前提条件として整理してください。
書き手が思いついた順に書き足しているので、話題は前後します。

★守ってほしいこと:
- 「必ず〜すること」「毎回〜を入れる」のような**決まりごと**は要約せず rules に原文のまま入れる
- URLは一字一句そのまま。短縮も補完もしない
- 数字・店名・商品名・人の呼び方は原文の表記を保つ
- **digest の字数に上限はありません。** 立場と事実を落とさないことを優先してください
  （ただし同じことの繰り返しや、記事に影響しない雑談はまとめて構いません）

【書き手のメモ】
${rawText}

次のJSONで出力してください:
{
  "standpoint": "記事を書くときの立場。例「福岡で20席の焼き鳥屋を営む当事者として」",
  "facts": ["記事に使える具体的な事実。数字・固有名詞は原文のまま"],
  "wording": ["呼び方や言い回しの指定。無ければ空配列"],
  "rules": ["「必ず〜すること」のような決まりごとを原文のまま。無ければ空配列"],
  "avoid": ["書いてほしくないこと。無ければ空配列"],
  "digest": "生成時にそのまま差し込む前提条件。「あなたは〜」の形で立場から書き起こし、記事に効く事実を続ける。決まりごととURLはここで繰り返さなくてよい（別枠で渡すため）"
}`.trim(),
};
