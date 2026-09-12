/**
 * 投稿レートの設定（LINE と /setup の両方）。
 *
 * ★何を守っているか
 *   1. **危ないほうへ黙って倒れないこと。**
 *      読めない値を 0 に丸めると「無制限・間隔なし」になる。
 *      止まるより、note のアカウントが飛ぶほうが取り返しがつかない。
 *   2. **入口が2つあっても、選択肢と言い回しが1つであること。**
 *      LINE と `/setup` で違う数字が出ると、どちらが本当か分からなくなる。
 *   3. **根拠のない数字を、根拠があるように見せないこと。**
 *      note は基準を公開していない。「3本なら安全」と読める文言を置かない。
 *   4. **設定の書き換えに入場口があること。**
 *      上限を外す操作は、note のアカウント停止に直結しうる。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAILY_LIMIT_OPTIONS, INTERVAL_OPTIONS, RATE_RISK_NOTE,
  DAILY_LIMIT_MAX, INTERVAL_MAX_SEC, SUGGESTED_DAILY_LIMIT, SUGGESTED_INTERVAL_SEC,
  limitLabel, intervalLabel, parseDailyLimit, parseIntervalSec,
} from '../../src/core/policy/options';
import { buildDailyLimitChoices, buildIntervalChoices } from '../../src/adapters/line/messages/settings';
import { setupRouter } from '../../src/adapters/setup/router';
import { issueSetupCode, markSetupCompleted } from '../../src/core/setup/state';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';

// ── 値の読み取り ──────────────────────────────────────
describe('入力の読み取り', () => {
  it('数字はそのまま読む', () => {
    expect(parseDailyLimit('3')).toBe(3);
    expect(parseDailyLimit('0')).toBe(0);
    expect(parseIntervalSec('300')).toBe(300);
  });

  it('★読めない値は null（＝その項目を変えない）。0 に丸めない', () => {
    // 0 に丸めると「無制限・間隔なし」＝いちばん危ない側に倒れる
    for (const bad of ['', '   ', 'abc', null, undefined]) {
      expect(parseDailyLimit(bad)).toBeNull();
      expect(parseIntervalSec(bad)).toBeNull();
    }
  });

  it('範囲を外れた値は端に寄せる', () => {
    expect(parseDailyLimit('9999')).toBe(DAILY_LIMIT_MAX);
    expect(parseDailyLimit('-5')).toBe(0);
    expect(parseIntervalSec('999999')).toBe(INTERVAL_MAX_SEC);
  });
});

describe('選択肢', () => {
  it('5分の間隔が選べる', () => {
    expect(INTERVAL_OPTIONS).toContain(300);
  });

  it('言い回しは1本（同じ値なら同じ文字）', () => {
    expect(limitLabel(0)).toBe('無制限');
    expect(limitLabel(3)).toBe('1日 3 本まで');
    expect(intervalLabel(0)).toBe('なし（連続で投稿できます）');
    expect(intervalLabel(300)).toBe('5 分あけます');
    expect(intervalLabel(86400)).toBe('24 時間あけます');
  });
});

// ── 説明文の正直さ ───────────────────────────────────
describe('上限の説明', () => {
  it('★note が基準を公開していないことを、はっきり書いている', () => {
    expect(RATE_RISK_NOTE).toContain('公開していません');
    expect(RATE_RISK_NOTE).toContain('note が認めた安全な数ではなく');
  });

  it('★「ここまでなら安全」と読める書き方をしていない', () => {
    // 数字＋安全 の組み合わせを禁じる（例：「3本までなら安全です」）
    expect(RATE_RISK_NOTE).not.toMatch(/\d+\s*本[^。]{0,10}安全/);
    expect(RATE_RISK_NOTE).not.toMatch(/安全です/);
  });

  it('アカウントが止まりうることを書いている', () => {
    expect(RATE_RISK_NOTE).toContain('停止');
  });
});

// ── 入口が2つでも中身は1つ ────────────────────────────
describe('LINE と /setup で同じものが出る', () => {
  const values = (m: ReturnType<typeof buildDailyLimitChoices>) =>
    (m.quickReply?.items ?? []).map((i) => Number(new URLSearchParams(
      (i.action as { data: string }).data).get('v')));

  it('LINE の選択肢は core と同じ', () => {
    expect(values(buildDailyLimitChoices(0))).toEqual([...DAILY_LIMIT_OPTIONS]);
    expect(values(buildIntervalChoices(0))).toEqual([...INTERVAL_OPTIONS]);
  });

  it('LINE の説明にも、同じ注意書きが入っている', () => {
    expect(buildDailyLimitChoices(0).text).toContain(RATE_RISK_NOTE);
  });

  it('★クイックリプライは13件まで（超えると LINE が送信を断る）', () => {
    expect(buildDailyLimitChoices(0).quickReply!.items.length).toBeLessThanOrEqual(13);
    expect(buildIntervalChoices(0).quickReply!.items.length).toBeLessThanOrEqual(13);
  });
});

// ── /setup の画面と保存 ───────────────────────────────
const ROOT = new URL('../../', import.meta.url).pathname;

function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return db;
}

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) { params = p; return api; },
        async first<T>() { return (db.prepare(sql).get(...(params as [])) as T) ?? null; },
        async run() { db.prepare(sql).run(...(params as [])); return { success: true, meta: {} }; },
        async all<T>() { return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } as unknown as KVNamespace & { store: Record<string, string> };
}

/** 稼働中の環境（テナントあり・1日3本／30分）を用意する */
function running() {
  const db = migrate();
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, plan, status, execution_mode, created_at, updated_at)
              VALUES (?, 'オーナー', 'trial', 'active', 'server', ?, ?)`)
    .run(DEFAULT_TENANT_ID, now, now);
  db.prepare('UPDATE tenants SET daily_post_limit = 3, min_interval_sec = 1800 WHERE id = ?')
    .run(DEFAULT_TENANT_ID);
  const kv = fakeKv();
  return { db, kv, env: { DB: asD1(db), KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' } };
}

const limits = (db: DatabaseSync) =>
  db.prepare('SELECT daily_post_limit, min_interval_sec FROM tenants WHERE id = ?')
    .get(DEFAULT_TENANT_ID) as { daily_post_limit: number; min_interval_sec: number };

const post = (env: unknown, body: Record<string, string>) =>
  setupRouter.request('/setup/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }, env);

describe('配った直後の初期値', () => {
  it('★新しい環境は、控えめな値で始まる（無制限では始まらない）', async () => {
    // 顧客が何も設定しないまま使い始めても、いきなり連投にならないこと。
    // ここが 0 で始まると、気づくのは note に止められてからになる。
    const tenant = await new Db(asD1(migrate())).getTenant(DEFAULT_TENANT_ID);
    expect(tenant.daily_post_limit).toBe(SUGGESTED_DAILY_LIMIT);
    expect(tenant.min_interval_sec).toBe(SUGGESTED_INTERVAL_SEC);
  });
});

describe('/setup の投稿設定', () => {
  it('いまの設定が画面に出る', async () => {
    const { env } = running();
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('投稿の設定');
    expect(html).toContain('<option value="3" selected>');
    expect(html).toContain('<option value="1800" selected>');
    // ★注意書きが画面から消えていないこと
    expect(html).toContain('公開していません');
  });

  it('★コード欄を出すなら、必ず「どう受け取るか」も書く', async () => {
    // 2026-09-12: 欄だけあって入手方法が無く、設定できないという詰まり方をした
    const { kv, env } = running();
    await markSetupCompleted(kv);
    const html = await (await setupRouter.request('/setup', {}, env)).text();

    const fields = html.split('name="code"').length - 1;
    expect(fields).toBeGreaterThan(0);
    // 欄の数だけ、入手方法の案内も出ていること
    expect(html.split('と送ると届きます').length - 1).toBe(fields);
    expect(html).toContain('10分間・1回かぎり');
  });

  it('★コードが要るときは、LINE ならコード不要だと案内する', async () => {
    const { kv, env } = running();
    await markSetupCompleted(kv);
    const html = await (await setupRouter.request('/setup', {}, env)).text();
    expect(html).toContain('コードは要りません');
    expect(html).toContain('投稿設定');
  });

  it('★セットアップ済みの環境では、コード無しの保存を断る（設定は変わらない）', async () => {
    const { db, kv, env } = running();
    await markSetupCompleted(kv);

    const res = await post(env, { daily: '0', interval: '0' });
    expect(res.status).toBe(403);
    expect(limits(db)).toEqual({ daily_post_limit: 3, min_interval_sec: 1800 });
  });

  it('★でたらめなコードでも断る', async () => {
    const { db, kv, env } = running();
    await markSetupCompleted(kv);

    const res = await post(env, { code: 'ZZZZ-9999', daily: '0', interval: '0' });
    expect(res.status).toBe(403);
    expect(limits(db)).toEqual({ daily_post_limit: 3, min_interval_sec: 1800 });
  });

  it('正しいコードなら保存できる', async () => {
    const { db, kv, env } = running();
    await markSetupCompleted(kv);
    const { display } = await issueSetupCode(kv);

    const res = await post(env, { code: display, daily: '10', interval: '300' });
    expect(res.status).toBe(200);
    expect(limits(db)).toEqual({ daily_post_limit: 10, min_interval_sec: 300 });
  });

  it('★読めない値が来ても、その項目は変えない（無制限に倒れない）', async () => {
    const { db, kv, env } = running();
    await markSetupCompleted(kv);
    const { display } = await issueSetupCode(kv);

    await post(env, { code: display, daily: 'あ', interval: '600' });
    expect(limits(db)).toEqual({ daily_post_limit: 3, min_interval_sec: 600 });
  });

  it('無制限にしたときは、判断が本人に移ることを伝える', async () => {
    const { kv, env } = running();
    await markSetupCompleted(kv);
    const { display } = await issueSetupCode(kv);

    const html = await (await post(env, { code: display, daily: '0', interval: '0' })).text();
    expect(html).toContain('ご自身の判断');
  });
});
