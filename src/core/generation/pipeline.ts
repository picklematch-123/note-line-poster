/**
 * SEO記事の生成パイプライン（4ステップ）。
 *
 * 各ステップは独立して再試行できる。Workflows の step 単位に対応させることで、
 * 途中で失敗しても最初からやり直さない。
 */
import { AnthropicLlm, type LlmUsage } from '../../ports/llm/anthropic';
import * as P from './prompts';
import { KeywordAnalysis, Outline, BodyDraft, SeoPolish, StyleProfile, KnowledgeDigest } from './schema';
import { normalize, parseHeadings } from '../article/placeholders';
import { log } from '../../lib/mask';

export interface GenerationInput {
  sourceText: string;
  hintKeywords: string[];
  imageCount: number;
  /** スタイルプロファイルの promptSnippet（無ければ汎用の書き方になる） */
  stylePrompt?: string | null;
  /** 事業コンテキストの promptSnippet。★記事の中身を決める */
  contextPrompt?: string | null;
}

export interface GenerationOutput {
  keywords: KeywordAnalysis;
  outline: Outline;
  /** [画像N] を含む最終 Markdown */
  markdown: string;
  title: string;
  titleOptions: string[];
  metaDescription: string;
  hashtags: string[];
  imageAlts: Record<string, string>;
  usage: LlmUsage;
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** ステップ1: キーワード設計 */
export async function analyzeKeywords(llm: AnthropicLlm, input: GenerationInput) {
  return llm.structured({
    tier: 'heavy',
    label: 'キーワード分析',
    schema: KeywordAnalysis,
    maxTokens: 2000,
    system: P.analyzeKeywords.system,
    user: P.analyzeKeywords.user(input.sourceText, input.hintKeywords, input.stylePrompt, input.contextPrompt),
  });
}

/** ステップ2: 構成 */
export async function buildOutline(llm: AnthropicLlm, input: GenerationInput, kw: KeywordAnalysis) {
  return llm.structured({
    tier: 'heavy',
    label: '構成作成',
    schema: Outline,
    maxTokens: 4000,
    system: P.buildOutline.system,
    user: P.buildOutline.user(input.sourceText, kw, input.imageCount, input.stylePrompt, input.contextPrompt),
  });
}

/** ステップ3: 本文 */
export async function writeBody(
  llm: AnthropicLlm, input: GenerationInput, kw: KeywordAnalysis, outline: Outline,
) {
  return llm.structured({
    tier: 'heavy',
    label: '本文執筆',
    schema: BodyDraft,
    maxTokens: 16000,
    system: P.writeBody.system,
    user: P.writeBody.user(input.sourceText, kw, outline, input.imageCount, input.stylePrompt, input.contextPrompt),
  });
}

/** ステップ4: SEO仕上げ */
export async function polishSeo(
  llm: AnthropicLlm, input: GenerationInput, kw: KeywordAnalysis, markdown: string,
) {
  return llm.structured({
    tier: 'heavy',
    label: 'SEO仕上げ',
    schema: SeoPolish,
    maxTokens: 8000,
    system: P.polishSeo.system,
    user: P.polishSeo.user(markdown, kw, input.imageCount, input.stylePrompt, input.contextPrompt),
  });
}

/** 4ステップを通しで実行する（Workflows を使わない経路・テスト用）。 */
export async function generate(llm: AnthropicLlm, input: GenerationInput): Promise<GenerationOutput> {
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

  const kw = await analyzeKeywords(llm, input);
  usage = addUsage(usage, kw.usage);

  const outline = await buildOutline(llm, input, kw.data);
  usage = addUsage(usage, outline.usage);

  const body = await writeBody(llm, input, kw.data, outline.data);
  usage = addUsage(usage, body.usage);

  const polish = await polishSeo(llm, input, kw.data, body.data.markdown);
  usage = addUsage(usage, polish.usage);

  // 仕上げで本文が書き直されていればそれを採用する
  const raw = polish.data.revisedMarkdown ?? body.data.markdown;
  // 画像枚数とプレースホルダ数を必ず一致させる（LLM の出力を信用しない）
  const markdown = normalize(raw, input.imageCount);

  log.info('記事生成完了', {
    見出し数: parseHeadings(markdown).length,
    文字数: markdown.replace(/\[画像\d+\]/g, '').length,
    入力トークン: usage.inputTokens,
    出力トークン: usage.outputTokens,
  });

  return {
    keywords: kw.data,
    outline: outline.data,
    markdown,
    title: polish.data.titles[0],
    titleOptions: polish.data.titles,
    metaDescription: polish.data.metaDescription,
    hashtags: polish.data.hashtags,
    imageAlts: polish.data.imageAlts,
    usage,
  };
}

/** 過去記事などから文体プロファイルを作る（ナレッジ機能）。 */
export async function analyzeStyle(llm: AnthropicLlm, samples: string[]) {
  if (samples.length === 0) throw new Error('分析するサンプルがありません');
  return llm.structured({
    tier: 'heavy',
    label: '文体分析',
    schema: StyleProfile,
    maxTokens: 4000,
    system: P.analyzeStyle.system,
    user: P.analyzeStyle.user(samples),
  });
}

/** 本人が書いた自己紹介から、記事の前提条件を構造化する。 */
export async function analyzeContext(llm: AnthropicLlm, rawText: string) {
  return llm.structured({
    tier: 'heavy',
    label: 'ナレッジの整理',
    schema: KnowledgeDigest,
    // ★溜めた情報を捨てないので、入力に応じて出力枠も広く取る
    maxTokens: 8000,
    system: P.analyzeContext.system,
    user: P.analyzeContext.user(rawText),
  });
}
