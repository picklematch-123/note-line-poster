/**
 * 画像の作り直し・自動生成の「いま作っている最中」の印（記事 × 種類ごとの KV ロック）。
 *
 * ★なぜ要るか（2026-10-24 源蔵レビュー P3 必須1）:
 *   「作り直す」の二度押し・古いプレビューのボタンで、同じ記事の画像づくりが2本同時に走ると、
 *   予約が倍になって1記事の上限をすぐ使い切り（＝二重に課金）、同じ番号の画像が2つ残って本文が壊れる。
 *   取れなかったら「いま作成中です」と返し、予約も Workflow の起動もしない。
 *
 * ★KV には「無ければ書く」が無い。書いたあと読み直して、自分の値が残っていたときだけ取れたとみなす
 *   （同時に2つ来ても、後から書いたほうだけが取れる）。それでも完全ではないため、
 *   同じ番号の行が2つ残らないよう、保存側でも畳む（inline.ts の foldGeneratedDuplicates）。
 * ★期限は10分。Workflow が終わる・失敗したら必ず外す。外し損ねても10分で自然に切れる。
 */
export type ImageLockKind = 'inline' | 'thumb';

/** ロックの期限（秒）。KV の最短は60秒 */
export const IMAGE_LOCK_TTL_SEC = 600;

/** KV のうち、ここで使う部分だけ（テストで差し替えられるように） */
export interface LockKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function imageLockKey(kind: ImageLockKind, articleId: string): string {
  return `imglock:${kind}:${articleId}`;
}

/**
 * ロックを取る。同じ token がすでに持っていれば取れたとみなす（Workflow のやり直しでも同じ結果になる）。
 * ★書き込みに失敗したとき（KV の同時書き込み制限など）は「取れなかった」側に倒す
 */
export async function acquireImageLock(
  kv: LockKv, kind: ImageLockKind, articleId: string, token: string,
): Promise<boolean> {
  const key = imageLockKey(kind, articleId);
  try {
    const current = await kv.get(key);
    if (current && current !== token) return false;
    await kv.put(key, token, { expirationTtl: IMAGE_LOCK_TTL_SEC });
    return (await kv.get(key)) === token;
  } catch {
    return false;
  }
}

/** 自分が持っているときだけ期限を延ばす（1枚ずつ作る間に10分を過ぎないように） */
export async function refreshImageLock(
  kv: LockKv, kind: ImageLockKind, articleId: string, token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  const key = imageLockKey(kind, articleId);
  try {
    if ((await kv.get(key)) === token) await kv.put(key, token, { expirationTtl: IMAGE_LOCK_TTL_SEC });
  } catch { /* 延ばせなくても期限で切れるだけ */ }
}

/** 自分が持っているときだけ外す（他の人が取り直したロックを消さない）。例外は投げない */
export async function releaseImageLock(
  kv: LockKv, kind: ImageLockKind, articleId: string, token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  const key = imageLockKey(kind, articleId);
  try {
    if ((await kv.get(key)) === token) await kv.delete(key);
  } catch { /* 外せなくても期限で切れる */ }
}

/**
 * ロックを取ってから仕事を始める（LINE の「作り直す」ボタンの入口）。
 * 取れなければ何もしない（予約も Workflow の起動もしない）。始められなかったらロックを外す。
 * @param start 取れたときだけ呼ぶ。token を Workflow に渡し、Workflow 側が終わったら外す
 */
export async function startLockedImageJob(
  kv: LockKv, kind: ImageLockKind, articleId: string, token: string,
  start: (token: string) => Promise<void>,
): Promise<'started' | 'locked'> {
  if (!(await acquireImageLock(kv, kind, articleId, token))) return 'locked';
  try {
    await start(token);
  } catch (e) {
    await releaseImageLock(kv, kind, articleId, token);
    throw e;
  }
  return 'started';
}

/**
 * 作り直しを受け付けてよい状態か。
 * ★確認待ち（awaiting_approval）だけ。preview_ready は「まだ記事（文中の画像）を作っている最中」なので、
 *   古いプレビューのボタンで自動生成と作り直しが同時に走らないよう断る
 */
export function regenStateCheck(state: string | null | undefined): 'ok' | 'generating' | 'bad_state' {
  if (state === 'awaiting_approval') return 'ok';
  if (state === 'preview_ready') return 'generating';
  return 'bad_state';
}

export const NOTE_STILL_GENERATING = 'まだ記事を作っている最中です。プレビューが届いてから、もう一度押してください。';
export const NOTE_INLINE_LOCKED = 'いま文中の画像を作成中です。終わったら LINE でお知らせしますので、少しお待ちください。';
export const NOTE_THUMB_LOCKED = 'いまサムネを作成中です。終わったら LINE でお知らせしますので、少しお待ちください。';
/** 自動生成の最中に、作り直しのロックが残っていたとき（プレビューの理由に出す） */
export const NOTE_INLINE_BUSY_AUTO = '文中の画像を作り直している最中だったため、今回は新しく作りませんでした';
