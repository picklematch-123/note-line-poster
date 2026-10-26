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
  // ★かぎかっこも落とす（指示文の「…」を閉じて、別の指示を差し込めないように）
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>「」]/g, '').trim() : '';
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

export interface LoadedRef extends ReferenceImage { id: string; name: string }

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
      out.push({ id: r.id, bytes: got.bytes, mime, name: r.name });
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

// ── 参考画像のランダム選択（2026-10-27）─────────────────────
/**
 * 「記事ごとに、登録したキャラクターからランダムに選んで使う」設定。system_flags の数値（0/1）。
 * ★既定 0（今までどおり、登録した参考画像を全部渡す）。読めないときも 0 側に倒す
 */
export const FLAG_REF_RANDOM = 'image_ref_random';

export async function getRefRandom(db: Db): Promise<boolean> {
  try {
    return (await db.getNumberFlag(FLAG_REF_RANDOM, 0)) === 1;
  } catch {
    return false;
  }
}

export async function setRefRandom(db: Db, on: boolean, by: string): Promise<void> {
  await db.setNumberFlag(FLAG_REF_RANDOM, on ? 1 : 0, '参考画像のランダム選択', by);
}

/** n 枚から選べる組（大きさ1または2・並びは登録順）。3枚なら 単独3通り＋2枚組3通り＝6通り */
export function refSubsets(n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push([i]);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

/**
 * 組を1つ選ぶ（どの組も同じ確率）。rng は 0 以上 1 未満を返す関数（テストで固定するため注入できる）。
 * 0枚なら空
 */
export function pickRefSubset(n: number, rng: () => number = Math.random): number[] {
  const all = refSubsets(Math.min(Math.max(0, Math.floor(n)), REF_MAX_COUNT));
  if (!all.length) return [];
  const r = rng();
  const i = Math.min(all.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * all.length)));
  return all[i];
}

/** 並びを保ったまま、選んだ組だけを返す */
export function selectRefs<T>(refs: T[], rng: () => number = Math.random): T[] {
  return pickRefSubset(refs.length, rng).map((i) => refs[i]);
}

/**
 * どの参考画像が誰か（名前は顧客が登録した文字列そのまま）。ランダム選択のときに指示に足す。
 * 例: 「参考画像は2枚。1枚目は「〇〇」、2枚目は「△△」。この画像に登場させるのは、この2人だけ。」
 */
export function refNamesClause(names: string[]): string {
  if (!names.length) return '';
  const each = names.map((n, i) => `${i + 1}枚目は「${n.replace(/[\r\n]+/g, ' ')}」`).join('、');
  return `参考画像は${names.length}枚。${each}。この画像に登場させるキャラクターは、${names.length === 1 ? 'この1人' : `この${names.length}人`}だけ。`;
}

// ── 画面から、まとめて保存する（1回のコードで。2026-10-27）──────────
export interface BatchUpload { name: unknown; bytes: ArrayBuffer }
export interface ImageSettingsBatchInput {
  thumbBody?: unknown; thumbClear?: boolean; thumbTitleMode?: unknown; thumbInspect?: unknown;
  inlineBody?: unknown; inlineClear?: boolean;
  /** '0' / '1'。undefined = 変えない */
  refRandom?: unknown;
  /** 消す参考画像の id */
  deleteIds: string[];
  /** 足す参考画像 */
  uploads: BatchUpload[];
}

export interface ValidatedBatch {
  input: ImageSettingsBatchInput;
  uploads: Array<{ name: string; bytes: ArrayBuffer; mime: RefMime }>;
  deleteIds: string[];
  refRandom: boolean | null;
}

/**
 * ★全部を検査する（何も書かない）。1つでもだめなら理由の一覧を返す。
 *   呼び出し側は、これが通ってからコードを使い、書き込む（コードを無駄にさせない・半端に保存しない）
 */
export function validateImageSettingsBatch(input: ImageSettingsBatchInput, currentRefIds: string[]):
  { ok: true; batch: ValidatedBatch } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const [label, v] of [['サムネ用のルール', input.thumbBody], ['文中の画像用のルール', input.inlineBody]] as const) {
    if (typeof v === 'string' && normalizeRuleBody(v) === null) errors.push(`${label}が${RULE_BODY_MAX}字を超えています`);
  }
  if (input.thumbTitleMode !== undefined && input.thumbTitleMode !== null && parseTitleMode(input.thumbTitleMode) === null) {
    errors.push('サムネのタイトルの選び方が読めませんでした');
  }
  if (input.thumbInspect !== undefined && input.thumbInspect !== null && input.thumbInspect !== '' && parseInspectRetries(input.thumbInspect) === null) {
    errors.push('作り直しの回数が読めませんでした');
  }
  let refRandom: boolean | null = null;
  if (input.refRandom !== undefined && input.refRandom !== null) {
    if (input.refRandom === '1' || input.refRandom === 1) refRandom = true;
    else if (input.refRandom === '0' || input.refRandom === 0) refRandom = false;
    else errors.push('キャラクターの選び方が読めませんでした');
  }
  const deleteIds = [...new Set(input.deleteIds)];
  for (const id of deleteIds) if (!currentRefIds.includes(id)) errors.push('消す参考画像が見つかりませんでした（画面を開き直してください）');
  const uploads: ValidatedBatch['uploads'] = [];
  input.uploads.forEach((u, i) => {
    const c = checkRefUpload(u.bytes, 0);
    if (!c.ok) errors.push(`追加する参考画像 ${i + 1} 枚目: ${REF_REJECT_NOTE[c.reason]}`);
    else uploads.push({ name: normalizeRefName(u.name), bytes: u.bytes, mime: c.mime });
  });
  if (currentRefIds.length - deleteIds.filter((id) => currentRefIds.includes(id)).length + input.uploads.length > REF_MAX_COUNT) {
    errors.push(REF_REJECT_NOTE.too_many);
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, batch: { input, uploads, deleteIds, refRandom } };
}

/** 書き込みの直前に、枚数が変わっていて上限を超える（同時に別の保存があった）。何も書いていない */
export class BatchCountChanged extends Error {
  constructor() { super('参考画像の枚数が変わっていました'); }
}

/**
 * 書き込みの途中で失敗した（★元に戻す処理まで済ませてから投げる）。
 * rollbackFailed が空なら「何も保存していない」と言ってよい。空でなければ、戻せなかった項目の名前が入る
 */
export class BatchWriteFailed extends Error {
  constructor(readonly cause: unknown, readonly rollbackFailed: string[]) {
    super('画像のルールのまとめ保存に失敗しました');
  }
}

export interface BatchResult {
  added: number;
  deleted: number;
  /** 消せなかった枚数（★ほかの保存は済んでいる） */
  deleteFailed: number;
  thumb: SaveRulesResult;
  inline: SaveRulesResult;
}

/**
 * 検査済みのまとめを書き込む。
 *
 * ★「全部入るか、何も入らないか」（合格ライン③）。①〜④のどこで失敗しても、書く前の状態に戻す:
 *   書く前に、ルール2行（種類ごとの行そのもの、または「無い」）と image_ref_random の値（または「無い」）を控えておき、
 *   ①参考画像を足す → ②サムネ用ルール → ③文中画像用ルール → ④ランダム選択の設定・監査記録
 *   のどこかで例外が出たら、足した画像を消し、ルールと設定を控えに戻してから BatchWriteFailed を投げる。
 *   ★監査記録の失敗も「失敗」として全部取り消す（保存したのに記録が無い、を残さない）。
 *   戻す処理の失敗は握りつぶさず、ログに出して rollbackFailed に入れる（画面の文言を事実と合わせるため）。
 * ★⑤参考画像の削除は最後に、1枚ずつ失敗を受け止める（ここでの失敗は取り消さない＝ほかは保存済み）。
 *   消せなかった枚数を結果に持たせ、画面は「保存しました（N枚は消せませんでした）」と言う。
 * ★書く直前に枚数をもう一度数える（コードを2つ使った同時送信で3枚を超えないように）。
 */
export async function applyImageSettingsBatch(db: Db, images: ImageStore, tenantId: string, batch: ValidatedBatch, by: string):
  Promise<BatchResult> {
  const existing = await db.listImageRefs(tenantId);
  const remain = existing.filter((r) => !batch.deleteIds.includes(r.id)).length;
  if (remain + batch.uploads.length > REF_MAX_COUNT) throw new BatchCountChanged();

  // ── 控え（書く前の状態）──
  const before = {
    thumbnail: await db.getImageRule(tenantId, 'thumbnail'),
    inline: await db.getImageRule(tenantId, 'inline'),
    refRandom: (await db.raw.prepare('SELECT value, reason, updated_by, updated_at FROM system_flags WHERE key = ?')
      .bind(FLAG_REF_RANDOM).first<{ value: string; reason: string | null; updated_by: string | null; updated_at: string | null }>()) ?? null,
  };

  let sort = Math.max(0, ...existing.map((r) => r.sort + 1));
  const added: Array<{ id: string; key: string }> = [];
  let thumb: SaveRulesResult;
  let inline: SaveRulesResult;
  try {
    for (const u of batch.uploads) {
      const id = newId();
      const key = `ref_${tenantId}_${id}`;
      await images.put(key, u.bytes, u.mime, { persistent: true });
      added.push({ id, key });
      await db.insertImageRef(tenantId, { id, name: u.name, r2Key: key, mime: u.mime, sizeBytes: u.bytes.byteLength, sort: sort++ });
    }
    const i = batch.input;
    thumb = await saveImageRules(db, tenantId, 'thumbnail', {
      body: i.thumbBody, clearBody: i.thumbClear, titleMode: i.thumbTitleMode,
      inspectRetries: i.thumbInspect === '' ? undefined : i.thumbInspect, by,
    });
    inline = await saveImageRules(db, tenantId, 'inline', { body: i.inlineBody, clearBody: i.inlineClear, by });
    if (!thumb.ok || !inline.ok) throw new Error('検査を通ったのにルールを保存できませんでした');
    if (batch.refRandom !== null) await setRefRandom(db, batch.refRandom, by);
    for (const a of added) await db.audit(tenantId, 'image_ref.added', by, a.id, 'ok', { batch: true });
  } catch (e) {
    const rollbackFailed: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (err) {
        rollbackFailed.push(label);
        log.error(`まとめ保存の取り消しに失敗（${label}）`, String(err).slice(0, 120));
      }
    };
    for (const a of [...added].reverse()) {
      await attempt('追加した参考画像', () => db.raw.prepare('DELETE FROM image_refs WHERE tenant_id = ? AND id = ?').bind(tenantId, a.id).run());
      await attempt('追加した参考画像の置き場', () => images.delete(a.key));
    }
    for (const kind of ['thumbnail', 'inline'] as const) {
      const row = before[kind];
      await attempt(kind === 'thumbnail' ? 'サムネ用のルール' : '文中の画像用のルール', () => row
        ? db.raw.prepare(`INSERT INTO image_rules (tenant_id, kind, body, title_mode, inspect_retries, updated_by, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(tenant_id, kind) DO UPDATE SET body = excluded.body, title_mode = excluded.title_mode,
                            inspect_retries = excluded.inspect_retries, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .bind(tenantId, kind, row.body, row.title_mode, row.inspect_retries, row.updated_by ?? null, row.updated_at ?? null).run()
        : db.raw.prepare('DELETE FROM image_rules WHERE tenant_id = ? AND kind = ?').bind(tenantId, kind).run());
    }
    const f = before.refRandom;
    await attempt('キャラクターの使い方', () => f
      ? db.raw.prepare(`INSERT INTO system_flags (key, value, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, reason = excluded.reason,
                          updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(FLAG_REF_RANDOM, f.value, f.reason, f.updated_by, f.updated_at).run()
      : db.raw.prepare('DELETE FROM system_flags WHERE key = ?').bind(FLAG_REF_RANDOM).run());
    throw new BatchWriteFailed(e, rollbackFailed);
  }

  // ⑤ 削除（最後・1枚ずつ受け止める）
  let deleted = 0;
  let deleteFailed = 0;
  for (const id of batch.deleteIds) {
    try {
      if (await deleteImageRef(db, images, tenantId, id, by)) deleted++;
    } catch (err) {
      deleteFailed++;
      log.warn('参考画像を消せませんでした（ほかの保存は済んでいます）', String(err).slice(0, 120));
    }
  }
  return { added: added.length, deleted, deleteFailed, thumb, inline };
}

// ── LINE・画面に出す要約（★本文・画像は出さない。文字数・枚数だけ）──────────
export interface ImageRulesSummary {
  thumbnail: { registered: boolean; chars: number; titleMode: TitleMode; inspectRetries: number };
  inline: { registered: boolean; chars: number };
  refs: Array<{ id: string; name: string; sizeBytes: number }>;
  /** 参考画像を記事ごとにランダムに選ぶか */
  refRandom: boolean;
}

export async function loadImageRulesSummary(db: Db, tenantId: string): Promise<ImageRulesSummary> {
  const [t, i, refs, refRandom] = await Promise.all([
    getImageRules(db, tenantId, 'thumbnail'),
    getImageRules(db, tenantId, 'inline'),
    listImageRefs(db, tenantId),
    getRefRandom(db),
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
    refRandom,
  };
}
