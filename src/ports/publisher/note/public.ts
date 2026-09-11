/**
 * note の公開情報を読む（ログイン不要）。
 *
 * ★Cookie を使わない。
 *   誰でも見られるクリエイターページと同じ経路なので、
 *   拡張機能に投稿を任せている（Cookie を預かっていない）場合でも使える。
 */
import { NOTE_API } from './client';
import { log } from '../../../lib/mask';

/**
 * 1回の取得でこれ以上ページをたどらない（暴走よけ）。
 * note の1ページは6件なので、20ページ＝120件まで。
 *
 * ★無料プランは1リクエストあたり50回までしか外部へ問い合わせできない。
 *   ここを増やすときは、その上限を必ず思い出すこと。
 */
const MAX_PAGES = 20;

/**
 * そのアカウントで**いま公開されている**記事のキー一覧。
 *
 * @param wanted 探している記事のキー。全部見つかった時点で読むのをやめる。
 *   （記事が多い顧客で、無駄にページをたどらないため）
 *
 * @returns 取得できなければ null。
 *   ★失敗を「記事が無い」と取り違えると、生きている記事まで消えたことにしてしまう。
 *   呼び出し側は null のときに何もしないこと。
 *
 * ★**最後のページまで到達できなかったときも null を返す。**
 *   上限で打ち切った一覧は「全体像」ではない。それを実態として扱うと、
 *   読めなかった範囲の記事が全部「消えた」ことになり、
 *   **記事が120件を超えた顧客の古い記事が一覧から消える**（2026-08-30 発見）。
 */
export async function fetchPublishedKeys(
  urlname: string, wanted?: Set<string>,
): Promise<Set<string> | null> {
  if (!urlname) return null;

  const keys = new Set<string>();
  // 探しものが全部見つかったら、そこで打ち切ってよい（残りを読む意味がない）
  const remaining = wanted ? new Set(wanted) : null;
  let reachedEnd = false;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${NOTE_API}/v2/creators/${encodeURIComponent(urlname)}/contents?kind=note&page=${page}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) {
        log.warn('note の公開記事一覧を取得できませんでした', { status: res.status, page });
        return null;
      }

      const json = await res.json() as { data?: { contents?: Array<{ key?: string }>; isLastPage?: boolean } };
      const data = json.data ?? {};
      const contents = data.contents ?? [];
      for (const c of contents) {
        if (!c.key) continue;
        keys.add(c.key);
        remaining?.delete(c.key);
      }

      if (data.isLastPage || contents.length === 0) { reachedEnd = true; break; }

      // 探していたものが全部そろった。ここから先を読んでも判断は変わらない
      if (remaining && remaining.size === 0) { reachedEnd = true; break; }
    }
  } catch (e) {
    log.warn('note の公開記事一覧の取得で例外', String(e));
    return null;
  }

  if (!reachedEnd) {
    // 上限まで読んだが終わりに着かなかった。全体像が分からないので「不明」を返す
    log.warn('note の公開記事一覧が上限ページに達しました（判断を見送ります）', { urlname, maxPages: MAX_PAGES });
    return null;
  }

  return keys;
}
