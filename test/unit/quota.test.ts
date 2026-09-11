/**
 * LINE の通数を数えて、使いすぎる前に知らせる。
 *
 * ★無料プランは1か月200通。超えると通知が届かなくなり、
 *   「公開したのに知らせが来ない」が起きる。気づける形にしておく。
 *
 * ★**超えても勝手に課金はされない**（無料プランは超えて送れない仕様）。
 *   ここを「超過料金がかかる」と書くと、顧客を無用に怖がらせる。文面を検査で固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  recordPush, buildQuotaWarning, monthKey, FREE_LIMIT, THRESHOLDS,
  markLimitReached, takeLimitNotice, buildLimitReachedNotice,
} from '../../src/core/line/quota';

function fakeKv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, string> };
}

const M = monthKey();

describe('通数を数える', () => {
  it('送るたびに増える', async () => {
    const kv = fakeKv();
    expect((await recordPush(kv)).total).toBe(1);
    expect((await recordPush(kv)).total).toBe(2);
  });

  it('区切りを越えていなければ知らせない', async () => {
    const kv = fakeKv({ [`linecount:${M}`]: '50' });
    expect((await recordPush(kv)).crossed).toBeNull();
  });

  it('★100 / 150 / 190 を越えたときだけ知らせる', async () => {
    for (const t of THRESHOLDS) {
      const kv = fakeKv({ [`linecount:${M}`]: String(t - 1) });
      expect((await recordPush(kv)).crossed, `${t} で知らせるはず`).toBe(t);
    }
  });

  it('★同じ区切りで二度は知らせない', async () => {
    const kv = fakeKv({ [`linecount:${M}`]: '99' });
    expect((await recordPush(kv)).crossed).toBe(100);
    // 記録を戻しても、警告済みなので知らせない
    kv.store[`linecount:${M}`] = '99';
    expect((await recordPush(kv)).crossed).toBeNull();
  });

  it('一気にまたいでも、警告は1回だけ（大きいほうを出す）', async () => {
    const kv = fakeKv({ [`linecount:${M}`]: '95' });
    expect((await recordPush(kv, 60)).crossed).toBe(150);
  });

  it('★数えられなくても送信は止めない', async () => {
    const broken = { get: async () => { throw new Error('down'); } } as unknown as KVNamespace;
    const r = await recordPush(broken);
    expect(r.crossed).toBeNull();   // 例外を投げない
  });

  it('月が変わると数え直す', () => {
    const jan = monthKey(new Date('2026-01-15T00:00:00Z'));
    const feb = monthKey(new Date('2026-02-15T00:00:00Z'));
    expect(jan).not.toBe(feb);
  });

  it('日本時間で締める（月末の夜に前月扱いにならない）', () => {
    // 1月31日 23:00 JST = 1月31日 14:00 UTC
    expect(monthKey(new Date('2026-01-31T14:00:00Z'))).toBe('2026-01');
    // 2月1日 0:00 JST = 1月31日 15:00 UTC
    expect(monthKey(new Date('2026-01-31T15:00:00Z'))).toBe('2026-02');
  });
});

describe('知らせる文面', () => {
  it('残りの通数と、何が起きるかを書く', () => {
    const msg = buildQuotaWarning(190, 190);
    expect(msg).toContain(`${FREE_LIMIT}`);
    expect(msg).toContain('残り');
    expect(msg).toContain('届かなくなります');
  });

  it('★返信は数に入らないことを明記する（誤解を招かない）', () => {
    expect(buildQuotaWarning(100, 100)).toContain('返信は通数に含まれません');
  });

  it('190 を越えたときは、対処まで書く', () => {
    const msg = buildQuotaWarning(192, 190);
    expect(msg).toContain('修正回数');
    expect(msg).toContain('月額プラン');
  });
});

// ── 上限に達したあと ──────────────────────────────────
describe('上限に達したとき', () => {
  it('★勝手に課金される、と読める書き方をしていない', () => {
    const notice = buildLimitReachedNotice();
    expect(notice).toContain('自動で料金が発生することはありません');
    expect(notice).not.toMatch(/超過料金|追加料金が|自動で請求/);
  });

  it('待つ・note から直接出す・プランを上げる、の3つを出す', () => {
    const notice = buildLimitReachedNotice();
    expect(notice).toContain('来月まで待つ');
    expect(notice).toContain('note の画面から直接投稿');
    expect(notice).toContain('5,000円');
  });

  it('返信は届き続けることを伝える（操作そのものは止まらない）', () => {
    expect(buildLimitReachedNotice()).toContain('返信」は、これまでどおり届きます');
  });

  it('★190 の警告に、上限後の話をまとめて入れておく', () => {
    // 200 に達したあとは、こちらから知らせを送れない。190 が最後の機会
    const w = buildQuotaWarning(190, 190);
    expect(w).toContain('自動で料金が発生することはありません');
    expect(w).toContain('note の画面から直接投稿');
  });

  it('100 の時点では、まだ選択肢まで出さない（早すぎる）', () => {
    expect(buildQuotaWarning(100, 100)).not.toContain('5,000円');
  });
});

describe('上限を伝える段取り', () => {
  it('LINE に断られていなければ、何も言わない', async () => {
    expect(await takeLimitNotice(fakeKv())).toBeNull();
  });

  it('断られたら伝える。ただし★1回だけ', async () => {
    const kv = fakeKv();
    await markLimitReached(kv);
    expect(await takeLimitNotice(kv)).toContain('上限（200通）に達しました');
    expect(await takeLimitNotice(kv)).toBeNull();
  });

  it('月が変わればまた伝える', async () => {
    const kv = fakeKv();
    const jan = new Date('2026-01-15T00:00:00Z');
    await markLimitReached(kv, jan);
    expect(await takeLimitNotice(kv, jan)).not.toBeNull();
    // 翌月は別のキーなので、断られていなければ黙る
    expect(await takeLimitNotice(kv, new Date('2026-02-15T00:00:00Z'))).toBeNull();
  });

  it('★KV が読めないときは黙る（同じ知らせを繰り返さない）', async () => {
    const broken = { get: async () => { throw new Error('down'); },
                     put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
    expect(await takeLimitNotice(broken)).toBeNull();
  });
});

// ── 実際の送受信で、知らせが本当に届くか ──────────────
import { LineClient } from '../../src/adapters/line/client';

/** fetch を差し替えて、LINE に何を送ったかを覚えておく */
function stubFetch(replies: Array<{ ok: boolean; body?: string }>) {
  const sent: Array<{ path: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: any) => {
    const r = replies.shift() ?? { ok: true };
    sent.push({ path: String(url), body: JSON.parse(init.body) });
    return { ok: r.ok, status: r.ok ? 200 : 429, text: async () => r.body ?? '' };
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const MONTHLY_LIMIT_ERROR = '{"message":"You have reached your monthly limit."}';

describe('上限に達したあとの実際のやりとり', () => {
  it('★プッシュが断られたら、次の返信で知らせる', async () => {
    const kv = fakeKv();
    const f = stubFetch([{ ok: false, body: MONTHLY_LIMIT_ERROR }, { ok: true }]);
    try {
      const line = new LineClient('token', kv);
      await line.push('U1', [{ type: 'text', text: '記事ができました' }]);
      await line.reply('rt', [{ type: 'text', text: 'はい' }]);

      const reply = f.sent[1].body.messages;
      expect(reply[0].text).toContain('上限（200通）に達しました');
      expect(reply[1].text).toBe('はい');
    } finally { f.restore(); }
  });

  it('★知らせは先頭に足す（最後のボタンを消さないため）', async () => {
    const kv = fakeKv();
    await markLimitReached(kv);
    const f = stubFetch([{ ok: true }]);
    try {
      await new LineClient('token', kv).reply('rt', [
        { type: 'text', text: '本文' },
        { type: 'text', text: 'どうしますか', quickReply: { items: [] } },
      ]);
      const msgs = f.sent[0].body.messages;
      expect(msgs).toHaveLength(3);
      // ボタンの付いたメッセージが、いちばん最後のままであること
      expect(msgs[msgs.length - 1].quickReply).toBeDefined();
    } finally { f.restore(); }
  });

  it('★5通そろっているときは足さない。知らせは次の機会まで取っておく', async () => {
    const kv = fakeKv();
    await markLimitReached(kv);
    const full = Array.from({ length: 5 }, (_, i) => ({ type: 'text' as const, text: `${i}` }));
    const f = stubFetch([{ ok: true }, { ok: true }]);
    try {
      const line = new LineClient('token', kv);
      await line.reply('rt', full);
      expect(f.sent[0].body.messages).toHaveLength(5);

      // 次の返信でちゃんと届く（取りこぼさない）
      await line.reply('rt2', [{ type: 'text', text: 'つぎ' }]);
      expect(f.sent[1].body.messages[0].text).toContain('上限（200通）に達しました');
    } finally { f.restore(); }
  });

  it('★届かなかったプッシュは数に入れない', async () => {
    const kv = fakeKv();
    const f = stubFetch([{ ok: false, body: MONTHLY_LIMIT_ERROR }]);
    try {
      await new LineClient('token', kv).push('U1', [{ type: 'text', text: 'x' }]);
      expect(kv.store[`linecount:${M}`]).toBeUndefined();
    } finally { f.restore(); }
  });
});
