import { describe, it, expect, vi, afterEach } from 'vitest';
import { reconcilePublished } from '../../src/core/article/reconcile';
import { fetchPublishedKeys } from '../../src/ports/publisher/note/public';
import type { Db } from '../../src/ports/storage/db';

// note の画面から記事を消しても、こちらの記録は「公開済み」のまま残る。
// その結果、一覧に開けない記事が並ぶ（2026-08-29 運用側の判断）。
//
// ★取得に失敗したときに「消えた」と誤判定しないことが、この機能の生命線。
//   誤判定すると、生きている記事まで一覧から消える。

/** 公開一覧の応答を組み立てる。 */
function page(keys: string[], isLastPage = true) {
  return new Response(JSON.stringify({
    data: { contents: keys.map((key) => ({ key, status: 'published' })), isLastPage },
  }), { status: 200 });
}

function fakeDb(published: Array<{ id: string; note_key: string | null }>) {
  const marked: string[][] = [];
  return {
    marked,
    listPublishedNoteKeys: async () => published,
    markRemovedFromNote: async (ids: string[]) => { marked.push(ids); },
  } as unknown as Db & { marked: string[][] };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('note の公開一覧を読む', () => {
  it('キーを集めて返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nAAA', 'nBBB']));
    const keys = await fetchPublishedKeys('someone');
    expect([...keys!]).toEqual(['nAAA', 'nBBB']);
  });

  it('★複数ページを最後までたどる', async () => {
    const pages = [page(['n1'], false), page(['n2'], false), page(['n3'], true)];
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pages[i++]);

    const keys = await fetchPublishedKeys('someone');
    expect([...keys!].sort()).toEqual(['n1', 'n2', 'n3']);
    expect(i).toBe(3);
  });

  it('中身が空になったら止まる', async () => {
    const pages = [page(['n1'], false), page([], false)];
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pages[Math.min(i++, 1)]);
    expect([...(await fetchPublishedKeys('someone'))!]).toEqual(['n1']);
    expect(i).toBe(2);
  });

  it('★取得に失敗したら null（「0件」と区別する）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }));
    expect(await fetchPublishedKeys('someone')).toBeNull();
  });

  it('★通信が落ちても例外を投げず null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('offline'); });
    expect(await fetchPublishedKeys('someone')).toBeNull();
  });

  it('アカウント名が無ければ問い合わせない', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchPublishedKeys('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('★ページ上限で打ち切ったら「取得できなかった」扱いにする', async () => {
    // ★ここを取り違えると、記事が増えた顧客の**生きている記事が一覧から消える**。
    //   上限まで読んでも最後まで到達していない＝全体像が分かっていない、ということ。
    //   note の1ページは6件なので、上限20ページ＝120件。これを超えた顧客で起きる。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nX'], false));

    const result = await fetchPublishedKeys('someone');
    expect(result).toBeNull();
  });

  it('探している記事が全部見つかったら、そこで読むのをやめる', async () => {
    // 無駄なページ取得をしない（無料プランはサブリクエスト50回/リクエストが上限）
    const pages = [page(['n1', 'n2'], false), page(['n3'], false), page(['n4'], true)];
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pages[Math.min(i++, 2)]);

    const keys = await fetchPublishedKeys('someone', new Set(['n1', 'n2']));
    expect(keys).not.toBeNull();
    expect(i).toBe(1);              // 1ページで足りる
    expect(keys!.has('n1')).toBe(true);
  });

  it('★ログイン情報を送らない（拡張に投稿を任せていても使える）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['n1']));
    await fetchPublishedKeys('someone');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/cookie/i);
  });
});

describe('note の実態との突き合わせ', () => {
  const rows = [
    { id: 'a1', note_key: 'nALIVE' },
    { id: 'a2', note_key: 'nGONE' },
  ];

  it('note に無い記事だけ一覧から外す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nALIVE']));
    const db = fakeDb(rows);

    const result = await reconcilePublished(db, 'tenant_default', 'someone');

    expect(result).toEqual({ removed: 1, checked: true });
    expect(db.marked).toEqual([['a2']]);
  });

  it('全部生きていれば何もしない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nALIVE', 'nGONE']));
    const db = fakeDb(rows);

    expect(await reconcilePublished(db, 'tenant_default', 'someone')).toEqual({ removed: 0, checked: true });
    expect(db.marked).toEqual([]);
  });

  it('★note に問い合わせできなければ、何も外さない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    const db = fakeDb(rows);

    expect(await reconcilePublished(db, 'tenant_default', 'someone')).toEqual({ removed: 0, checked: false });
    expect(db.marked).toEqual([]);
  });

  it('★記事が多くて最後まで読めなかったら、1件も外さない', async () => {
    // 「読めた範囲に無い＝消えた」と判断すると、古い記事が全部消える。
    // 一覧に古い記録が残るほうが、生きている記事を隠すより、はるかにまし。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nNEW'], false));
    const db = fakeDb([{ id: 'a1', note_key: 'nOLD' }, { id: 'a2', note_key: 'nNEW' }]);

    const r = await reconcilePublished(db, 't1', 'someone');
    expect(r.checked).toBe(false);
    expect(r.removed).toBe(0);
    expect(db.marked).toEqual([]);
  });

  it('★note が0件を返したら判断しない（全消しの事故を防ぐ）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page([]));
    const db = fakeDb(rows);

    expect(await reconcilePublished(db, 'tenant_default', 'someone')).toEqual({ removed: 0, checked: false });
    expect(db.marked).toEqual([]);
  });

  it('アカウント名が分からなければ何もしない', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const db = fakeDb(rows);

    expect(await reconcilePublished(db, 'tenant_default', null)).toEqual({ removed: 0, checked: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('公開済みの記録が無ければ問い合わせない', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const db = fakeDb([]);

    expect(await reconcilePublished(db, 'tenant_default', 'someone')).toEqual({ removed: 0, checked: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('note キーを持たない記録は対象外', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page(['nALIVE']));
    const db = fakeDb([{ id: 'a1', note_key: 'nALIVE' }, { id: 'a3', note_key: null }]);

    expect(await reconcilePublished(db, 'tenant_default', 'someone')).toEqual({ removed: 0, checked: true });
    expect(db.marked).toEqual([]);
  });
});
