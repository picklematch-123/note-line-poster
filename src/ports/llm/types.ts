/**
 * LLM の共通の型。提供元（Claude / OpenAI）に依らず、呼び出し側はこれだけを見る。
 */
import type { z } from 'zod';

/** 用途の区別。heavy = 記事の構成・本文・仕上げなど / light = 意図分類など */
export type ModelTier = 'heavy' | 'light';

/** 構造化出力が不正・一時障害のときに追加で行う再試行回数。 */
export const DEFAULT_STRUCTURED_MAX_RETRIES = 2;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

/**
 * timeout = 決めた時間内に応答が無く、こちらから打ち切った。
 *   調査（webResearch）は再試行しない（recoverable=false）。文章の生成は一時的なものとして再試行の上限内でやり直す（recoverable=true）
 */
export type LlmErrorKind = 'auth' | 'billing' | 'rate' | 'temp' | 'timeout' | 'model_unavailable' | 'bad_output' | 'other';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    /** 時間をおけば直る種類か（レート制限・一時障害・通信エラー） */
    readonly recoverable: boolean,
    /** 原因追跡用。ログに残す */
    readonly status?: number,
    /** 種類。モデルが使えないときだけ次の候補へ進むなど、分岐に使う */
    readonly kind?: LlmErrorKind,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface StructuredOptions<T> {
  tier: ModelTier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  maxRetries?: number;
  label: string;
}

/** 画像入力（2026-10-26 画像のルール・サムネの検品）。中身はログに出さない */
export interface VisionImage {
  bytes: ArrayBuffer;
  mime: string;
}

export interface VisionOptions<T> {
  tier: ModelTier;
  system: string;
  user: string;
  images: VisionImage[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  label: string;
}

export interface Llm {
  structured<T>(opts: StructuredOptions<T>): Promise<LlmResult<T>>;
  /**
   * 画像を見て答える。★任意: 無い提供元・使えない提供元では、呼び出し側が「未検品」として扱う
   * （検品が使えないことを理由に、画像づくりや記事を止めない）。
   */
  vision?<T>(opts: VisionOptions<T>): Promise<LlmResult<T>>;
}

/** コードフェンスや前置きが混ざっても JSON を取り出す。 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
