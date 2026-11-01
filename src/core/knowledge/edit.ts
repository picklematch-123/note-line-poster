/**
 * 設定画面（/setup）からナレッジを確認・修正する（2026-11-01）。
 *
 * ★見るのにも確認コードが要る。ナレッジは顧客の機密で、/setup は誰でも開ける URL のため。
 *   認証は自作しない。LINE「セットアップ」で発行する確認コード（core/setup/state.ts の mayRun）をそのまま使う。
 *
 * ★1回のコードで「開く → 保存」まで済ませる。
 *   確認コードは「開く」で使い切り、保存用に**短命・1回きり**の合言葉（編集用トークン）を KV に置く。
 *   コードを2回取り直させない（遠隔の顧客に「セットアップ」を何度も送ってもらわないため。画像のルールと同じ考え）。
 *   トークンは用途ごとに接頭辞を分ける（setupcode: / pair: と混ぜない）。
 *
 * ★保存は上書きしない。LINE の書き足しと同じく、新しい行を作って古い行を無効にする（履歴が残り、戻せる）。
 *   保存直後は buildProvisionalSnippet（AI を使わない）で記事に効き、整理は Workflow（kind: 'knowledge'）が後から行う。
 *   整理の途中で書き換わった場合に古い結果で上書きしない仕組み（core/knowledge/apply.ts）は、そのまま効く。
 *
 * ★開いている間に LINE で書き足された場合は、保存しない（気づかないまま書き足しを消してしまうため）。
 *   トークンに「開いたときの行」を覚えておき、保存の時点で有効な行が変わっていたら断る。
 */
import type { Db } from '../../ports/storage/db';
import { buildProvisionalSnippet } from '../generation/context';
import type { SetupCodeIssuer } from '../setup/state';

/** 画面から保存できる最大文字数（極端に大きい入力を断る。LINE の1通5000字の制約は画面には無い） */
export const KNOWLEDGE_WEB_MAX = 20000;
/** 最小文字数（LINE の書き足しと同じ。短すぎると記事に反映できない） */
export const KNOWLEDGE_MIN = 10;
/** 編集用トークンの有効時間。長文を読み直して直す時間を見込む */
export const KNOWLEDGE_EDIT_TTL_SEC = 1800;

const tokenKey = (token: string) => `knowledgeedit:${token}`;

export interface KnowledgeEditGrant {
  /** 開くときに使った確認コードの発行者（監査ログの actor に使う） */
  issuer: SetupCodeIssuer;
  /** 開いたときに有効だった行（無ければ null） */
  baseContextId: string | null;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 編集用トークンを発行する（確認コードを使い切ったあとに呼ぶ） */
export async function issueKnowledgeEditToken(kv: KVNamespace, grant: KnowledgeEditGrant): Promise<string> {
  const token = randomToken();
  await kv.put(tokenKey(token), JSON.stringify(grant), { expirationTtl: KNOWLEDGE_EDIT_TTL_SEC });
  return token;
}

function parseGrant(stored: string | null): KnowledgeEditGrant | null {
  if (!stored) return null;
  try {
    const v = JSON.parse(stored) as Partial<KnowledgeEditGrant>;
    if (v.issuer !== 'owner' && v.issuer !== 'admin') return null;
    return { issuer: v.issuer, baseContextId: typeof v.baseContextId === 'string' ? v.baseContextId : null };
  } catch {
    return null;
  }
}

/** 発行したトークンの形（48桁の16進）か。★形が違うものは、こちらが出したものではない */
export function isKnowledgeEditTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[0-9a-f]{48}$/.test(token);
}

/** トークンを見る（使わない）。形が違う・期限切れなら null */
export async function peekKnowledgeEditToken(kv: KVNamespace, token: string | null): Promise<KnowledgeEditGrant | null> {
  if (!isKnowledgeEditTokenShape(token)) return null;
  return parseGrant(await kv.get(tokenKey(token)));
}

/** トークンを使う。使えたら即座に消す（1回きり） */
export async function consumeKnowledgeEditToken(kv: KVNamespace, token: string | null): Promise<KnowledgeEditGrant | null> {
  const grant = await peekKnowledgeEditToken(kv, token);
  if (!grant) return null;
  await kv.delete(tokenKey(token!));
  return grant;
}

export type KnowledgeTextCheck =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' };

/** 入力を整えて検査する（改行を LF にそろえ、前後の空白を落とす） */
export function checkKnowledgeText(input: unknown): KnowledgeTextCheck {
  const text = typeof input === 'string' ? input.replace(/\r\n?/g, '\n').trim() : '';
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length < KNOWLEDGE_MIN) return { ok: false, reason: 'too_short' };
  if (text.length > KNOWLEDGE_WEB_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

/**
 * ★空にして保存＝全部消す、は画面では受け付けない。
 *   LINE には確認つきの「全部消す」があるので、そちらに寄せる（消す操作を2か所に増やさない）。
 */
export const KNOWLEDGE_TEXT_NOTE: Record<Exclude<KnowledgeTextCheck, { ok: true }>['reason'], string> = {
  empty: '空のままでは保存できません。全部消したいときは、LINE で「ナレッジ」→「全部消す」を使ってください。',
  too_short: `短すぎます（${KNOWLEDGE_MIN}字以上にしてください）。短すぎると記事に反映できません。`,
  too_long: `${KNOWLEDGE_WEB_MAX}字を超えています。短くしてください。`,
};

/**
 * 原文を新しい行として保存する（古い行は無効にして残す）。
 * ★保存直後から暫定の前提（AI を使わない）で記事に効く。整理は呼び出し側が Workflow で始める
 */
export async function saveKnowledgeText(db: Db, tenantId: string, text: string, by: string): Promise<string> {
  return db.saveContext(tenantId, text, null, buildProvisionalSnippet(text), by);
}
