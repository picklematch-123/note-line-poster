/**
 * ナレッジ登録で「返事が来ない・保存されない」を二度と起こさない。
 *
 * ★2026-09-14 にお客さまの環境で2回発生:
 *   長文を送ると、Claude の整理が裏処理の制限時間（約30秒）に間に合わず打ち切られ、
 *   **何も保存されず、返事も届かなかった**。
 *   → 先に原文を保存してすぐ返事をし、整理は Workflow に回す。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildProvisionalSnippet, ensureContextUrls, PROVISIONAL_LIMIT,
} from '../../src/core/generation/context';
import { applyKnowledgeDigest } from '../../src/core/knowledge/apply';
import {
  buildKnowledgeReceived, buildKnowledgeSaved, buildKnowledgeOrganizeFailed,
} from '../../src/adapters/line/messages/knowledge';
import { Db, DEFAULT_TENANT_ID } from '../../src/ports/storage/db';
import type { KnowledgeDigest } from '../../src/core/generation/schema';

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
        async run() { const r = db.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all<T>() { return { results: db.prepare(sql).all(...(params as [])) as T[] }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const DIGEST: KnowledgeDigest = {
  standpoint: '町のケーキ屋',
  facts: ['9月20日から秋メニュー'],
  wording: ['店主は「店長」'],
  rules: ['記事の最後にInstagramのリンクを入れる'],
  avoid: [],
  digest: '整理済みの前提（テスト）',
} as KnowledgeDigest;

describe('整理が終わるまでの前提', () => {
  it('★必ず中身がある（空だと記事生成がナレッジを読まない）', () => {
    const snippet = buildProvisionalSnippet('店主のことは「店長」と書く');
    expect(snippet).toContain('店長');
    expect(ensureContextUrls('店主のことは「店長」と書く', snippet)).not.toBeNull();
  });

  it('★長すぎるときは、新しく書き足した末尾を残す', () => {
    const old = 'あ'.repeat(PROVISIONAL_LIMIT + 500);
    const snippet = buildProvisionalSnippet(`${old}\n\n最新の書き足し：営業時間は10時から`);
    expect(snippet).toContain('最新の書き足し');
    expect(snippet).toContain('省略');
  });

  it('★切った前半にあった URL も落とさない', () => {
    const text = `記事の最後に https://example.com/shop を貼る\n\n${'い'.repeat(PROVISIONAL_LIMIT + 100)}`;
    expect(buildProvisionalSnippet(text)).toContain('https://example.com/shop');
  });
});

describe('整理結果の反映', () => {
  async function ready() {
    const db = new Db(asD1(migrate()));
    await db.getTenant(DEFAULT_TENANT_ID);
    return db;
  }

  it('整理を始めた内容のままなら反映する（原文はそのまま・前提は整理済みに）', async () => {
    const db = await ready();
    const id = await db.saveContext(DEFAULT_TENANT_ID, '原文A', null, buildProvisionalSnippet('原文A'));
    expect(await applyKnowledgeDigest(db, DEFAULT_TENANT_ID, id, DIGEST)).toBe('applied');
    const now = await db.getActiveContext(DEFAULT_TENANT_ID);
    expect(now?.raw_text).toBe('原文A');
    expect(now?.prompt_snippet).toContain('整理済みの前提（テスト）');
  });

  it('★整理の途中で書き足されたら、古い整理結果で上書きしない', async () => {
    const db = await ready();
    const oldId = await db.saveContext(DEFAULT_TENANT_ID, '原文A', null, buildProvisionalSnippet('原文A'));
    await db.saveContext(DEFAULT_TENANT_ID, '原文A\n\n書き足しB', null, buildProvisionalSnippet('原文A\n\n書き足しB'));
    expect(await applyKnowledgeDigest(db, DEFAULT_TENANT_ID, oldId, DIGEST)).toBe('stale');
    const now = await db.getActiveContext(DEFAULT_TENANT_ID);
    expect(now?.raw_text).toContain('書き足しB');
    expect(now?.prompt_snippet).not.toContain('整理済みの前提（テスト）');
  });

  it('整理の途中で全部消されていたら、何もしない', async () => {
    const db = await ready();
    const id = await db.saveContext(DEFAULT_TENANT_ID, '原文A', null, buildProvisionalSnippet('原文A'));
    await db.clearContext(DEFAULT_TENANT_ID);
    expect(await applyKnowledgeDigest(db, DEFAULT_TENANT_ID, id, DIGEST)).toBe('stale');
    expect(await db.getActiveContext(DEFAULT_TENANT_ID)).toBeNull();
  });
});

describe('返事の文面', () => {
  it('★送った直後の返事で「もう使われる」「終わったら知らせる」を伝える', () => {
    const t = buildKnowledgeReceived(3, 'append').text as string;
    expect(t).toContain('覚えました');
    expect(t).toContain('全3件');
    expect(t).toContain('もう使われます');
    expect(t).toContain('お知らせします');
  });

  it('入れ替えのときは「入れ替えました」', () => {
    expect(buildKnowledgeReceived(1, 'replace').text).toContain('入れ替えました');
  });

  it('整理が終わったら、読み取ったルールを見せる', () => {
    const t = buildKnowledgeSaved(DIGEST, 2).text as string;
    expect(t).toContain('整理が終わりました');
    expect(t).toContain('Instagram');
  });

  it('★整理に失敗しても「覚えた内容は消えていない」と伝え、理由があれば添える', () => {
    const t = buildKnowledgeOrganizeFailed('Claude の残高が足りません。');
    expect(t).toContain('そのまま覚えて');
    expect(t).toContain('残高');
    expect(buildKnowledgeOrganizeFailed(null)).not.toContain('null');
  });
});
