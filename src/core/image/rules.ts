/**
 * 画像のルール・参考画像（2026-10-26 設計書 docs/design-image-rules-2026-10-26.md・段階1＋2）。
 *
 * ★何も登録しなければ今までと同じ動き:
 *   ルールの行が無い種類は getImageRules が null を返し、呼び出し側（thumbnail.ts / inline.ts）は従来の作り方のまま。
 *   検品も、行がある（＝持ち主が画面で保存した）ときだけ働く。
 * ★ルール本文は、画像の指示文づくりの入力にだけ使う（記事本文・公開物には出ない）。ログに本文・画像を出さない。
 * ★参考画像の検査は「拡張子・申告された形式」ではなく先頭バイトで行う（形式の偽装を通さない）。
 * ★読み込みの失敗（表がまだ無い＝マイグレーション前など）は「何も登録していない」側に倒す（従来どおり動く）。
 */
import type { Db, ImageRefRow, ImageRuleKind, ImageRuleRow } from '../../ports/storage/db';
import type { ImageStore } from '../../ports/storage/images';
import type { ReferenceImage } from '../../ports/image/types';
import { newId } from '../../lib/id';
import { log } from '../../lib/mask';

export type { ImageRuleKind } from '../../ports/storage/db';
export type TitleMode = 'none' | 'title';

/** ルール本文の上限（文字） */
export const RULE_BODY_MAX = 6000;
/** 参考画像1枚の上限（バイト） */
export const REF_MAX_BYTES = 5 * 1024 * 1024;
/** 1環境の参考画像の上限（枚） */
export const REF_MAX_COUNT = 3;
/** 検品のやり直し回数の選択肢と、行を作ったときの既定 */
export const INSPECT_RETRY_OPTIONS = [0, 1, 2] as const;
export const DEFAULT_INSPECT_RETRIES = 1;
/** 参考画像の名前の上限（文字） */
export const REF_NAME_MAX = 40;

export interface ImageRules {
  kind: ImageRuleKind;
  body: string;
  titleMode: TitleMode;
  inspectRetries: number;
}

/** 保存済みの値が壊れていても、安全側（題名なし・やり直し0〜2に収める）で読む */
function fromRow(row: ImageRuleRow): ImageRules {
  const r = Number(row.inspect_retries);
  return {
    kind: row.kind,
    body: (row.body ?? '').slice(0, RULE_BODY_MAX),
    titleMode: row.title_mode === 'title' ? 'title' : 'none',
    inspectRetries: (INSPECT_RETRY_OPTIONS as readonly number[]).includes(r) ? r : 0,
  };
}

/** 行が無い・読めない → null（＝何も登録していない＝今までと同じ動き） */
export async function getImageRules(db: Db, tenantId: string, kind: ImageRuleKind): Promise<ImageRules | null> {
  try {
    const row = await db.getImageRule(tenantId, kind);
    return row ? fromRow(row) : null;
  } catch (e) {
    log.warn('画像のルールを読めなかったため、従来の作り方で続けます', String(e).slice(0, 120));
    return null;
  }
}

export function parseTitleMode(v: unknown): TitleMode | null {
  return v === 'none' || v === 'title' ? v : null;
}

export function parseInspectRetries(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return (INSPECT_RETRY_OPTIONS as readonly number[]).includes(n) ? n : null;
}

/** 本文を整える（改行をそろえ、前後の空白を落とす）。上限を超えたら null（切り詰めて黙って保存しない） */
export function normalizeRuleBody(v: unknown): string | null {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\r\n?/g, '\n').trim();
  return s.length > RULE_BODY_MAX ? null : s;
}

export type SaveRulesResult =
  | { ok: true; saved: boolean }
  | { ok: false; reason: 'too_long' | 'bad_value' };

/**
 * ルールを保存する（画面から）。
 * @param input.body undefined = 本文は変えない（画面には登録済みの本文を出さないため、空欄のまま送られたら残す）
 * @param input.clearBody true = 本文を消す
 * ★行がまだ無く、本文も空・題名モードも none・検品回数も既定のままなら、行を作らない（＝何も登録していないまま。検品も始まらない）。
 *   文中画像の欄だけ書いて保存したら、サムネの検品まで勝手に始まった、を起こさないため
 */
export async function saveImageRules(db: Db, tenantId: string, kind: ImageRuleKind, input: {
  body?: unknown; clearBody?: boolean; titleMode?: unknown; inspectRetries?: unknown; by: string;
}): Promise<SaveRulesResult> {
  const current = await getImageRules(db, tenantId, kind);

  let body = current?.body ?? '';
  if (input.clearBody) body = '';
  else if (typeof input.body === 'string' && input.body.trim() !== '') {
    const b = normalizeRuleBody(input.body);
    if (b === null) return { ok: false, reason: 'too_long' };
    body = b;
  }

  let titleMode: TitleMode = current?.titleMode ?? 'none';
  let inspectRetries = current?.inspectRetries ?? DEFAULT_INSPECT_RETRIES;
  if (kind === 'thumbnail') {
    if (input.titleMode !== undefined && input.titleMode !== null) {
      const t = parseTitleMode(input.titleMode);
      if (t === null) return { ok: false, reason: 'bad_value' };
      titleMode = t;
    }
    if (input.inspectRetries !== undefined && input.inspectRetries !== null) {
      const r = parseInspectRetries(input.inspectRetries);
      if (r === null) return { ok: false, reason: 'bad_value' };
      inspectRetries = r;
    }
  } else {
    // ★文中画像には題名・検品を入れない（段階1）
    titleMode = 'none';
    inspectRetries = 0;
  }

  // ★検品の回数を既定から変えたときだけは、本文が空でも行を作る（選んだのに黙って無視しない）
  const untouched = body === '' && titleMode === 'none' && (kind !== 'thumbnail' || inspectRetries === DEFAULT_INSPECT_RETRIES);
  if (!current && untouched) return { ok: true, saved: false };

  await db.upsertImageRule(tenantId, { kind, body, titleMode, inspectRetries, by: input.by });
  // ★監査には本文を入れない（文字数と設定だけ）
  await db.audit(tenantId, 'image_rules.saved', input.by, kind, 'ok', { chars: body.length, titleMode, inspectRetries });
  return { ok: true, saved: true };
}

// ── 参考画像 ─────────────────────────────────────────────
export type RefMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** 先頭バイトで形式を判定する（PNG / JPEG / WebP のみ）。それ以外は null */
export function sniffImageMime(bytes: ArrayBuffer | Uint8Array): RefMime | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** 名前を整える（制御文字・山かっこを落とし、短くする）。空なら既定の名前 */
export function normalizeRefName(v: unknown, fallback = '参考画像'): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim() : '';
  return (s || fallback).slice(0, REF_NAME_MAX);
}

export type RefCheck =
  | { ok: true; mime: RefMime }
  | { ok: false; reason: 'empty' | 'too_large' | 'bad_type' | 'too_many' };

/** アップロードの検査（純関数）。枚数は呼び出し側が数えて渡す */
export function checkRefUpload(bytes: ArrayBuffer | Uint8Array, existingCount: number): RefCheck {
  if (existingCount >= REF_MAX_COUNT) return { ok: false, reason: 'too_many' };
  const size = bytes.byteLength;
  if (size === 0) return { ok: false, reason: 'empty' };
  if (size > REF_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const mime = sniffImageMime(bytes);
  if (!mime) return { ok: false, reason: 'bad_type' };
  return { ok: true, mime };
}

export const REF_REJECT_NOTE: Record<Exclude<RefCheck, { ok: true }>['reason'], string> = {
  empty: '画像が空でした。もう一度選んでください。',
  too_large: `画像が大きすぎます（1枚 ${REF_MAX_BYTES / 1024 / 1024}MB まで）。小さくしてから追加してください。`,
  bad_type: 'PNG・JPEG・WebP の画像だけ追加できます。',
  too_many: `参考画像は ${REF_MAX_COUNT} 枚までです。追加するには、先にどれかを消してください。`,
};

export async function listImageRefs(db: Db, tenantId: string): Promise<ImageRefRow[]> {
  try {
    return await db.listImageRefs(tenantId);
  } catch {
    return []; // 表がまだ無い＝登録なし
  }
}

export type AddRefResult = { ok: true; id: string } | { ok: false; reason: Exclude<RefCheck, { ok: true }>['reason'] };

/** 参考画像を1枚足す。置き場（KV）には期限を切らずに置く（消すまで使うため） */
export async function addImageRef(db: Db, images: ImageStore, tenantId: string, input: {
  name: unknown; bytes: ArrayBuffer; by: string;
}): Promise<AddRefResult> {
  const existing = await db.listImageRefs(tenantId);
  const check = checkRefUpload(input.bytes, existing.length);
  if (!check.ok) return { ok: false, reason: check.reason };

  const id = newId();
  const key = `ref_${tenantId}_${id}`;
  await images.put(key, input.bytes, check.mime, { persistent: true });
  try {
    await db.insertImageRef(tenantId, {
      id, name: normalizeRefName(input.name), r2Key: key, mime: check.mime, sizeBytes: input.bytes.byteLength,
      sort: Math.max(0, ...existing.map((r) => r.sort + 1)),
    });
  } catch (e) {
    await images.delete(key).catch(() => {});
    throw e;
  }
  await db.audit(tenantId, 'image_ref.added', input.by, id, 'ok', { bytes: input.bytes.byteLength, mime: check.mime });
  return { ok: true, id };
}

/** 参考画像を1枚消す（行と置き場の両方）。消せたら true */
export async function deleteImageRef(db: Db, images: ImageStore, tenantId: string, id: string, by: string): Promise<boolean> {
  const row = await db.deleteImageRef(tenantId, id);
  if (!row) return false;
  await images.delete(row.r2_key).catch(() => {});
  await db.audit(tenantId, 'image_ref.deleted', by, id, 'ok');
  return true;
}

export interface LoadedRef extends ReferenceImage { name: string }

/**
 * 画像づくりに渡す参考画像を読む（最大3枚）。置き場から消えていたもの・形式が読めないものは飛ばす。
 * ★読み込みに失敗しても例外を投げない（参考画像なしの従来の作り方で続ける）
 */
export async function loadReferenceImages(db: Db, images: ImageStore, tenantId: string): Promise<LoadedRef[]> {
  const out: LoadedRef[] = [];
  for (const r of (await listImageRefs(db, tenantId)).slice(0, REF_MAX_COUNT)) {
    try {
      const got = await images.get(r.r2_key);
      if (!got) continue;
      const mime = sniffImageMime(got.bytes);
      if (!mime) continue;
      out.push({ bytes: got.bytes, mime, name: r.name });
    } catch { /* 1枚読めなくても続ける */ }
  }
  return out;
}

/** 参考画像つきの指示に必ず足す固定文（設計書 2: ポーズのコピーを防ぐ） */
export const REFERENCE_CLAUSE =
  '参考画像は見た目（顔・髪・服・体型・小物）だけに使う。参考画像のポーズ・構図・差し出す手などは写さず、題名に合う新しいポーズを描く。キャラクターシートのような説明画像にしない。';

/** 題名モードで、記事タイトルを機械的に入れる文（★LLM に言い換えさせない。ここで一字一句そのまま入れる） */
export function titleClause(title: string): string {
  const t = title.replace(/[\r\n]+/g, ' ').trim();
  return `画像の中に、次の文字列を一字一句そのまま描く: 「${t}」。ほかの文字は入れない。`;
}

// ── LINE・画面に出す要約（★本文・画像は出さない。文字数・枚数だけ）──────────
export interface ImageRulesSummary {
  thumbnail: { registered: boolean; chars: number; titleMode: TitleMode; inspectRetries: number };
  inline: { registered: boolean; chars: number };
  refs: Array<{ id: string; name: string; sizeBytes: number }>;
}

export async function loadImageRulesSummary(db: Db, tenantId: string): Promise<ImageRulesSummary> {
  const [t, i, refs] = await Promise.all([
    getImageRules(db, tenantId, 'thumbnail'),
    getImageRules(db, tenantId, 'inline'),
    listImageRefs(db, tenantId),
  ]);
  return {
    thumbnail: {
      registered: Boolean(t),
      chars: t?.body.length ?? 0,
      titleMode: t?.titleMode ?? 'none',
      // 行が無い＝検品しない（今までと同じ）。画面の既定の選択は DEFAULT_INSPECT_RETRIES
      inspectRetries: t ? t.inspectRetries : 0,
    },
    inline: { registered: Boolean(i), chars: i?.body.length ?? 0 },
    refs: refs.map((r) => ({ id: r.id, name: r.name, sizeBytes: r.size_bytes })),
  };
}
