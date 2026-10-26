/**
 * OpenAI の画像生成（gpt-image-2）。
 *
 * ★モデルは gpt-image-2 固定（会社ルール・決定008）。呼べないときに別モデルへ
 *   黙って下げない。失敗として扱い、利用者にも運用側にも分かるようにする。
 * ★BYOK: キーは顧客ごと（＝環境ごと）のシークレット。当社は預からない。
 * ★課金されるのは成功したときだけ。再試行は「一時的なエラー」に限り、回数に上限を置く。
 */
import { log } from '../../lib/mask';
import type { GeneratedImage, ImageGenerator, ReferenceImage } from './types';

export type { GeneratedImage, ImageGenerator, ReferenceImage } from './types';

const API = 'https://api.openai.com/v1/images/generations';
/** 参考画像つき（2026-10-26 画像のルール）。multipart で送る */
export const EDIT_API = 'https://api.openai.com/v1/images/edits';
/** 参考画像は最大3枚まで送る（それ以上は切り捨てる。1環境の登録上限も3枚） */
export const MAX_REFERENCE_IMAGES = 3;

export const IMAGE_MODEL = 'gpt-image-2';

/** note のサムネは 1920×1005（約1.91:1）。16 の倍数で最も近い比率で、費用を抑えるため小さめに作る */
export const THUMBNAIL_SIZE = '1536x800';
/** サイズ指定を断られたときの標準サイズ（OpenAI が推奨する横長） */
export const FALLBACK_SIZE = '1536x1024';

/** 一時エラーでの追加再試行の上限。これ以上は粘らない（請求の暴走を防ぐ） */
export const MAX_RETRIES = 2;

/**
 * generate() 1回（＝サムネの予約1件）で OpenAI を呼ぶ回数の最悪値（★2026-10-24 源蔵レビュー）。
 *   指定サイズで「初回＋再試行2回」＝3回 → サイズを断られたら標準サイズで、もう1組（3回）。
 *   サイズ違いのやり直しは1回だけ（標準サイズを断られても、さらに別のサイズは試さない）。
 * 課金されうるのは「成功した呼び出し」と「200 で返ったのに画像が読めなかった呼び出し」。後者は再試行しない
 * （課金済みかもしれないため）ので、課金は通常1回まで。理論上の最悪は設計書 16 章。
 */
export const MAX_CALLS_PER_GENERATE = 2 * (MAX_RETRIES + 1);

/**
 * 画像1回の通信の時間切れ（★2026-10-26 源蔵レビュー必須1）。文章（180秒）・調査（120秒）と同じ考え方。
 * 時間切れが無いと、応答が返らないとき step「サムネイルを作る」の 5 分の時間切れまで待ってしまう。
 * 実測は1枚 約26〜40秒なので、120 秒あれば通常は届く。
 */
export const IMAGE_TIMEOUT_MS = 120_000;

/** timeout = こちらから打ち切った。★再試行しない（生成済み＝課金済みかもしれないため。「200で読めない」と同じ扱い） */
export type ImageErrorKind = 'auth' | 'billing' | 'verification' | 'policy' | 'rate' | 'temp' | 'timeout' | 'bad_request';

export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly kind: ImageErrorKind,
    /** LINE にそのまま出せる日本語。次の一手まで書く */
    readonly userMessage: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ImageGenError';
  }
}

interface OpenAiError { error?: { message?: string; code?: string; type?: string } }

function classify(status: number, body: OpenAiError, raw: string): ImageGenError {
  const code = body.error?.code ?? '';
  const type = body.error?.type ?? '';
  const msg = body.error?.message ?? raw.slice(0, 200);
  const hay = `${code} ${type} ${msg}`.toLowerCase();

  if (status === 401) {
    return new ImageGenError(`OpenAI 401: ${msg}`, 'auth',
      'OpenAI の API キーが正しくありません。platform.openai.com で発行したキーをご登録ください。', status);
  }
  if (hay.includes('insufficient_quota') || hay.includes('billing') || hay.includes('exceeded your current quota')) {
    return new ImageGenError(`OpenAI 残高/上限: ${msg}`, 'billing',
      'OpenAI の残高または利用上限に達しているため、サムネイルを作れませんでした。\n' +
      'platform.openai.com の「Billing」でチャージ（最低5ドル）か上限の引き上げをお願いします。\n' +
      '記事は書けています。サムネなしでも投稿できます。', status);
  }
  if (status === 403 && (hay.includes('verif') || hay.includes('organization'))) {
    return new ImageGenError(`OpenAI 組織認証: ${msg}`, 'verification',
      'OpenAI 側で「組織の認証（API Organization Verification）」が必要と表示されています。\n' +
      'platform.openai.com の Settings → Organization → Verifications で手続きをお願いします。\n' +
      '記事は書けています。サムネなしでも投稿できます。', status);
  }
  if (hay.includes('moderation') || hay.includes('content_policy') || hay.includes('safety')) {
    return new ImageGenError(`OpenAI 安全基準: ${msg}`, 'policy',
      'この内容では OpenAI の安全基準によりサムネイルを作れませんでした。\n' +
      'もう一度作り直すか、ご自身の写真をサムネに設定してください。', status);
  }
  if (status === 429) {
    return new ImageGenError(`OpenAI 429: ${msg}`, 'rate',
      'OpenAI が混み合っています。少し待ってから「サムネを作り直す」を押してください。', status);
  }
  if (status >= 500) {
    return new ImageGenError(`OpenAI ${status}: ${msg}`, 'temp',
      'OpenAI 側の一時的な不調でサムネイルを作れませんでした。少し待って「サムネを作り直す」を押してください。', status);
  }
  return new ImageGenError(`OpenAI ${status}: ${msg}`, 'bad_request',
    'サムネイルを作れませんでした。もう一度試すか、ご自身の写真をサムネに設定してください。', status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 参考画像の送り名（顧客がつけた名前は使わない。中身の形式から拡張子だけ決める） */
function refFilename(r: ReferenceImage, i: number): string {
  if (r.filename) return r.filename;
  const ext = r.mime === 'image/jpeg' ? 'jpg' : r.mime === 'image/webp' ? 'webp' : 'png';
  return `ref${i + 1}.${ext}`;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export class OpenAiImageClient implements ImageGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = IMAGE_MODEL,
    /** 通信の時間切れ（ミリ秒）。テストで短くするためのもの */
    private readonly timeoutMs: number = IMAGE_TIMEOUT_MS,
  ) {
    if (!apiKey?.startsWith('sk-')) {
      throw new ImageGenError('OpenAI キーの形式が不正', 'auth',
        'OpenAI の API キーが正しく登録されていません。platform.openai.com で発行したキー（sk- で始まるもの）をご登録ください。');
    }
    if (model !== IMAGE_MODEL) throw new Error(`画像モデルは ${IMAGE_MODEL} 固定です`);
  }

  /** 1枚だけ作る。サイズを断られたら標準サイズで1回だけやり直す。 */
  async generate(prompt: string, size: string = THUMBNAIL_SIZE): Promise<GeneratedImage> {
    return this.withSizeFallback(prompt, size, null);
  }

  /**
   * 参考画像つきで1枚作る（POST /v1/images/edits・multipart）。
   * ★モデルは generate と同じく gpt-image-2 固定。再試行・サイズのやり直し・課金の扱いも同じ。
   * ★参考画像が1枚も無ければ generate と同じ（呼び出し側の取り違えで失敗させない）
   */
  async edit(prompt: string, refs: ReferenceImage[], size: string = THUMBNAIL_SIZE): Promise<GeneratedImage> {
    const list = refs.slice(0, MAX_REFERENCE_IMAGES);
    if (list.length === 0) return this.generate(prompt, size);
    return this.withSizeFallback(prompt, size, list);
  }

  private async withSizeFallback(prompt: string, size: string, refs: ReferenceImage[] | null): Promise<GeneratedImage> {
    try {
      return await this.withRetry(prompt, size, refs);
    } catch (e) {
      if (e instanceof ImageGenError && e.kind === 'bad_request' && /size/i.test(e.message) && size !== FALLBACK_SIZE) {
        log.warn(`サイズ ${size} を断られたため ${FALLBACK_SIZE} で作り直します`);
        return this.withRetry(prompt, FALLBACK_SIZE, refs);
      }
      throw e;
    }
  }

  private async withRetry(prompt: string, size: string, refs: ReferenceImage[] | null): Promise<GeneratedImage> {
    let last: ImageGenError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.once(prompt, size, refs);
      } catch (e) {
        if (!(e instanceof ImageGenError)) throw e;
        last = e;
        // ★200 で返った（＝生成されて課金されたかもしれない）のに読めなかったものは、やり直さない
        const retryable = (e.kind === 'temp' || e.kind === 'rate') && e.status !== 200;
        if (!retryable || attempt === MAX_RETRIES) throw e;
        const waitMs = 3000 * Math.pow(2, attempt);
        log.warn(`画像生成が一時エラー（${e.status}）。${waitMs / 1000}秒後に再試行します`);
        await sleep(waitMs);
      }
    }
    throw last!;
  }

  /** 参考画像つきの送信内容（毎回作り直す。FormData を使い回さない） */
  private editForm(prompt: string, size: string, refs: ReferenceImage[]): FormData {
    const form = new FormData();
    form.append('model', this.model);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('quality', 'medium');
    form.append('n', '1');
    form.append('output_format', 'png');
    refs.forEach((r, i) => form.append('image[]', new Blob([r.bytes], { type: r.mime }), refFilename(r, i)));
    return form;
  }

  private async once(prompt: string, size: string, refs: ReferenceImage[] | null): Promise<GeneratedImage> {
    // ★本文の受け取り中も時間切れの対象
    const signal = AbortSignal.timeout(this.timeoutMs);
    const timeoutError = (e: unknown) => new ImageGenError(`timeout after ${this.timeoutMs}ms: ${String(e)}`, 'timeout',
      '画像の作成に時間がかかりすぎたため、打ち切りました。少し待って「サムネを作り直す」を押すか、ご自身の写真をサムネにしてください。');
    let res: Response;
    try {
      res = refs
        ? await fetch(EDIT_API, {
          method: 'POST',
          // ★content-type は付けない（multipart の区切りは fetch が付ける）
          headers: { authorization: `Bearer ${this.apiKey}` },
          body: this.editForm(prompt, size, refs),
          signal,
        })
        : await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, prompt, size, quality: 'medium', n: 1, output_format: 'png' }),
          signal,
        });
    } catch (e) {
      if (isAbort(e) || signal.aborted) throw timeoutError(e);
      throw new ImageGenError(`通信エラー: ${String(e)}`, 'temp',
        '通信が不安定でサムネイルを作れませんでした。少し待って「サムネを作り直す」を押してください。');
    }
    let raw: string;
    try { raw = await res.text(); } catch (e) {
      if (isAbort(e) || signal.aborted) throw timeoutError(e);
      throw new ImageGenError(`受信エラー: ${String(e)}`, 'temp', '画像の受け取りに失敗しました。もう一度お試しください。', res.status);
    }
    if (!res.ok) {
      let body: OpenAiError = {};
      try { body = JSON.parse(raw); } catch { /* 本文が JSON でない */ }
      throw classify(res.status, body, raw);
    }
    let json: { data?: Array<{ b64_json?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    try { json = JSON.parse(raw); } catch {
      throw new ImageGenError('応答が JSON でない', 'temp', '画像の受け取りに失敗しました。もう一度お試しください。', res.status);
    }
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new ImageGenError('画像データが空', 'temp', '画像の受け取りに失敗しました。もう一度お試しください。', res.status);
    return {
      bytes: decodeBase64(b64),
      contentType: 'image/png',
      size,
      usage: json.usage ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 } : undefined,
    };
  }
}
