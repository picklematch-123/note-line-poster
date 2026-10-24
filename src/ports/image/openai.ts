/**
 * OpenAI の画像生成（gpt-image-2）。
 *
 * ★モデルは gpt-image-2 固定（会社ルール・決定008）。呼べないときに別モデルへ
 *   黙って下げない。失敗として扱い、利用者にも運用側にも分かるようにする。
 * ★BYOK: キーは顧客ごと（＝環境ごと）のシークレット。当社は預からない。
 * ★課金されるのは成功したときだけ。再試行は「一時的なエラー」に限り、回数に上限を置く。
 */
import { log } from '../../lib/mask';

const API = 'https://api.openai.com/v1/images/generations';

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

export type ImageErrorKind = 'auth' | 'billing' | 'verification' | 'policy' | 'rate' | 'temp' | 'bad_request';

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

export interface GeneratedImage {
  bytes: ArrayBuffer;
  contentType: string;
  size: string;
  usage?: { inputTokens: number; outputTokens: number };
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

export class OpenAiImageClient {
  constructor(private readonly apiKey: string, private readonly model: string = IMAGE_MODEL) {
    if (!apiKey?.startsWith('sk-')) {
      throw new ImageGenError('OpenAI キーの形式が不正', 'auth',
        'OpenAI の API キーが正しく登録されていません。platform.openai.com で発行したキー（sk- で始まるもの）をご登録ください。');
    }
    if (model !== IMAGE_MODEL) throw new Error(`画像モデルは ${IMAGE_MODEL} 固定です`);
  }

  /** 1枚だけ作る。サイズを断られたら標準サイズで1回だけやり直す。 */
  async generate(prompt: string, size: string = THUMBNAIL_SIZE): Promise<GeneratedImage> {
    try {
      return await this.withRetry(prompt, size);
    } catch (e) {
      if (e instanceof ImageGenError && e.kind === 'bad_request' && /size/i.test(e.message) && size !== FALLBACK_SIZE) {
        log.warn(`サイズ ${size} を断られたため ${FALLBACK_SIZE} で作り直します`);
        return this.withRetry(prompt, FALLBACK_SIZE);
      }
      throw e;
    }
  }

  private async withRetry(prompt: string, size: string): Promise<GeneratedImage> {
    let last: ImageGenError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.once(prompt, size);
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

  private async once(prompt: string, size: string): Promise<GeneratedImage> {
    let res: Response;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, prompt, size, quality: 'medium', n: 1, output_format: 'png' }),
      });
    } catch (e) {
      throw new ImageGenError(`通信エラー: ${String(e)}`, 'temp',
        '通信が不安定でサムネイルを作れませんでした。少し待って「サムネを作り直す」を押してください。');
    }
    const raw = await res.text();
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
