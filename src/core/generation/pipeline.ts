/**
 * SEO記事の生成パイプライン（4ステップ）。
 *
 * 各ステップは独立して再試行できる。Workflows の step 単位に対応させることで、
 * 途中で失敗しても最初からやり直さない。
 */
import type { Llm, LlmUsage } from '../../ports/llm/types';
import * as P from './prompts';
import type { ResearchPromptInput } from './prompts';
import { KeywordAnalysis, Outline, BodyDraft, SeoPolish, StyleProfile, KnowledgeDigest } from './schema';
import { normalize, parseHeadings } from '../article/placeholders';
import { log } from '../../lib/mask';
import {
  type PastArticle, type SimilarHit, pastArticlesBlock, pastTitlesBlock,
  findSimilarPast, repeatsQuestionPattern, outlineRedoNote,
} from './history';

export interface GenerationInput {
  sourceText: string;
  hintKeywords: string[];
  imageCount: number;
  /** スタイルプロファイルの promptSnippet（無ければ汎用の書き方になる） */
  stylePrompt?: string | null;
  /** 事業コンテキストの promptSnippet。★記事の中身を決める */
  contextPrompt?: string | null;
  /**
   * Webリサーチの結果（core/research）。未指定＝調査の仕組みが無い環境で、今までどおりの書き方。
   * mode='given' のときは「ナレッジとネタに無い事実を足さない」を明記する。
   */
  research?: ResearchPromptInput | null;
  /**
   * 同じ環境の過去記事（新しい順・自分自身は除いたもの。core/generation/history の toPastArticles）。
   * 未指定・0件なら今までどおりのプロンプト（過去記事のブロックは入らない）。
   */
  pastArticles?: readonly PastArticle[];
  /** ネタが重複を明示的に求めている（「同じテーマで」「決定版」など）。true なら構成のやり直しをしない */
  overlapAllowed?: boolean;
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
  /** 構成を過去記事と似ていたためにやり直したか（最大1回） */
  outlineRedone: boolean;
  /** できあがり（タイトル・見出し）が過去記事と強く似ている（プレビューで注意を出す）。似ていなければ空 */
  similarPast: SimilarHit[];
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** キーワード分析・構成に渡す過去記事（見出しつき）。0件なら空文字 */
const historyFull = (input: GenerationInput) => pastArticlesBlock(input.pastArticles ?? [], input.overlapAllowed);
/** 本文・仕上げに渡す過去記事（タイトルだけ）。0件なら空文字 */
const historyBrief = (input: GenerationInput) => pastTitlesBlock(input.pastArticles ?? []);

/** ステップ1: キーワード設計 */
export async function analyzeKeywords(llm: Llm, input: GenerationInput) {
  return llm.structured({
    tier: 'heavy',
    label: 'キーワード分析',
    schema: KeywordAnalysis,
    maxTokens: 2000,
    system: P.analyzeKeywords.system,
    user: P.analyzeKeywords.user(input.sourceText, input.hintKeywords, input.stylePrompt, input.contextPrompt, input.research, historyFull(input)),
  });
}

/**
 * ステップ2: 構成
 * @param redoNote 過去記事と似ていたためにやり直すときの指摘（outlineRedoNote）
 */
export async function buildOutline(llm: Llm, input: GenerationInput, kw: KeywordAnalysis, redoNote = '') {
  return llm.structured({
    tier: 'heavy',
    label: '構成作成',
    schema: Outline,
    maxTokens: 4000,
    system: P.buildOutline.system,
    user: P.buildOutline.user(input.sourceText, kw, input.imageCount, input.stylePrompt, input.contextPrompt, input.research,
      historyFull(input) + redoNote),
  });
}

/** ステップ3: 本文 */
export async function writeBody(
  llm: Llm, input: GenerationInput, kw: KeywordAnalysis, outline: Outline,
) {
  return llm.structured({
    tier: 'heavy',
    label: '本文執筆',
    schema: BodyDraft,
    maxTokens: 16000,
    system: P.writeBody.system,
    user: P.writeBody.user(input.sourceText, kw, outline, input.imageCount, input.stylePrompt, input.contextPrompt, input.research, historyBrief(input)),
  });
}

/** ステップ4: SEO仕上げ */
export async function polishSeo(
  llm: Llm, input: GenerationInput, kw: KeywordAnalysis, markdown: string,
) {
  return llm.structured({
    tier: 'heavy',
    label: 'SEO仕上げ',
    schema: SeoPolish,
    maxTokens: 8000,
    system: P.polishSeo.system,
    user: P.polishSeo.user(markdown, kw, input.imageCount, input.stylePrompt, input.contextPrompt, input.research, historyBrief(input)),
  });
}

/** 4ステップを通しで実行する（Workflows を使わない経路・テスト用）。 */
export async function generate(llm: Llm, input: GenerationInput): Promise<GenerationOutput> {
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

  const kw = await analyzeKeywords(llm, input);
  usage = addUsage(usage, kw.usage);

  let outline = await buildOutline(llm, input, kw.data);
  usage = addUsage(usage, outline.usage);

  // ★過去記事との重なりの検査（LLM を使わない）。強く似ていたら構成だけを1回やり直す。
  //   構成の段階でやる理由: いちばん高い本文（出力 最大16k）を書く前なので、やり直しの費用が構成1回分で済む。
  //   2回目も似ていたら、それ以上はやり直さない（費用の上限）。できあがりで似ていればプレビューで注意を出す
  const past = input.pastArticles ?? [];
  let outlineRedone = false;
  if (past.length > 0 && !input.overlapAllowed) {
    const headings = outline.data.sections.map((s) => s.heading);
    const hits = findSimilarPast({ title: outline.data.workingTitle, headings }, past);
    const questionPattern = repeatsQuestionPattern(headings, past);
    if (hits.length > 0 || questionPattern) {
      log.info('構成が過去記事と似ているため、1回だけ作り直します', {
        似ている記事: hits.slice(0, 3).map((h) => `${h.reason}:${h.title}`),
        疑問形の型: questionPattern,
      });
      outline = await buildOutline(llm, input, kw.data, outlineRedoNote(hits, questionPattern));
      usage = addUsage(usage, outline.usage);
      outlineRedone = true;
    }
  }

  const body = await writeBody(llm, input, kw.data, outline.data);
  usage = addUsage(usage, body.usage);

  const polish = await polishSeo(llm, input, kw.data, body.data.markdown);
  usage = addUsage(usage, polish.usage);

  // 仕上げで本文が書き直されていればそれを採用する
  const raw = polish.data.revisedMarkdown ?? body.data.markdown;
  // 画像枚数とプレースホルダ数を必ず一致させる（LLM の出力を信用しない）
  const markdown = normalize(raw, input.imageCount);

  // できあがりの検査（注意を出すだけ。ここではやり直さない）
  const similarPast = past.length > 0 && !input.overlapAllowed
    ? findSimilarPast({ title: polish.data.titles[0], headings: parseHeadings(markdown).map((h) => h.text) }, past)
    : [];

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
    outlineRedone,
    similarPast,
  };
}

/** 過去記事などから文体プロファイルを作る（ナレッジ機能）。 */
export async function analyzeStyle(llm: Llm, samples: string[]) {
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
export async function analyzeContext(llm: Llm, rawText: string) {
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
