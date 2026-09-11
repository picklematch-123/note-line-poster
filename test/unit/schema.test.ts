/**
 * スキーマとテナント作成の検査。
 *
 * ★何を守っているか:
 *   配布した顧客の環境が「投稿する場所 = server（パソコン不要）」で始まること。
 *   ここが agent で始まると、顧客は Chrome を開いていないと投稿されない状態になり、
 *   しかも気づくのは顧客側になる。
 *
 * ★なぜテーブルの既定値ではなく、登録経路を検査しているのか:
 *   tenants テーブルの execution_mode の既定値は 0006 で入れた 'agent' のまま残っている。
 *   0008 で方針を server に変えたが、直したのは既存の行だけだった。
 *   SQLite は「列の既定値だけ」を変更できず、テーブルを作り直すしかない。
 *   そして D1 では tenants を作り直せない（実測。下の「D1 で作り直せない」参照）。
 *   → 既定値は直せないので、代わりに「登録経路が必ず明示すること」を固定する。
 *
 * ★D1 で作り直せない（2026-08-29 実測）:
 *   tenants を参照している子テーブル（articles / agent_devices など）に行がある状態で
 *   DROP TABLE tenants → 作り直し を1つのマイグレーションで流すと、D1 が
 *   「FOREIGN KEY constraint failed」で丸ごと巻き戻す。
 *   PRAGMA defer_foreign_keys / foreign_keys = OFF のどちらを付けても同じだった
 *   （親を作り直しても、外部キー違反の数え上げは戻らないため）。
 *
 * 本物の D1 ではなく node:sqlite（同じ SQLite）で検査している。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';

const ROOT = new URL('../../', import.meta.url).pathname;
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** 外部キーを効かせた空の DB に、マイグレーションを順に適用する。 */
function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // D1 はマイグレーション1本を1つのトランザクションとして流すので、ここでも囲う
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`${file} の適用に失敗: ${String(e)}`);
    }
  }
  return db;
}

/** node:sqlite を D1 のふりをさせる最小の受け口（ensureTenant が使う分だけ）。 */
function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) { params = p; return api; },
        async first<T>() { return (db.prepare(sql).get(...(params as [])) as T) ?? null; },
        async run() { db.prepare(sql).run(...(params as [])); return { success: true }; },
        async all<T>() { return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

/** src / scripts の .ts / .mjs を全部読む。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(entry)) out.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'scripts'));
  return out;
}

describe('マイグレーション', () => {
  it('0001 から最後まで、外部キーを効かせたまま通る', () => {
    const db = migrate();
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tenants'")
      .get() as { sql: string } | undefined;
    expect(row?.sql).toContain('execution_mode');
    db.close();
  });

  it('テーブルの既定値は agent のまま（＝当てにしてはいけない）', () => {
    // ★この検査は「直っていること」ではなく「直っていないこと」を固定している。
    //   D1 では作り直せないため（ファイル冒頭の説明を参照）。
    //   だからこそ、下の「登録経路が必ず明示する」検査が効いている必要がある。
    //   将来 D1 が作り直しに対応してここが server になったら、この検査を消してよい。
    const db = migrate();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('t_omitted', 'テスト', now, now);

    const row = db.prepare('SELECT execution_mode FROM tenants WHERE id = ?')
      .get('t_omitted') as { execution_mode: string };
    expect(row.execution_mode).toBe('agent');
    db.close();
  });
});

describe('テナントを登録する経路', () => {
  it('tenants への INSERT は、必ず execution_mode を明示している', () => {
    // ★これが今回いちばん効いている検査。
    //   明示を忘れた INSERT が1つでも増えると、その環境は agent で始まってしまう。
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+tenants\s*\(([^)]*)\)/gi)) {
        if (!/execution_mode/i.test(m[1])) offenders.push(file.replace(ROOT, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('新しい環境では server（パソコン不要）で作られる', async () => {
    const db = migrate();
    const tenant = await new Db(asD1(db)).ensureTenant();

    expect(tenant.id).toBe(DEFAULT_TENANT_ID);
    expect(tenant.execution_mode).toBe('server');
    expect(tenant.agent_fallback).toBe(0);
    db.close();
  });

  it('2回呼んでも増えないし、選んだ設定を上書きしない', async () => {
    const db = migrate();
    const store = new Db(asD1(db));
    await store.ensureTenant();

    // 顧客が「自分のパソコンから投稿する」を選んだ状態を作る
    db.prepare('UPDATE tenants SET execution_mode = ? WHERE id = ?')
      .run('agent', DEFAULT_TENANT_ID);

    const again = await store.ensureTenant();
    expect(again.execution_mode).toBe('agent');

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number };
    expect(n).toBe(1);
    db.close();
  });

  it('配布物なので、特定の人の名前を入れない', async () => {
    // ★顧客ごとに別環境で動く。他人の名前が入っていると
    //   「これは誰の環境か」を取り違える原因になる。
    const db = migrate();
    await new Db(asD1(db)).ensureTenant();

    const { name } = db.prepare('SELECT name FROM tenants WHERE id = ?')
      .get(DEFAULT_TENANT_ID) as { name: string };
    expect(name).not.toContain('オーナー');
    expect(name).not.toContain('最初の環境');
    db.close();
  });
});
