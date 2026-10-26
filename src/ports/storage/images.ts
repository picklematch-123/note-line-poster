/**
 * 画像の一時置き場。
 *
 * 画像は「LINE で受け取る → note へアップロードする」までの中継にしか使わないので、
 * 恒久保存は不要。Phase 1 は KV を使う（R2 はダッシュボードでの有効化が必要なため）。
 *
 * ★差し替え可能にしてある。将来 R2 に戻すときは R2ImageStore を足して
 *   src/index.ts の配線を1行変えるだけで済む。
 */

/** 一時置きなので期限を切る（note へ上げたら不要になる）。 */
const TTL_SECONDS = 7 * 24 * 60 * 60;

export interface StoredImage {
  bytes: ArrayBuffer;
  contentType: string;
}

/**
 * persistent = 期限を切らない（参考画像など、消すまで残すもの。2026-10-26 画像のルール）。
 * ★既定は今までどおり期限つき。指定しない呼び出しの動きは変わらない
 */
export interface PutOptions { persistent?: boolean }

export interface ImageStore {
  put(key: string, bytes: ArrayBuffer, contentType: string, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  delete(key: string): Promise<void>;
}

/** KV 実装。1件あたり 25MB まで置ける（LINE の画像は十分収まる）。 */
export class KvImageStore implements ImageStore {
  constructor(private readonly kv: KVNamespace) {}

  async put(key: string, bytes: ArrayBuffer, contentType: string, opts?: PutOptions): Promise<void> {
    await this.kv.put(`img:${key}`, bytes, {
      ...(opts?.persistent ? {} : { expirationTtl: TTL_SECONDS }),
      metadata: { contentType },
    });
  }

  async get(key: string): Promise<StoredImage | null> {
    const res = await this.kv.getWithMetadata<{ contentType?: string }>(`img:${key}`, 'arrayBuffer');
    if (!res.value) return null;
    return {
      bytes: res.value,
      contentType: res.metadata?.contentType ?? 'image/jpeg',
    };
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(`img:${key}`);
  }
}

/** R2 実装。R2 を有効化したらこちらへ差し替える。 */
export class R2ImageStore implements ImageStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<StoredImage | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      bytes: await obj.arrayBuffer(),
      contentType: obj.httpMetadata?.contentType ?? 'image/jpeg',
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
