/**
 * 過去記事との重なりを避ける（2026-11・顧客の環境で18本中17本が同じ型になった件）。
 * ・過去記事が上限つきでプロンプトに入るか／除外条件
 * ・構成が過去記事と強く似ていたら1回だけ作り直すか（2回目は作り直さない）
 * ・過去記事0件なら今までどおりか
 * ★LLM は偽物。本物の OpenAI / Claude は呼ばない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Llm, StructuredOptions } from '../../src/ports/llm/types';
import { Db, DEFAULT_TENANT_ID, type ArticleRow } from '../../src/ports/storage/db';
import { generate, type GenerationInput } from '../../src/core/generation/pipeline';
import {
  toPastArticles, pastArticlesBlock, pastTitlesBlock, textSimilarity, findSimilarPast, repeatsQuestionPattern,
  allowsOverlap, similarityNotice, outlineRedoNote, MAX_PAST_ARTICLES, MAX_HEADINGS_PER_ARTICLE, MAX_DETAILED_CHARS,
  type PastArticle,
} from '../../src/core/generation/history';
import * as P from '../../src/core/generation/prompts';
import { buildPreview } from '../../src/adapters/line/messages/preview';

// ── 共通の部品 ───────────────────────────────────────────
function row(over: Partial<ArticleRow>): ArticleRow {
  return {
    id: 'a', tenant_id: DEFAULT_TENANT_ID, state: 'published', source_text: 'ネタ',
    keywords_json: null, outline_json: null, title: 'タイトル', body_md: null, body_html: null,
    meta_description: null, hashtags_json: null, image_alts_json: null, note_id: null, note_key: null,
    note_url: null, error_code: null, error_message: null, llm_input_tokens: 0, llm_output_tokens: 0,
    revision_instruction: null, revision_count: 0, approved_at: null, approved_by: null, published_at: null,
    removed_at: null, created_at: '2026-11-01', updated_at: '2026-11-01',
    ...over,
  } as ArticleRow;
}

/** 実データで起きた「同じ型」の見出し */
const SAME_HEADINGS = [
  'ペットホテルのフランチャイズとは？',
  '加盟関連費用363万円には何が含まれる？',
  '開業後の収益はどれくらい？',
  'どんな仕事をするの？',
  '未経験でも始められる？',
  '開業までの流れは？',
];
const SAME_TITLE = 'ペットホテルのフランチャイズ｜費用・収益・仕事';

/** 偽の LLM。ステップ名で返す中身を決め、渡されたプロンプトを記録する */
function fakeLlm(opts: { outlines?: Array<{ workingTitle: string; headings: string[] }>; title?: string } = {}) {
  const calls: Array<{ label: string; user: string }> = [];
  let outlineN = 0;
  const llm: Llm = {
    async structured<T>(o: StructuredOptions<T>) {
      calls.push({ label: o.label, user: o.user });
      let data: unknown;
      if (o.label === 'キーワード分析') {
        data = { primaryKeyword: 'ペットホテル 開業', secondaryKeywords: ['費用'], searchIntent: 'i', targetReader: 'r', competitorAngle: 'c' };
      } else if (o.label === '構成作成') {
        const list = opts.outlines ?? [{ workingTitle: '朝7時から始まるペットホテルの一日', headings: ['朝の受け入れ', '昼の散歩とごはん', '夕方のお迎え'] }];
        const pick = list[Math.min(outlineN++, list.length - 1)];
        data = { workingTitle: pick.workingTitle, leadIntent: 'l',
          sections: pick.headings.map((h) => ({ heading: h, level: 2, intent: 'x', keywords: [], targetChars: 300, wantsImage: false })) };
      } else if (o.label === '本文執筆') {
        const outlineHeadings = [...o.user.matchAll(/^\d+\. ## (.+?)（/gm)].map((m) => m[1]);
        data = { markdown: ['リード文です。'.repeat(20), ...outlineHeadings.map((h) => `## ${h}\n${'本文です。'.repeat(20)}`)].join('\n\n') };
      } else if (o.label === 'SEO仕上げ') {
        data = { titles: [opts.title ?? '朝7時から始まるペットホテルの一日'], leadParagraph: 'l', metaDescription: 'm', hashtags: [], imageAlts: {}, revisedMarkdown: null };
      } else {
        throw new Error(`想定外のステップ: ${o.label}`);
      }
      return { data: o.schema.parse(data), usage: { inputTokens: o.user.length, outputTokens: 10 } };
    },
  };
  return { llm, calls, prompts: (label: string) => calls.filter((c) => c.label === label).map((c) => c.user) };
}

const baseInput = (over: Partial<GenerationInput> = {}): GenerationInput => ({
  sourceText: 'ペットホテルの一日の流れを書きたい', hintKeywords: [], imageCount: 0, ...over,
});

const pastSame = (n: number): PastArticle[] => Array.from({ length: n }, (_, i) => ({
  title: `${SAME_TITLE}${i === 0 ? '' : `（${['30代男性', '40代女性', '定年後', '夫婦'][i % 4]}向け）`}`,
  primaryKeyword: 'ペットホテル フランチャイズ',
  headings: SAME_HEADINGS,
}));

// ── 1. 過去記事の取り出し（範囲と上限）──────────────────────
describe('toPastArticles: 渡す過去記事の範囲', () => {
  it('★自分自身・取りやめ・期限切れ・失敗・note から消えたもの・タイトル未作成は除く', () => {
    const rows = [
      row({ id: 'self', title: '書き直し中の記事' }),
      row({ id: 'c', state: 'cancelled', title: '取りやめ' }),
      row({ id: 'e', state: 'expired', title: '期限切れ' }),
      row({ id: 'f', state: 'failed', title: '失敗' }),
      row({ id: 'r', title: '消された', removed_at: '2026-11-02' }),
      row({ id: 'g', state: 'generating', title: null }),
      row({ id: 'p', state: 'published', title: '公開済み' }),
      row({ id: 'd', state: 'drafted', title: '下書き' }),
      row({ id: 'w', state: 'awaiting_approval', title: '確認待ち' }),
    ];
    expect(toPastArticles(rows, 'self').map((p) => p.title)).toEqual(['公開済み', '下書き', '確認待ち']);
  });

  it(`最大 ${MAX_PAST_ARTICLES} 件・見出しは1記事 ${MAX_HEADINGS_PER_ARTICLE} 個まで・長い文字は切る`, () => {
    const body = Array.from({ length: 15 }, (_, i) => `## 見出し${i}${'あ'.repeat(60)}\n本文`).join('\n\n');
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: `x${i}`, title: `記事${i}${'い'.repeat(100)}`, body_md: body }));
    const past = toPastArticles(rows, null);
    expect(past).toHaveLength(MAX_PAST_ARTICLES);
    expect(past[0].headings).toHaveLength(MAX_HEADINGS_PER_ARTICLE);
    expect(past[0].headings[0].length).toBeLessThanOrEqual(41);
    expect(past[0].title.length).toBeLessThanOrEqual(61);
  });

  it('見出しは本文から。本文が無ければ構成から。主キーワードは keywords_json から（壊れていても落ちない）', () => {
    const past = toPastArticles([
      row({ id: '1', title: 'A', body_md: '前文\n\n## 本文の見出し\nx', keywords_json: JSON.stringify({ primaryKeyword: '主語' }) }),
      row({ id: '2', title: 'B', outline_json: JSON.stringify({ sections: [{ heading: '構成の見出し' }] }), keywords_json: '{壊れた' }),
    ], null);
    expect(past[0]).toEqual({ title: 'A', primaryKeyword: '主語', headings: ['本文の見出し'] });
    expect(past[1]).toEqual({ title: 'B', primaryKeyword: null, headings: ['構成の見出し'] });
  });
});

// ── 2. プロンプトへの差し込み ────────────────────────────────
describe('プロンプトの過去記事ブロック', () => {
  it('過去記事0件なら空文字（今までどおりのプロンプト）', () => {
    expect(pastArticlesBlock([])).toBe('');
    expect(pastTitlesBlock([])).toBe('');
    const kw = { primaryKeyword: 'k', secondaryKeywords: ['s'], searchIntent: 'i', targetReader: 'r', competitorAngle: 'c' };
    expect(P.buildOutline.user('ネタ', kw, 0)).toBe(P.buildOutline.user('ネタ', kw, 0, null, null, null, ''));
    expect(P.analyzeKeywords.user('ネタ', [])).not.toContain('過去に書いた記事');
  });

  it(`★見出しつきの部分は ${MAX_DETAILED_CHARS} 字まで。超えた古い記事はタイトルと主キーワードだけ`, () => {
    const many: PastArticle[] = Array.from({ length: MAX_PAST_ARTICLES }, (_, i) => ({
      title: `記事${i}`, primaryKeyword: 'kw', headings: Array.from({ length: 10 }, (_, j) => `見出し${j}${'う'.repeat(35)}`),
    }));
    const block = pastArticlesBlock(many);
    // 20本すべてのタイトルは入る
    for (let i = 0; i < MAX_PAST_ARTICLES; i++) expect(block).toContain(`「記事${i}」`);
    // 見出しつきは一部だけ（古いものは見出しが付かない）
    const detailed = block.split('\n').filter((l) => l.trim().startsWith('見出し:')).length;
    expect(detailed).toBeGreaterThan(0);
    expect(detailed).toBeLessThan(MAX_PAST_ARTICLES);
    // ブロック全体の大きさに上限がある（上限＋タイトル行＋説明文）
    expect(block.length).toBeLessThan(MAX_DETAILED_CHARS + MAX_PAST_ARTICLES * 30 + 1200);
  });

  it('★ネタの指示が最優先であることと、重複を明示されたときの扱いを書く', () => {
    const p = pastSame(2);
    expect(pastArticlesBlock(p)).toContain('ネタとナレッジで明示されたテーマ・指示が最優先');
    expect(pastArticlesBlock(p)).not.toContain('明示的に求めているので');
    expect(pastArticlesBlock(p, true)).toContain('明示的に求めているので、そのテーマは変えないこと');
  });

  it('★キーワード分析・構成には見出しつき、本文・仕上げにはタイトルだけが入る', async () => {
    const { llm, prompts } = fakeLlm();
    await generate(llm, baseInput({ pastArticles: pastSame(3) }));
    for (const label of ['キーワード分析', '構成作成']) {
      expect(prompts(label)[0]).toContain(SAME_TITLE);
      expect(prompts(label)[0]).toContain('加盟関連費用363万円には何が含まれる？');
    }
    for (const label of ['本文執筆', 'SEO仕上げ']) {
      expect(prompts(label)[0]).toContain(SAME_TITLE);
      expect(prompts(label)[0]).not.toContain('加盟関連費用363万円には何が含まれる？');
    }
  });

  it('★過去記事0件でも4ステップが従来どおり1回ずつ動き、過去記事のブロックは入らない', async () => {
    const { llm, calls } = fakeLlm({ outlines: [{ workingTitle: SAME_TITLE, headings: SAME_HEADINGS }] });
    const out = await generate(llm, baseInput());
    expect(calls.map((c) => c.label)).toEqual(['キーワード分析', '構成作成', '本文執筆', 'SEO仕上げ']);
    expect(calls.every((c) => !c.user.includes('過去に書いた記事') && !c.user.includes('過去記事のタイトル'))).toBe(true);
    expect(out.outlineRedone).toBe(false);
    expect(out.similarPast).toEqual([]);
  });
});

// ── 3. 似ているかどうか（純関数）────────────────────────────
describe('似ているかどうかの検査（LLM を使わない）', () => {
  it('★同じ検索語の組み替えタイトルは「似ている」、同じ業種でも切り口が違えば「似ていない」', () => {
    expect(textSimilarity(SAME_TITLE, 'ペットホテルのフランチャイズ｜費用と収益と仕事内容')).toBeGreaterThanOrEqual(0.6);
    expect(textSimilarity(SAME_TITLE, '朝7時から始まるペットホテルの一日')).toBeLessThan(0.6);
    expect(textSimilarity('', 'a')).toBe(0);
    expect(textSimilarity('同じ', '同じ')).toBe(1);
  });

  it('★見出しの使い回しを拾う（タイトルが違っても）', () => {
    const hits = findSimilarPast({ title: '40代女性が始めるペットの仕事', headings: [...SAME_HEADINGS.slice(0, 4), '私が決めた理由'] }, pastSame(1));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('headings');
    expect(hits[0].pairs!.length).toBeGreaterThanOrEqual(3);
  });

  it('同じ業種の語が少しかぶる程度では拾わない', () => {
    expect(findSimilarPast({ title: '朝7時から始まるペットホテルの一日', headings: ['朝の受け入れ', '昼の散歩とごはん', '夕方のお迎え', '費用の話は別の記事で'] }, pastSame(3))).toEqual([]);
  });

  it('疑問形の見出しを並べる型が直近でも続いているか', () => {
    expect(repeatsQuestionPattern(SAME_HEADINGS, pastSame(3))).toBe(true);
    expect(repeatsQuestionPattern(SAME_HEADINGS, pastSame(2))).toBe(false); // 過去が少なければ判断しない
    expect(repeatsQuestionPattern(['朝の受け入れ', '昼の散歩', '夕方のお迎え', '夜の見回り', '一日の振り返り'], pastSame(5))).toBe(false);
  });

  it('ネタが重複を明示しているか', () => {
    expect(allowsOverlap('同じテーマでいいから費用の決定版を')).toBe(true);
    expect(allowsOverlap('前の記事を書き直して')).toBe(false);
    expect(allowsOverlap('ネタ', '前の記事をリライトしたい')).toBe(true);
    expect(allowsOverlap('かぶってもいいので書いて')).toBe(true);
    expect(allowsOverlap('ペットホテルの一日', null)).toBe(false);
  });

  it('やり直しの指摘には、何が似ていたかを具体的に書く／プレビューの注意は1本だけ', () => {
    const hits = findSimilarPast({ title: SAME_TITLE, headings: SAME_HEADINGS }, pastSame(2));
    const note = outlineRedoNote(hits, true);
    expect(note).toContain(SAME_TITLE);
    expect(note).toContain('疑問形の見出しを並べる型');
    expect(similarityNotice([])).toBeNull();
    expect(similarityNotice(hits)).toContain('と');
    expect(similarityNotice(hits)).toContain('似ています');
  });
});

// ── 4. 似ているときの挙動（構成を最大1回やり直す）────────────
describe('generate: 構成が過去記事と似ているとき', () => {
  it('★強く似ていたら構成だけを1回やり直し、2回目の指示に理由が入る（本文・仕上げは1回ずつ）', async () => {
    const { llm, calls, prompts } = fakeLlm({ outlines: [
      { workingTitle: SAME_TITLE, headings: SAME_HEADINGS },
      { workingTitle: '朝7時から始まるペットホテルの一日', headings: ['朝の受け入れ', '昼の散歩とごはん', '夕方のお迎え'] },
    ] });
    const out = await generate(llm, baseInput({ pastArticles: pastSame(3) }));
    expect(calls.map((c) => c.label)).toEqual(['キーワード分析', '構成作成', '構成作成', '本文執筆', 'SEO仕上げ']);
    expect(prompts('構成作成')[0]).not.toContain('やり直しの理由');
    expect(prompts('構成作成')[1]).toContain('やり直しの理由');
    expect(out.outlineRedone).toBe(true);
    expect(out.outline.workingTitle).toBe('朝7時から始まるペットホテルの一日');
    expect(out.similarPast).toEqual([]);
    // 費用の合計にやり直しの分も入る
    expect(out.usage.inputTokens).toBe(calls.reduce((s, c) => s + c.user.length, 0));
  });

  it('★2回目も似ていたら、それ以上はやり直さず、できあがりの注意を返す（費用の上限）', async () => {
    const { llm, calls } = fakeLlm({
      outlines: [{ workingTitle: SAME_TITLE, headings: SAME_HEADINGS }],
      title: 'ペットホテルのフランチャイズ｜費用・収益・仕事内容',
    });
    const out = await generate(llm, baseInput({ pastArticles: pastSame(3) }));
    expect(calls.filter((c) => c.label === '構成作成')).toHaveLength(2);
    expect(out.similarPast.length).toBeGreaterThan(0);
    expect(similarityNotice(out.similarPast)).toContain('似ています');
  });

  it('★ネタが重複を明示していれば、やり直さず注意も出さない', async () => {
    const { llm, calls } = fakeLlm({ outlines: [{ workingTitle: SAME_TITLE, headings: SAME_HEADINGS }], title: SAME_TITLE });
    const out = await generate(llm, baseInput({ pastArticles: pastSame(3), overlapAllowed: true }));
    expect(calls.filter((c) => c.label === '構成作成')).toHaveLength(1);
    expect(out.outlineRedone).toBe(false);
    expect(out.similarPast).toEqual([]);
  });

  it('似ていなければやり直さない', async () => {
    const { llm, calls } = fakeLlm();
    const out = await generate(llm, baseInput({ pastArticles: pastSame(3) }));
    expect(calls.filter((c) => c.label === '構成作成')).toHaveLength(1);
    expect(out.outlineRedone).toBe(false);
  });
});

// ── 5. プレビューの注意 ──────────────────────────────────
describe('プレビュー', () => {
  it('注意があればプレビューに出し、無ければ何も足さない', () => {
    const base = { articleId: 'a', title: 't', markdown: '## 見出し\n本文', metaDescription: '', hashtags: [], charCount: 10 };
    const note = '過去の記事「X」とタイトルが似ています。';
    expect(JSON.stringify(buildPreview({ ...base, similarNote: note }))).toContain(note);
    expect(JSON.stringify(buildPreview(base))).not.toContain('似ています');
  });
});

// ── 6. generateArticle（DB から過去記事を読む道）──────────────
describe('generateArticle: DB の過去記事が渡る', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { databases.splice(0).forEach((d) => d.close()); });
  const ROOT = new URL('../../', import.meta.url).pathname;

  function asD1(sqlite: DatabaseSync): D1Database {
    return { prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...v: unknown[]) { params = v; return api; },
        async first<T>() { return (sqlite.prepare(sql).get(...(params as [])) as T) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...(params as [])) as T[] }; },
        async run() { const r = sqlite.prepare(sql).run(...(params as [])); return { success: true, meta: { changes: Number(r.changes) } }; },
      };
      return api;
    } } as unknown as D1Database;
  }

  it('★公開済み・下書きは入り、取りやめ・自分自身は入らない。似ていればプレビュー用の注意が返る', async () => {
    const { vi } = await import('vitest');
    const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
    for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
    }
    const db = new Db(asD1(sqlite));
    await db.ensureTenant();
    const body = SAME_HEADINGS.map((h) => `## ${h}\n本文`).join('\n\n');
    const mk = async (title: string, state: ArticleRow['state']) => {
      const a = await db.createArticle(DEFAULT_TENANT_ID, 'ネタ', null);
      await db.updateArticle(a.id, { title, body_md: body, state });
      return a;
    };
    await mk('公開済みの記事｜ペットホテル', 'published');
    await mk('下書きの記事｜ペットホテル', 'drafted');
    await mk('取りやめた記事｜ペットホテル', 'cancelled');
    const self = await db.createArticle(DEFAULT_TENANT_ID, 'ペットホテルの費用を知りたい', null);
    await db.updateArticle(self.id, { title: '自分自身の前の版' });

    const { llm, prompts } = fakeLlm({ outlines: [{ workingTitle: SAME_TITLE, headings: SAME_HEADINGS }], title: SAME_TITLE });
    const llmMod = await import('../../src/ports/llm');
    vi.spyOn(llmMod, 'createLlm').mockReturnValue(llm);
    const { generateArticle } = await import('../../src/core/article/service');
    const res = await generateArticle({
      db, llm: { provider: 'openai', openaiKey: null }, noteSession: { cookieHeader: 'x', userAgent: 'ua', urlname: 't' },
      ownerLineUserId: 'owner', images: { put: async () => {}, get: async () => null, delete: async () => {} },
    } as never, self.id);
    vi.restoreAllMocks();

    const kwPrompt = prompts('キーワード分析')[0];
    expect(kwPrompt).toContain('公開済みの記事｜ペットホテル');
    expect(kwPrompt).toContain('下書きの記事｜ペットホテル');
    expect(kwPrompt).not.toContain('取りやめた記事');
    expect(kwPrompt).not.toContain('自分自身の前の版');
    // 見出しが同じなので構成は1回やり直し、それでも似ていればプレビューの注意が付く
    expect(prompts('構成作成')).toHaveLength(2);
    expect(res.similarNotice).toContain('似ています');
  });
});
