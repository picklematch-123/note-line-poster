import { z } from 'zod';

/**
 * 記事生成パイプライン各ステップの出力スキーマ。
 * LLM の出力は必ずこれで検証する（構造が崩れたらそのステップだけ再試行する）。
 */

// ── ステップ1: キーワード分析
export const KeywordAnalysis = z.object({
  primaryKeyword: z.string().describe('狙う主キーワード'),
  secondaryKeywords: z.array(z.string()).min(1).max(8),
  searchIntent: z.string().describe('読者がこのキーワードで何を知りたいか'),
  targetReader: z.string().describe('想定読者像'),
  competitorAngle: z.string().describe('既存記事にありがちな型と、そこをどう外すか'),
});
export type KeywordAnalysis = z.infer<typeof KeywordAnalysis>;

// ── ステップ2: 構成
export const OutlineSection = z.object({
  heading: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
  intent: z.string().describe('この見出しで読者に何を渡すか'),
  keywords: z.array(z.string()).default([]),
  targetChars: z.number().int().min(100).max(2000),
  wantsImage: z.boolean().default(false).describe('ここに画像を置きたいか'),
});

export const Outline = z.object({
  workingTitle: z.string(),
  leadIntent: z.string().describe('リード文で読者を引き込む方針'),
  sections: z.array(OutlineSection).min(3).max(10),
});
export type Outline = z.infer<typeof Outline>;

// ── ステップ3: 本文
export const BodyDraft = z.object({
  /** Markdown。画像位置は [画像N] プレースホルダで表現する */
  markdown: z.string().min(200),
});
export type BodyDraft = z.infer<typeof BodyDraft>;

// ── ステップ4: SEO 仕上げ
export const SeoPolish = z.object({
  titles: z.array(z.string()).min(1).max(3).describe('タイトル案。32文字以内が望ましい'),
  leadParagraph: z.string(),
  metaDescription: z.string().max(200),
  hashtags: z.array(z.string()).max(8),
  imageAlts: z.record(z.string(), z.string()).default({}).describe('{"1":"altテキスト"} の形'),
  /** 見出しを調整した場合の最終 Markdown（変更が無ければ null） */
  revisedMarkdown: z.string().nullable().default(null),
});
export type SeoPolish = z.infer<typeof SeoPolish>;

// ── 修正指示の意図分類
export const RevisionIntent = z.object({
  action: z.enum(['move_image', 'swap_image', 'remove_image', 'set_eyecatch', 'clear_eyecatch', 'rewrite_section', 'change_title', 'regenerate_all', 'unknown']),
  imageIndex: z.number().int().nullable().default(null),
  secondImageIndex: z.number().int().nullable().default(null),
  headingIndex: z.number().int().nullable().default(null).describe('0始まりの見出し番号'),
  instruction: z.string().default('').describe('rewrite/change_title のときの具体的な指示'),
});
export type RevisionIntent = z.infer<typeof RevisionIntent>;

// ── 事業コンテキスト（その人が何者か）
/**
 * 溜めたナレッジを、記事生成に効く形へ整理したもの。
 *
 * ★決まった型（業種・商品・客層…）に押し込まない。
 *   人に見せるものではないので、見栄えより「記事に反映されること」を優先する。
 *   何を書いてもいいメモ帳として溜まっていくため、
 *   受け皿のほうを中身に合わせて広く取る。
 */
export const KnowledgeDigest = z.object({
  /** どの立場で書くか。ここが記事の性格をいちばん変える */
  standpoint: z.string().describe('記事を書くときの立場。例「福岡で20席の焼き鳥屋を営む当事者として」'),
  /** 記事に使える具体的な事実。数字・固有名詞は原文のまま残す */
  facts: z.array(z.string()).default([]).describe('記事に使える具体的な事実。数字・固有名詞は原文のまま'),
  /** 呼び方・言い回しの指定 */
  wording: z.array(z.string()).default([]).describe('呼び方や言い回しの指定。例「店主のことは大将と書く」'),
  /** 本人が明示した「必ず〜すること」。原文のまま */
  rules: z.array(z.string()).default([]).describe('本人が明示した決まりごとを原文のまま。URLを含む場合もそのまま'),
  /** 書いてほしくないこと */
  avoid: z.array(z.string()).default([]).describe('書いてほしくないこと・触れてほしくないこと'),
  /**
   * 生成時にそのまま差し込む本文。
   * ★字数の上限は設けない。溜めた情報を捨てないことを優先する。
   */
  digest: z.string().describe('記事生成時にそのまま差し込む前提条件。立場と事実を落とさずに整理する'),
});
export type KnowledgeDigest = z.infer<typeof KnowledgeDigest>;

// ── スタイルプロファイル（ナレッジ機能）
export const StyleProfile = z.object({
  tone: z.string().describe('全体のトーン。です・ます／だ・である、距離感、温度'),
  vocabulary: z.array(z.string()).describe('その人がよく使う語・言い回し'),
  avoidList: z.array(z.string()).describe('その人が使わない語・避けている表現'),
  sentenceRhythm: z.string().describe('文の長さ、句読点の打ち方、改行の癖'),
  structurePatterns: z.array(z.string()).describe('記事の組み立て方の癖'),
  openingPatterns: z.array(z.string()).describe('書き出しの型'),
  closingPatterns: z.array(z.string()).describe('締めの型'),
  thinkingStyle: z.string().describe('思考の運び方。具体から入るか抽象からか、根拠の示し方など'),
  /** 生成時にプロンプトへ差し込む要約（トークン節約のため事前に作る） */
  promptSnippet: z.string(),
});
export type StyleProfile = z.infer<typeof StyleProfile>;
