/**
 * ハッシュタグの形（2026-11-24 実測: note は「#」なしのタグを黙って捨てる）と、
 * 公開済み記事への付け直し（core/article/retag.ts）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  cleanHashtagName, normalizeHashtags, toNoteHashtags, parseHashtagsJson, mergeHashtags, MAX_HASHTAGS,
} from '../../src/ports/publisher/note/hashtags';
import { NoteClient, NoteApiError } from '../../src/ports/publisher/note/client';
import { buildPlan } from '../../src/core/agent/plan';
import {
  retagPublishedArticles, retagSkipReason, retagSummaryText, isRecentlyUpdated, RETAG_AUDIT_ACTION, type RetagDeps,
} from '../../src/core/article/retag';
import { parseNoteDetail } from '../../src/ports/publisher/note/public';
import { COMMANDS } from '../../src/adapters/line/commands';
import type { ArticleRow } from '../../src/ports/storage/db';

afterEach(() => vi.unstubAllGlobals());

describe('タグ名を整える', () => {
  it('先頭の「#」「＃」は何個でも外す', () => {
    expect(cleanHashtagName('#脱サラ')).toBe('脱サラ');
    expect(cleanHashtagName('##脱サラ')).toBe('脱サラ');
    expect(cleanHashtagName('＃脱サラ')).toBe('脱サラ');
    expect(cleanHashtagName(' # 脱サラ ')).toBe('脱サラ');
  });

  it('★空白・note が捨てる記号を落とす（「・」は残す）', () => {
    expect(cleanHashtagName('カフェ 開業')).toBe('カフェ開業');
    expect(cleanHashtagName('下線_ハイフン-入り!?')).toBe('下線ハイフン入り');
    expect(cleanHashtagName('福岡・岡垣')).toBe('福岡・岡垣');
    expect(cleanHashtagName('ＡＢＣ123ー々')).toBe('ＡＢＣ123ー々');
  });

  it('長すぎるものは60字で切る／文字列でないもの・記号だけのものは空', () => {
    expect([...cleanHashtagName('あ'.repeat(80))].length).toBe(60);
    expect(cleanHashtagName(123)).toBe('');
    expect(cleanHashtagName(null)).toBe('');
    expect(cleanHashtagName('###')).toBe('');
    expect(cleanHashtagName('!!')).toBe('');
  });
});

describe('タグの並びを整える', () => {
  it('重複（全角半角・大文字小文字の違いだけ）は先に出たほうを残す', () => {
    expect(normalizeHashtags(['note', '#NOTE', 'ｎｏｔｅ', '開業', '#開業'])).toEqual(['note', '開業']);
  });

  it('空・壊れた要素は飛ばし、上限で打ち切る', () => {
    expect(normalizeHashtags(['', '#', null, 'a'])).toEqual(['a']);
    const many = Array.from({ length: 20 }, (_, i) => `タグ${i}`);
    expect(normalizeHashtags(many)).toHaveLength(MAX_HASHTAGS);
    expect(normalizeHashtags('タグ')).toEqual([]);
  });

  it('★note に送る形は「#名前」', () => {
    expect(toNoteHashtags(['カフェ開業', '#脱サラ', '##二重'])).toEqual(['#カフェ開業', '#脱サラ', '#二重']);
  });

  it('hashtags_json が壊れていても例外にしない（タグのせいで公開を止めない）', () => {
    expect(parseHashtagsJson('["脱サラ"]')).toEqual(['脱サラ']);
    expect(parseHashtagsJson('{壊れた')).toEqual([]);
    expect(parseHashtagsJson('{"a":1}')).toEqual([]);
    expect(parseHashtagsJson(null)).toEqual([]);
  });
});

describe('付いているタグに足す', () => {
  it('★足し算・既存タグは受け取った文字列のまま・足すものは「#名前」', () => {
    const r = mergeHashtags(['#自分で付けた', '#脱サラ'], ['脱サラ', '開業']);
    expect(r).toEqual({ unsafe: false, send: ['#自分で付けた', '#脱サラ', '#開業'], missing: ['開業'] });
  });

  it('全部付いていれば missing は空（送り直さない）', () => {
    expect(mergeHashtags(['#脱サラ', '#開業'], ['開業', '#脱サラ']).missing).toEqual([]);
    // 全角半角・大文字小文字の違いだけなら付いているとみなす
    expect(mergeHashtags(['#ＮＯＴＥ'], ['note']).missing).toEqual([]);
  });

  it('★整えると形が変わる既存タグが1つでもあれば unsafe（送らない）', () => {
    for (const bad of ['脱サラ', '#脱 サラ', '##脱サラ', '#脱サラ!', '＃脱サラ', '#']) {
      const r = mergeHashtags(['#ふつう', bad], ['開業']);
      expect(r.unsafe).toBe(true);
      expect(r.missing).toEqual([]);
    }
  });

  it('上限で入りきらないものは missing に数えない（無駄に送り直さない）', () => {
    const current = Array.from({ length: 10 }, (_, i) => `#既存${i}`);
    const r = mergeHashtags(current, ['新しい']);
    expect(r.missing).toEqual([]);
    expect(r.send).toEqual(current);
    expect(mergeHashtags(current.slice(0, 9), ['新しい', 'もう1つ']).missing).toEqual(['新しい']);
  });
});

// ── 送信箇所（server 経路・agent 経路）────────────────────
describe('★公開の送信内容に「#」付きのタグが入る', () => {
  it('server 経路: NoteClient.publish', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }));
    const c = new NoteClient({ cookieHeader: '_note_session_v5=x', userAgent: 'ua', urlname: 'u' });
    await c.publish(1, 'nabc', { title: 't', html: '<p>a</p>', bodyLength: 1, hashtags: ['脱サラ', '#開業', '開 業'] });
    expect(bodies[0].hashtags).toEqual(['#脱サラ', '#開業']);
    // 既定の設定は従来どおり
    expect(bodies[0]).toMatchObject({ index: false, disable_comment: false, exclude_from_creator_top: false, send_notifications_flag: true });
  });

  it('server 経路: 付け直し用に既存の設定を引き継げる', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }));
    const c = new NoteClient({ cookieHeader: 'a=b', userAgent: 'ua', urlname: 'u' });
    await c.publish(1, 'nabc', {
      title: 't', html: '<p>a</p>', bodyLength: 1, notifyFollowers: false,
      index: true, disableComment: true, excludeFromCreatorTop: true, excludeAiLearning: false,
    });
    expect(bodies[0]).toMatchObject({
      index: true, disable_comment: true, exclude_from_creator_top: true,
      exclude_ai_learning_reward: false, send_notifications_flag: false, hashtags: [],
    });
    // ★付け直し用: 既存タグを整えずにそのまま送る
    await c.publish(1, 'nabc', { title: 't', html: '<p>a</p>', bodyLength: 1, hashtags: ['無視される'], hashtagsVerbatim: ['#Ａ', '#b'] });
    expect(bodies[1].hashtags).toEqual(['#Ａ', '#b']);
  });

  it('agent 経路: 手順書の publish に「#」付きで入る／壊れた JSON でも手順書は作れる', async () => {
    const deps = { db: { listImages: async () => [], getEyecatch: async () => null }, images: { get: async () => null } } as never;
    const base = {
      id: 'a1', tenant_id: 'tenant_default', state: 'awaiting_approval', source_text: 'ネタ', title: 'T',
      body_md: '本文です。', image_alts_json: null, note_id: null, note_key: null,
    } as unknown as ArticleRow;
    const plan = await buildPlan(deps, { ...base, hashtags_json: '["いちご大福","#和菓子"]' }, 'publish');
    const publish = plan.steps.find((s) => s.id === 'publish')!.json as Record<string, unknown>;
    expect(publish.hashtags).toEqual(['#いちご大福', '#和菓子']);

    const broken = await buildPlan(deps, { ...base, hashtags_json: '{壊れた' }, 'publish');
    expect((broken.steps.find((s) => s.id === 'publish')!.json as Record<string, unknown>).hashtags).toEqual([]);
  });
});

// ── 公開 API の読み方 ──────────────────────────────────
describe('note の記事の読み方（parseNoteDetail）', () => {
  const raw = {
    id: 1, key: 'nk', status: 'published', name: 'T', body: '<h2>見出し</h2><p>本文</p>',
    hashtag_notes: [{ hashtag: { name: '#a' } }], price: 0, is_limited: false, separator: null,
    belonging_magazine_keys: [], index: [{ body: '見出し' }], disable_comment: false,
    exclude_from_creator_top: true, exclude_ai_learning_reward: false, has_draft: false, is_my_note: true,
  };

  it('★目次は配列で返る（中身あり＝オン／見出しがあるのに空＝オフ）', () => {
    expect(parseNoteDetail(raw)!.index).toBe(true);
    expect(parseNoteDetail({ ...raw, index: [] })!.index).toBe(false);
  });

  it('★見分けられない・返らない設定は null（false 扱いしない）', () => {
    const noHeading = parseNoteDetail({ ...raw, body: '<p>本文だけ</p>', index: [] })!;
    expect(noHeading.index).toBeNull();
    const missing = parseNoteDetail({ ...raw, index: undefined, disable_comment: undefined, exclude_from_creator_top: 'x', exclude_ai_learning_reward: null })!;
    expect(missing).toMatchObject({ index: null, disableComment: null, excludeFromCreatorTop: null, excludeAiLearning: null });
    expect(retagSkipReason(missing, 1)).toBe('unknown_setting');
    expect(retagSkipReason(noHeading, 1)).toBe('unknown_setting');
  });

  it('返ってきた値をそのまま読む', () => {
    expect(parseNoteDetail(raw)).toMatchObject({
      hashtags: ['#a'], disableComment: false, excludeFromCreatorTop: true, excludeAiLearning: false, hasDraft: false, isMyNote: true,
    });
    expect(parseNoteDetail({ ...raw, body: undefined })).toBeNull();
    expect(parseNoteDetail(null)).toBeNull();
  });
});

// ── 付け直し ──────────────────────────────────────────
/** v3 の data の形（getNote が返すもの） */
function raw(over: Record<string, unknown> = {}) {
  return {
    id: 100, key: 'nkey100', status: 'published', name: 'note 上のタイトル',
    body: '<h2 name="h">見出し</h2><p name="x">note 上の本文</p>',
    hashtag_notes: [], price: 0, is_limited: false, separator: null, belonging_magazine_keys: [],
    index: [], disable_comment: false, exclude_from_creator_top: false, exclude_ai_learning_reward: true,
    has_draft: false, is_my_note: true,
    ...over,
  };
}
const tags = (...names: string[]) => names.map((name) => ({ hashtag: { name } }));
const OLD = '2026-01-01T00:00:00.000Z';

function setup(opts: {
  rows: Array<{ id: string; note_id: string; note_key: string; hashtags_json: string; updated_at?: string | null; published_at?: string | null }>;
  notes?: Record<string, unknown>;
  done?: string[];
  getError?: (key: string) => Error | null;
  publishError?: (key: string) => Error | null;
  session?: string;
  limits?: RetagDeps['limits'];
  /** 呼ぶたびに進む時計（ms） */
  tick?: number;
  /** アカウントがコメント欄を閉じられるか（既定 false＝閉じられない） */
  canTurnOff?: boolean | null | Error;
}) {
  const audits: Array<{ target: string | null; result: string; detail: any }> = [];
  const published: Array<{ id: number; key: string; opts: any }> = [];
  const fetched: string[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse('2026-11-24T00:00:00.000Z');
  let refreshed: string | null = null;
  const deps: RetagDeps = {
    db: {
      listPublishedForRetag: async () => opts.rows.map((r) => ({ updated_at: OLD, published_at: OLD, ...r })),
      listRetagDoneIds: async () => opts.done ?? [],
      audit: async (_t, action, _a, target, result, detail) => {
        expect(action).toBe(RETAG_AUDIT_ACTION);
        audits.push({ target, result, detail });
      },
    },
    noteSession: { cookieHeader: opts.session ?? '_note_session_v5=x', userAgent: 'ua', urlname: 'u' },
    tenantId: 'tenant_default',
    actor: 'line:U1',
    onCookieRefresh: async (c) => { refreshed = c; },
    makeClient: () => ({
      latestCookieHeader: 'new-cookie',
      canTurnOffComments: async () => {
        const v = opts.canTurnOff === undefined ? false : opts.canTurnOff;
        if (v instanceof Error) throw v;
        return v;
      },
      getNote: async (key: string) => {
        fetched.push(key);
        const err = opts.getError?.(key);
        if (err) throw err;
        return opts.notes?.[key] ?? null;
      },
      publish: async (id: number, key: string, o: any) => {
        const err = opts.publishError?.(key);
        if (err) throw err;
        published.push({ id, key, opts: o });
        return { url: `https://note.com/u/n/${key}` };
      },
    }) as never,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => (clock += opts.tick ?? 0),
    limits: opts.limits,
  };
  return { deps, audits, published, fetched, sleeps, refreshed: () => refreshed };
}

const row = (n: number, t: string[] = ['脱サラ']) => ({
  id: `a${n}`, note_id: String(n), note_key: `nkey${n}`, hashtags_json: JSON.stringify(t),
});
const notesFor = (rows: Array<{ note_id: string; note_key: string }>, over: Record<string, unknown> = {}) =>
  Object.fromEntries(rows.map((r) => [r.note_key, raw({ id: Number(r.note_id), key: r.note_key, ...over })]));

describe('公開済み記事のハッシュタグを付け直す', () => {
  it('★note 上の本文・タイトル・設定のまま、通知なしでタグだけ足す（既存タグは文字列のまま）', async () => {
    const t = setup({
      rows: [row(100, ['脱サラ', '開業'])],
      notes: { nkey100: raw({ hashtag_notes: tags('#自分で付けた'), index: [{ body: '見出し' }], exclude_ai_learning_reward: false, exclude_from_creator_top: true }) },
    });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ updated: 1, alreadyTagged: 0, skipped: 0, failed: 0, remaining: 0 });
    const p = t.published[0];
    expect(p.id).toBe(100);
    expect(p.key).toBe('nkey100');
    expect(p.opts).toMatchObject({
      title: 'note 上のタイトル', html: '<h2 name="h">見出し</h2><p name="x">note 上の本文</p>',
      hashtagsVerbatim: ['#自分で付けた', '#脱サラ', '#開業'],
      notifyFollowers: false, index: true, disableComment: false, excludeAiLearning: false, excludeFromCreatorTop: true,
    });
    expect(t.audits).toEqual([{ target: 'a100', result: 'ok', detail: { added: ['脱サラ', '開業'] } }]);
    expect(t.refreshed()).toBe('new-cookie');
  });

  it('すでに付いている記事は送り直さない', async () => {
    const t = setup({ rows: [row(100)], notes: { nkey100: raw({ hashtag_notes: tags('#脱サラ') }) } });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ updated: 0, alreadyTagged: 1 });
    expect(t.published).toHaveLength(0);
    expect(t.audits[0].result).toBe('already');
    expect(t.refreshed()).toBeNull();
  });

  it('★整えると形が変わる既存タグがあれば送らない（unsafe_existing_tag）', async () => {
    const t = setup({ rows: [row(100)], notes: { nkey100: raw({ hashtag_notes: tags('#ふつう', '#記号_入り') }) } });
    const r = await retagPublishedArticles(t.deps);
    expect(r.skipped).toBe(1);
    expect(t.published).toHaveLength(0);
    expect(t.audits[0]).toMatchObject({ result: 'skipped', detail: { reason: 'unsafe_existing_tag' } });
  });

  it('★設定が読み取れない記事は送らない（unknown_setting）', async () => {
    const t = setup({ rows: [row(1), row(2)], notes: {
      nkey1: raw({ id: 1, key: 'nkey1', disable_comment: undefined }),
      nkey2: raw({ id: 2, key: 'nkey2', body: '<p>見出しなし</p>', index: [] }),
    } });
    const r = await retagPublishedArticles(t.deps);
    expect(r.skipped).toBe(2);
    expect(t.published).toHaveLength(0);
    expect(t.audits.map((a) => a.detail.reason)).toEqual(['unknown_setting', 'unknown_setting']);
  });

  it('確かめ終えた記事・タグの無い記事は読みに行かない', async () => {
    const rows = [row(1), row(2, []), { ...row(3), hashtags_json: '壊れた' }, row(4)];
    const t = setup({ rows, notes: notesFor([row(4)]), done: ['a1'] });
    const r = await retagPublishedArticles(t.deps);
    expect(t.fetched).toEqual(['nkey4']);
    expect(r.updated).toBe(1);
  });

  it('★有料・限定・マガジン入り・非公開・別記事・他人の記事・空本文は送らない', () => {
    const n = (o: Record<string, unknown> = {}) => parseNoteDetail(raw(o))!;
    expect(retagSkipReason(n(), 100)).toBeNull();
    expect(retagSkipReason(n({ status: 'draft' }), 100)).toBe('not_published');
    expect(retagSkipReason(n(), 999)).toBe('id_mismatch');
    expect(retagSkipReason(n({ is_my_note: false }), 100)).toBe('not_mine');
    expect(retagSkipReason(n({ price: 300 }), 100)).toBe('paid');
    expect(retagSkipReason(n({ is_limited: true }), 100)).toBe('paid');
    expect(retagSkipReason(n({ separator: 'abc' }), 100)).toBe('paid');
    expect(retagSkipReason(n({ belonging_magazine_keys: ['m1'] }), 100)).toBe('in_magazine');
    expect(retagSkipReason(n({ body: '  ' }), 100)).toBe('empty_body');
  });

  it('★note で編集中の記事・こちらで直近10分以内に更新した記事は今回は見送る（次回やり直す）', async () => {
    const recent = new Date(Date.parse('2026-11-24T00:00:00.000Z') - 5 * 60 * 1000).toISOString();
    const t = setup({
      rows: [{ ...row(1), updated_at: recent }, row(2), { ...row(3), published_at: recent }],
      notes: { ...notesFor([row(2)], { has_draft: true }) },
    });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ deferred: 3, updated: 0 });
    expect(t.fetched).toEqual(['nkey2']); // 直近更新の記事は読みにも行かない
    expect(t.audits.map((a) => [a.result, a.detail.reason])).toEqual([
      ['deferred', 'recently_updated'], ['deferred', 'editing'], ['deferred', 'recently_updated'],
    ]);
    expect(isRecentlyUpdated({ updated_at: OLD, published_at: null }, Date.parse('2026-11-24T00:00:00Z'))).toBe(false);
  });

  it('★送る本数・読む本数に上限があり、残りは次回へ。送るたびに間隔を空ける', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
    const t = setup({ rows, notes: notesFor(rows), limits: { maxUpdates: 3, intervalMs: 1500 } });
    const r = await retagPublishedArticles(t.deps);
    expect(r.updated).toBe(3);
    expect(r.remaining).toBe(5);
    expect(t.sleeps).toEqual([1500, 1500]); // 1本目の前は待たない

    const t2 = setup({ rows, notes: notesFor(rows, { hashtag_notes: tags('#脱サラ') }), limits: { maxChecks: 2 } });
    const r2 = await retagPublishedArticles(t2.deps);
    expect(t2.fetched).toHaveLength(2);
    expect(r2).toMatchObject({ alreadyTagged: 2, remaining: 6 });
  });

  it('★開始から約20秒で、新しい読み込み・送信を始めずに結果を返す', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    // 時計を読むたびに 3 秒進む＝数本で 20 秒を超える
    const t = setup({ rows, notes: notesFor(rows), tick: 3000, limits: { intervalMs: 0, maxUpdates: 10 } });
    const r = await retagPublishedArticles(t.deps);
    expect(r.stoppedByTime).toBe(true);
    expect(r.updated).toBeGreaterThan(0);
    expect(r.updated + r.remaining).toBe(10);
    expect(t.fetched.length).toBeLessThan(10);
    expect(retagSummaryText(r)).toContain('もう一度「ハッシュタグを付け直す」');

    // 間隔を待つと時間を超えるなら、送らずにやめる
    const t2 = setup({ rows: rows.slice(0, 2), notes: notesFor(rows), limits: { intervalMs: 19_000, timeBudgetMs: 20_000 }, tick: 1000 });
    const r2 = await retagPublishedArticles(t2.deps);
    expect(r2).toMatchObject({ updated: 1, stoppedByTime: true, remaining: 1 });
    expect(t2.sleeps).toEqual([]);
  });

  it('1本失敗しても記録して続ける（失敗は次回やり直し）', async () => {
    const rows = [row(1), row(2), row(3)];
    const t = setup({
      rows, notes: notesFor(rows),
      publishError: (key) => (key === 'nkey1' ? new NoteApiError(422, 'invalid', 'だめ', false) : null),
    });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ updated: 2, failed: 1, stoppedBySession: false });
    expect(t.audits.find((a) => a.target === 'a1')).toMatchObject({ result: 'error', detail: { code: 'invalid' } });
  });

  it('読めなかった記事は失敗として記録して続ける', async () => {
    const t = setup({ rows: [row(1), row(2)], notes: notesFor([row(2)]),
      getError: (key) => (key === 'nkey1' ? new NoteApiError(404, 'not_found', 'ない', false) : null) });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ updated: 1, failed: 1 });
  });

  it('★連携切れ・混雑ならそこで止める（読み込みでも送信でも）', async () => {
    const rows = [row(1), row(2), row(3)];
    const t = setup({ rows, notes: notesFor(rows),
      publishError: (key) => (key === 'nkey2' ? new NoteApiError(401, 'auth', '切れた', true) : null) });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ updated: 1, stoppedBySession: true, remaining: 2 });
    expect(t.fetched).toEqual(['nkey1', 'nkey2']);
    expect(retagSummaryText(r)).toContain('連携');

    const t2 = setup({ rows, notes: notesFor(rows), getError: () => new NoteApiError(401, 'auth', '切れた', true) });
    const r2 = await retagPublishedArticles(t2.deps);
    expect(r2).toMatchObject({ updated: 0, stoppedBySession: true, remaining: 3 });
    expect(t2.fetched).toEqual(['nkey1']);
  });

  it('★コメント欄を閉じられる・確かめられないアカウントでは1本も送らない', async () => {
    for (const v of [true, null, new Error('通信')]) {
      const t = setup({ rows: [row(1)], notes: notesFor([row(1)]), canTurnOff: v });
      const r = await retagPublishedArticles(t.deps);
      expect(r.blockedByCommentSetting).toBe(true);
      expect(t.fetched).toEqual([]);
      expect(t.published).toEqual([]);
      expect(retagSummaryText(r)).toContain('コメント欄');
    }
    // 連携切れなら、連携切れとして返す
    const t = setup({ rows: [row(1)], canTurnOff: new NoteApiError(401, 'auth', '切れた', true) });
    const r = await retagPublishedArticles(t.deps);
    expect(r).toMatchObject({ stoppedBySession: true, blockedByCommentSetting: false });
  });

  it('★サーバーに Cookie が無ければ何もしない（パソコン投稿・未連携）', async () => {
    const t = setup({ rows: [row(1)], session: '' });
    const r = await retagPublishedArticles(t.deps);
    expect(r.noSession).toBe(true);
    expect(t.fetched).toEqual([]);
    expect(retagSummaryText(r)).toContain('連携情報がサーバーに無い');
  });

  it('結果の文面: 残りがあれば「もう一度送る」、本文・URL を変えていないと書く', () => {
    const base = { noSession: false, blockedByCommentSetting: false, stoppedBySession: false, stoppedByTime: false, updated: 5, alreadyTagged: 1, skipped: 0, deferred: 1, failed: 0, remaining: 3 };
    const t = retagSummaryText(base);
    expect(t).toContain('付け直した: 5本');
    expect(t).toContain('まだ 3本');
    expect(t).toContain('見送り');
    expect(t).toContain('通知もしていません');
    expect(retagSummaryText({ ...base, remaining: 0, deferred: 0 })).toContain('すべての記事を確認しました');
  });
});

describe('LINE のコマンド', () => {
  it('「ハッシュタグを付け直す」に反応し、ほかのコマンドとは重ならない', () => {
    for (const w of ['ハッシュタグを付け直す', 'ハッシュタグを付けなおす', 'タグを付け直す']) {
      expect(COMMANDS.retagHashtags.test(w)).toBe(true);
      const others = Object.entries(COMMANDS).filter(([k, re]) => k !== 'retagHashtags' && re.test(w));
      expect(others).toEqual([]);
    }
    expect(COMMANDS.retagHashtags.test('ハッシュタグを付け直すのはどうやる？')).toBe(false);
  });
});
