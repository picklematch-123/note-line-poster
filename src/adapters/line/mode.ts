/**
 * LINE の「いま何を待っているか」を保持する。
 *
 * LINE は1本のトーク画面しかないので、次のメッセージが何を意味するかは
 * 直前の操作で決まる。その状態をここに集約する。
 * KV に短い寿命で置き、放置されたら自然に消えるようにしている。
 */

export type ModeKind =
  | 'ctx_new'        // ナレッジを入れ替える入力待ち
  | 'ctx_append'     // ナレッジに書き足す入力待ち
  | 'ctx_delete'     // 消すナレッジの番号待ち
  | 'article_new'    // 記事のネタ入力待ち
  | 'article_select'; // 一覧から連番で選ぶ待ち

export interface Mode {
  kind: ModeKind;
  /** article_select のとき、連番に対応する記事IDの並び */
  ids?: string[];
}

/** 放置されたモードは10分で消える。 */
const TTL = 600;

const key = (tenantId: string) => `mode:${tenantId}`;

export async function setMode(kv: KVNamespace, tenantId: string, mode: Mode): Promise<void> {
  await kv.put(key(tenantId), JSON.stringify(mode), { expirationTtl: TTL });
}

export async function getMode(kv: KVNamespace, tenantId: string): Promise<Mode | null> {
  const raw = await kv.get(key(tenantId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Mode;
  } catch {
    return null;
  }
}

export async function clearMode(kv: KVNamespace, tenantId: string): Promise<void> {
  await kv.delete(key(tenantId));
}

/** 「1」「1番」「２」などから連番を取り出す。全角数字にも対応する。 */
export function parseIndex(text: string): number | null {
  const normalized = text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /^(\d{1,2})\s*(番|番目)?$/.exec(normalized);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/**
 * コマンド判定用に文字列をならす。
 *
 * リッチメニューは LINE公式アカウントマネージャー（GUI）でも作れる。
 * GUI で入力された文言は、見た目が同じでも文字コードが違うことがあるため、
 * 1文字の違いでボタンが効かなくなる事故を防ぐ。
 *   ・中黒の揺れ（・ U+30FB / ･ U+FF65 / · U+00B7 / ‧ U+2027）
 *   ・全角英数字・全角スペース
 *   ・前後と途中の空白
 */
export function normalizeCommand(input: string): string {
  return input
    .normalize('NFKC')                    // 全角英数・半角カナなどを標準形に
    .replace(/[・･·‧∙•]/g, '・')          // 中黒の揺れを1つに寄せる
    .replace(/\s+/g, '')                  // 空白は全部落とす
    .trim();
}
