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

/**
 * /api/v3/notes/<key> から読む、1本の記事のいまの姿。
 *
 * ★実測（2026-11-24・自社アカウントの試験記事）:
 *   ・`index` は「目次を出すか」の真偽ではなく、**目次の中身（見出しの配列）**が返る。
 *     目次オンなら見出しの数だけ入り、オフなら空配列。見出しの無い記事では、オンかオフか見分けられない
 *   ・`exclude_from_creator_top` / `exclude_ai_learning_reward` は送った値がそのまま返る
 *   ・`disable_comment` は公開時に true を送っても false のまま返った（公開の送信では効いていない）
 *   ・`updated_at` は返らない。`publish_at` は上書き更新しても変わらない
 *   ・ログインして読むと `is_my_note` が true になる。本文はログインの有無で同じ
 *
 * 設定項目が読み取れないときは null にする（★false と取り違えない。呼び出し側は null なら送らない）。
 */
export interface PublicNote {
  id: number;
  key: string;
  status: string;
  /** タイトル */
  name: string;
  /** note に入っている本文 HTML（エディタの形のまま） */
  body: string;
  /** いま付いているタグ（返ってきた文字列のまま。「#」付き） */
  hashtags: string[];
  price: number;
  isLimited: boolean;
  /** 有料部分の区切り。無料記事なら null */
  separator: string | null;
  /** 入っているマガジン（送り直すと外れるおそれがあるので、付け直しでは避ける） */
  magazineKeys: string[];
  /** 目次を出しているか（見分けられなければ null） */
  index: boolean | null;
  disableComment: boolean | null;
  excludeFromCreatorTop: boolean | null;
  excludeAiLearning: boolean | null;
  /** 公開後に note の画面で編集中の下書きがあるか */
  hasDraft: boolean;
  /** 自分の記事か（ログインして読んだときだけ分かる。分からなければ null） */
  isMyNote: boolean | null;
}

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** 本文に見出し（h2/h3）があるか。目次のオン・オフを見分けられるかの判定に使う */
function hasHeadings(body: string): boolean {
  return /<h[23][\s>]/i.test(body);
}

/** v3 の data を読む（純関数）。形が想定と違えば null。 */
export function parseNoteDetail(d: any, fallbackKey = ''): PublicNote | null {
  if (!d || typeof d !== 'object' || typeof d.body !== 'string') return null;
  const body: string = d.body;
  let index: boolean | null = null;
  if (Array.isArray(d.index)) {
    if (d.index.length > 0) index = true;
    else if (hasHeadings(body)) index = false; // 見出しがあるのに目次が空＝オフ
    // 見出しが無いときは見分けられない（null のまま）
  }
  return {
    id: Number(d.id),
    key: String(d.key ?? fallbackKey),
    status: String(d.status ?? ''),
    name: String(d.name ?? ''),
    body,
    hashtags: Array.isArray(d.hashtag_notes)
      ? d.hashtag_notes.map((h: any) => h?.hashtag?.name).filter((n: unknown): n is string => typeof n === 'string')
      : [],
    price: Number(d.price ?? 0),
    isLimited: Boolean(d.is_limited),
    separator: d.separator ?? null,
    magazineKeys: Array.isArray(d.belonging_magazine_keys) ? d.belonging_magazine_keys : [],
    index,
    disableComment: boolOrNull(d.disable_comment),
    excludeFromCreatorTop: boolOrNull(d.exclude_from_creator_top),
    excludeAiLearning: boolOrNull(d.exclude_ai_learning_reward),
    hasDraft: d.has_draft === true,
    isMyNote: boolOrNull(d.is_my_note),
  };
}

/**
 * 公開中の記事を1本読む（ログイン不要）。
 * ★読めなかったときは null（呼び出し側は「何もしない」に倒すこと）。
 * ★付け直しはこちらではなく、ログインして読む NoteClient.getNote を使う（自分の記事か確かめられるため）
 */
export async function fetchPublicNote(key: string): Promise<PublicNote | null> {
  if (!/^n[0-9a-z]+$/i.test(key)) return null;
  try {
    const res = await fetch(`${NOTE_API}/v3/notes/${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      log.warn('note の記事を取得できませんでした', { status: res.status });
      return null;
    }
    return parseNoteDetail(((await res.json()) as { data?: unknown }).data, key);
  } catch (e) {
    log.warn('note の記事の取得で例外', String(e));
    return null;
  }
}
