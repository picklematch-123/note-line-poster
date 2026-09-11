import { describe, it, expect } from 'vitest';
import { substitute, assertSafePath, runPlan, PlanError, NOTE_ORIGIN } from '../../extension/plan-runner.js';
import { buildPlan, planAssetIds } from '../../src/core/agent/plan';
import { hashToken } from '../../src/core/agent/jobs';
import type { ArticleRow, ImageRow } from '../../src/ports/storage/db';

// ── 手順書の実行（拡張の中身）─────────────────────────
describe('置換', () => {
  it('文字列・配列・入れ子を通して置き換える', () => {
    const vars = { note_id: 123, note_key: 'nabc' };
    expect(substitute('/api/v1/text_notes/{{note_id}}', vars)).toBe('/api/v1/text_notes/123');
    expect(substitute({ slug: 'slug-{{note_key}}', n: 1 }, vars)).toEqual({ slug: 'slug-nabc', n: 1 });
    expect(substitute(['{{note_id}}', { a: '{{note_key}}' }], vars)).toEqual(['123', { a: 'nabc' }]);
  });

  it('知らない目印はそのまま残す（黙って空にしない）', () => {
    expect(substitute('{{unknown}}', { a: 1 })).toBe('{{unknown}}');
  });

  it('本文に埋めた画像URLの目印を差し替えられる', () => {
    const html = '<p>あ</p><figure><img src="{{image1_url}}" alt="い"></figure>';
    expect(substitute(html, { image1_url: 'https://assets.st-note.com/x.png' }))
      .toBe('<p>あ</p><figure><img src="https://assets.st-note.com/x.png" alt="い"></figure>');
  });
});

describe('★宛先の制限（拡張の最後の歯止め）', () => {
  it('note の API だけを許す', () => {
    expect(assertSafePath('/api/v1/text_notes')).toBe(`${NOTE_ORIGIN}/api/v1/text_notes`);
    expect(assertSafePath('/api/v2/current_user')).toBe(`${NOTE_ORIGIN}/api/v2/current_user`);
    expect(assertSafePath('/api/v3/images/upload')).toBe(`${NOTE_ORIGIN}/api/v3/images/upload`);
  });

  it('★note 以外へは絶対に飛ばさない', () => {
    const bad = [
      'https://evil.example.com/steal',
      '//evil.example.com/steal',
      'http://note.com.evil.example.com/api/v1/x',
      '/../../etc/passwd',
      '/login',
      '/api/',
      '/api/v1/../../admin',
      '/api/v1/x\nHost: evil.example.com',
      '',
    ];
    for (const path of bad) {
      expect(() => assertSafePath(path), `path=${path}`).toThrow(PlanError);
    }
  });

  it('note の下書き保存で使うクエリ文字列は通す', () => {
    expect(assertSafePath('/api/v1/text_notes/draft_save?id=7&is_temp_saved=true'))
      .toBe(`${NOTE_ORIGIN}/api/v1/text_notes/draft_save?id=7&is_temp_saved=true`);
  });

  it('文字列以外も弾く', () => {
    expect(() => assertSafePath(null)).toThrow(PlanError);
    expect(() => assertSafePath({ toString: () => '/api/v1/x' })).toThrow(PlanError);
  });
});

/** note の応答を差し替えられるようにした実行環境。 */
function ctx(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  return {
    calls,
    fetchNote: async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      const key = Object.keys(responses).find((k) => url.includes(k));
      const r = key ? responses[key] : { status: 200, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    },
    fetchAsset: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  };
}

describe('手順書の実行', () => {
  const plan = {
    version: 1,
    steps: [
      {
        id: 'create', method: 'POST', path: '/api/v1/text_notes', json: { template_key: null },
        capture: { note_id: 'id', note_key: 'key' },
      },
      {
        id: 'publish', method: 'PUT', path: '/api/v1/text_notes/{{note_id}}',
        json: { slug: 'slug-{{note_key}}', status: 'published' },
      },
    ],
  };

  it('順番に実行し、取り込んだ値を次の手順に渡す', async () => {
    const c = ctx({ '/text_notes': { body: { data: { id: 42, key: 'nabc123' } } } });
    const { vars, steps } = await runPlan(plan, c);

    expect(steps).toEqual(['create', 'publish']);
    expect(vars).toEqual({ note_id: 42, note_key: 'nabc123' });
    expect(c.calls[1].url).toBe(`${NOTE_ORIGIN}/api/v1/text_notes/42`);
    expect(JSON.parse(c.calls[1].body as string).slug).toBe('slug-nabc123');
  });

  it('★Cookie はブラウザに任せる（こちらでは触らない）', async () => {
    const inits: RequestInit[] = [];
    await runPlan(plan, {
      fetchNote: async (_url: string, init: RequestInit) => {
        inits.push(init);
        return new Response(JSON.stringify({ data: { id: 1, key: 'k' } }), { status: 200 });
      },
      fetchAsset: async () => new Blob([]),
    });
    for (const init of inits) {
      expect(init.credentials).toBe('include');
      expect(JSON.stringify(init.headers)).not.toMatch(/cookie/i);
      // ★よそへ飛ばされない
      expect(init.redirect).toBe('error');
    }
  });

  it('★途中で失敗したら、そこで止める（中途半端に進めない）', async () => {
    const c = ctx({ '/text_notes': { status: 401, body: { error: { code: 'auth', message: '未ログイン' } } } });
    await expect(runPlan(plan, c)).rejects.toMatchObject({
      name: 'PlanError', status: 401, code: 'auth', stepId: 'create',
    });
    expect(c.calls).toHaveLength(1); // 2つ目は実行されていない
  });

  it('必要な値が返ってこなければ、次へ進まない', async () => {
    const c = ctx({ '/text_notes': { body: { data: { id: 42 } } } }); // key が無い
    await expect(runPlan(plan, c)).rejects.toThrow(/key/);
    expect(c.calls).toHaveLength(1);
  });

  it('画像は multipart で送る', async () => {
    const withImage = {
      version: 1,
      steps: [{
        id: 'image1', method: 'POST', path: '/api/v1/image_upload/text_note_picture',
        form: [
          { name: 'file', asset: 'img-1', fileName: 'image1.png' },
          { name: 'note_id', value: '{{note_id}}' },
        ],
        capture: { image1_url: 'url' },
      }],
    };
    const c = ctx({ '/image_upload': { body: { data: { url: 'https://assets.st-note.com/a.png' } } } });
    const { vars } = await runPlan(withImage, c);
    expect(vars.image1_url).toBe('https://assets.st-note.com/a.png');
    expect(c.calls[0].body).toBeInstanceOf(FormData);
  });

  it('手順が空なら実行しない', async () => {
    await expect(runPlan({ version: 1, steps: [] }, ctx({}))).rejects.toThrow(PlanError);
    await expect(runPlan(null, ctx({}))).rejects.toThrow(PlanError);
  });
});

// ── 手順書の組み立て（サーバー側）─────────────────────
function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 'a1', tenant_id: 'tenant_default', state: 'awaiting_approval',
    source_text: 'ネタ', keywords_json: null, outline_json: null,
    title: 'いちご大福の作り方', body_md: '## 見出し\n本文です。\n\n[画像1]\n\nおわり。',
    body_html: null, meta_description: null, hashtags_json: '["いちご大福"]',
    image_alts_json: '{"1":"いちご大福の写真"}',
    note_id: null, note_key: null, note_url: null,
    error_code: null, error_message: null, llm_input_tokens: 0, llm_output_tokens: 0,
    revision_instruction: null, revision_count: 0,
    approved_at: null, approved_by: null, published_at: null,
    created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
    ...over,
  } as ArticleRow;
}

function image(id: string): ImageRow {
  return {
    id, article_id: 'a1', slot_index: null, r2_key: `k/${id}`, mime_type: 'image/png',
    size_bytes: 100, alt_text: null, note_image_url: null, line_message_id: null, is_eyecatch: 0,
  };
}

function planDeps(images: ImageRow[] = [], eyecatch: ImageRow | null = null) {
  return {
    db: { listImages: async () => images, getEyecatch: async () => eyecatch },
    images: { get: async () => null },
  } as never;
}

describe('手順書の組み立て', () => {
  it('新規記事は「器を作る」から始まる', async () => {
    const plan = await buildPlan(planDeps(), article(), 'publish');
    expect(plan.steps.map((s) => s.id)).toEqual(['create', 'draft_save', 'publish']);
    expect(plan.steps[0].capture).toEqual({ note_id: 'id', note_key: 'key' });
    expect(plan.vars).toEqual({});
  });

  it('★既存記事の更新では器を作らない（記事を増やさない）', async () => {
    const plan = await buildPlan(planDeps(), article({ note_id: '99', note_key: 'nxyz' }), 'publish');
    expect(plan.steps.map((s) => s.id)).toEqual(['draft_save', 'publish']);
    expect(plan.vars).toEqual({ note_id: 99, note_key: 'nxyz' });
  });

  it('下書き保存では公開の手順を作らない', async () => {
    const plan = await buildPlan(planDeps(), article(), 'draft');
    expect(plan.steps.map((s) => s.id)).toEqual(['create', 'draft_save']);
    expect(plan.steps.some((s) => s.id === 'publish')).toBe(false);
  });

  it('★公開の本文は free_body、下書きは body（取り違えると 422 になる）', async () => {
    const plan = await buildPlan(planDeps(), article(), 'publish');
    const draft = plan.steps.find((s) => s.id === 'draft_save')!.json as Record<string, unknown>;
    const publish = plan.steps.find((s) => s.id === 'publish')!.json as Record<string, unknown>;
    expect(draft.body).toBeTruthy();
    expect(draft.free_body).toBeUndefined();
    expect(publish.free_body).toBeTruthy();
    expect(publish.body).toBeUndefined();
  });

  it('画像はアップロードしてから本文に差し込む', async () => {
    const plan = await buildPlan(planDeps([image('img-1')]), article(), 'publish');
    const ids = plan.steps.map((s) => s.id);
    expect(ids).toEqual(['create', 'image1', 'draft_save', 'publish']);

    const publish = plan.steps.find((s) => s.id === 'publish')!.json as Record<string, string>;
    expect(publish.free_body).toContain('{{image1_url}}');
    expect(publish.free_body).toContain('alt="いちご大福の写真"');
    expect(ids.indexOf('image1')).toBeLessThan(ids.indexOf('publish'));
  });

  it('サムネイルは本文に出さない（note では og:image になる）', async () => {
    const plan = await buildPlan(planDeps([], image('eye-1')), article(), 'publish');
    const eyecatch = plan.steps.find((s) => s.id === 'eyecatch')!;
    expect(eyecatch.form?.find((f) => f.name === 'width')?.value).toBe('1920');
    expect(eyecatch.form?.find((f) => f.name === 'height')?.value).toBe('1005');
    const publish = plan.steps.find((s) => s.id === 'publish')!.json as Record<string, string>;
    expect(publish.free_body).not.toContain('eye-1');
  });

  it('★クライアントの記事を AI 学習に回さない設定が入っている', async () => {
    const plan = await buildPlan(planDeps(), article(), 'publish');
    const publish = plan.steps.find((s) => s.id === 'publish')!.json as Record<string, unknown>;
    expect(publish.exclude_ai_learning_reward).toBe(true);
  });

  it('渡してよい画像だけを列挙できる', async () => {
    const plan = await buildPlan(planDeps([image('img-1'), image('img-2')], image('eye-1')), article(), 'publish');
    expect(planAssetIds(plan).sort()).toEqual(['eye-1', 'img-1', 'img-2']);
  });

  it('★組み立てた手順は、そのまま実行できる形になっている', async () => {
    const plan = await buildPlan(planDeps([image('img-1')]), article(), 'publish');
    const c = ctx({
      '/text_notes': { body: { data: { id: 7, key: 'nkey7' } } },
      '/image_upload': { body: { data: { url: 'https://assets.st-note.com/a.png' } } },
    });
    const { vars, steps } = await runPlan(plan, c);
    expect(steps).toEqual(['create', 'image1', 'draft_save', 'publish']);

    // 本文の目印が実URLに差し替わっている
    const published = JSON.parse(c.calls.at(-1)!.body as string);
    expect(published.free_body).toContain('https://assets.st-note.com/a.png');
    expect(published.free_body).not.toContain('{{');
    expect(vars.note_key).toBe('nkey7');
  });
});

// ── 端末トークン ─────────────────────────────────────
describe('端末トークン', () => {
  it('★平文を保存できない形（ハッシュ）に変える', async () => {
    const token = 'a'.repeat(64);
    const hash = await hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('同じトークンは同じハッシュ、違えば違う', async () => {
    expect(await hashToken('abc')).toBe(await hashToken('abc'));
    expect(await hashToken('abc')).not.toBe(await hashToken('abd'));
  });
});
