/**
 * 画像を作る口（2026-10-26 画像のルール 3-2）。
 *
 * ★今の実装は OpenAI（gpt-image-2 固定）だけ。ほかのツールは作らない。差し替えられる口を切っておくだけ。
 * ★失敗は ImageGenError（ports/image/openai.ts）で投げる。呼び出し側（core/image）が受け止めて、例外は外に出さない。
 */

/** 生成した画像 */
export interface GeneratedImage {
  bytes: ArrayBuffer;
  contentType: string;
  size: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 参考画像（見た目や雰囲気をそろえるための画像。人物・商品・見本など）。中身はログに出さない */
export interface ReferenceImage {
  bytes: ArrayBuffer;
  mime: string;
  /** 送るときのファイル名（拡張子つき）。顧客がつけた名前は使わない */
  filename?: string;
}

export interface ImageGenerator {
  /** 文字の指示だけで1枚作る */
  generate(prompt: string, size?: string): Promise<GeneratedImage>;
  /** 参考画像（最大3枚）つきで1枚作る */
  edit(prompt: string, refs: ReferenceImage[], size?: string): Promise<GeneratedImage>;
}
