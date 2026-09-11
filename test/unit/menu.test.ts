import { describe, it, expect } from 'vitest';
import { parseIndex, normalizeCommand } from '../../src/adapters/line/mode';
import { buildMenu, buildArticleList, buildArticleActions, stateLabel } from '../../src/adapters/line/messages/menu';
import type { ArticleRow } from '../../src/ports/storage/db';

function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 'a1', tenant_id: 't1', state: 'published', source_text: 'ネタ',
    keywords_json: null, outline_json: null, title: 'テスト記事', body_md: '## 見出し\n\n本文',
    body_html: null, meta_description: null, hashtags_json: null,
    image_alts_json: null, note_id: '123', note_key: 'nabc', note_url: 'https://note.com/x/n/nabc',
    error_code: null, error_message: null, llm_input_tokens: 0, llm_output_tokens: 0,
    revision_instruction: null, revision_count: 0,
    approved_at: null, approved_by: null, published_at: '2026-08-28T05:00:00.000Z',
    created_at: '2026-08-28T05:00:00.000Z', updated_at: '2026-08-28T05:00:00.000Z',
    ...over,
  } as ArticleRow;
}

describe('parseIndex（一覧から連番で選ぶ）', () => {
  it('半角数字を読む', () => {
    expect(parseIndex('1')).toBe(1);
    expect(parseIndex('10')).toBe(10);
  });

  it('全角数字も読む', () => {
    expect(parseIndex('２')).toBe(2);
    expect(parseIndex('１２')).toBe(12);
  });

  it('「1番」「1番目」も読む', () => {
    expect(parseIndex('1番')).toBe(1);
    expect(parseIndex('3番目')).toBe(3);
  });

  it('前後の空白を無視する', () => {
    expect(parseIndex('  2  ')).toBe(2);
  });

  it('番号でないものは null', () => {
    expect(parseIndex('タイトルを直して')).toBeNull();
    expect(parseIndex('0')).toBeNull();
    expect(parseIndex('')).toBeNull();
    expect(parseIndex('100')).toBeNull();
  });

  it('文章に数字が含まれるだけなら選択とみなさない', () => {
    expect(parseIndex('画像2を移動して')).toBeNull();
    expect(parseIndex('3分の2に減らして')).toBeNull();
  });
});

describe('normalizeCommand（リッチメニューの文言ゆれを吸収する）', () => {
  const LIST = '過去記事一覧・修正';

  it('中黒の種類が違っても同じ文字列になる', () => {
    // GUI で入力すると別の中黒が混ざることがある
    expect(normalizeCommand('過去記事一覧･修正')).toBe(LIST);  // 半角中黒 U+FF65
    expect(normalizeCommand('過去記事一覧·修正')).toBe(LIST);  // ラテン中点 U+00B7
    expect(normalizeCommand('過去記事一覧•修正')).toBe(LIST);  // ビュレット
  });

  it('前後や途中の空白を落とす', () => {
    expect(normalizeCommand('  記事を作成する ')).toBe('記事を作成する');
    expect(normalizeCommand('過去記事一覧 ・ 修正')).toBe(LIST);
    expect(normalizeCommand('記事を　作成する')).toBe('記事を作成する'); // 全角スペース
  });

  it('全角英数字を半角にする', () => {
    expect(normalizeCommand('ＨＥＬＰ')).toBe('HELP');
  });

  it('普通の文言はそのまま', () => {
    expect(normalizeCommand('プロフィールを登録する')).toBe('プロフィールを登録する');
  });
});

describe('stateLabel', () => {
  it('顧客に意味が伝わる日本語にする', () => {
    expect(stateLabel('awaiting_approval')).toBe('確認待ち');
    expect(stateLabel('published')).toBe('公開済み');
    expect(stateLabel('failed')).toBe('失敗');
    expect(stateLabel('awaiting_session')).toBe('連携切れ');
  });

  it('未知の状態はそのまま返す（画面が壊れないように）', () => {
    expect(stateLabel('unknown_state')).toBe('unknown_state');
  });
});

describe('buildMenu', () => {
  it('3つの操作を出す', () => {
    const m = buildMenu() as any;
    expect(m.text).toContain('記事作成');
    expect(m.text).toContain('記事一覧');
    expect(m.text).toContain('ナレッジ');
    expect(m.quickReply.items).toHaveLength(3);
    // ★リッチメニューの画像には「プロフィール登録」と刷ってある。
    //   画像を差し替えるまで、押したときに送られる文言は変えない
    const profile = m.quickReply.items.find((i: any) => i.action.data === 'action=menu_profile');
    expect(profile.action.displayText).toBe('プロフィールを登録する');
  });
});

describe('buildArticleList', () => {
  it('連番つきで一覧にする', () => {
    const m = buildArticleList([
      article({ id: 'a1', title: '記事A' }),
      article({ id: 'a2', title: '記事B', state: 'awaiting_approval' }),
    ]) as any;
    expect(m.text).toContain('1. 記事A');
    expect(m.text).toContain('2. 記事B');
    expect(m.text).toContain('公開済み');
    expect(m.text).toContain('確認待ち');
  });

  it('番号のボタンを付ける', () => {
    const m = buildArticleList([article(), article({ id: 'a2' })]) as any;
    const labels = m.quickReply.items.map((i: any) => i.action.label);
    expect(labels).toContain('1');
    expect(labels).toContain('2');
  });

  it('ボタンは LINE の上限（13個）を超えない', () => {
    const many = Array.from({ length: 10 }, (_, i) => article({ id: `a${i}` }));
    const m = buildArticleList(many) as any;
    expect(m.quickReply.items.length).toBeLessThanOrEqual(13);
  });

  it('記事が無ければ作り方を案内する', () => {
    const m = buildArticleList([]) as any;
    expect(m.text).toContain('まだ記事がありません');
    expect(m.quickReply).toBeUndefined();
  });

  it('タイトル未生成でも落ちない', () => {
    const m = buildArticleList([article({ title: null, state: 'generating' })]) as any;
    expect(m.text).toContain('（作成中）');
  });
});

describe('buildArticleActions', () => {
  it('公開済みには「修正する」を出し、公開ボタンは出さない', () => {
    const m = buildArticleActions(article({ state: 'published' })) as any;
    const data = m.quickReply.items.map((i: any) => i.action.data).join(' ');
    expect(data).toContain('action=reopen');
    expect(data).not.toContain('action=publish');
    expect(m.text).toContain('同じURLのまま更新');
  });

  it('確認待ちには公開と修正を出す', () => {
    const m = buildArticleActions(article({ state: 'awaiting_approval', note_url: null })) as any;
    const data = m.quickReply.items.map((i: any) => i.action.data).join(' ');
    expect(data).toContain('action=publish');
    expect(data).toContain('action=revise');
  });

  it('失敗には作り直しを出す', () => {
    const m = buildArticleActions(article({ state: 'failed' })) as any;
    expect(m.quickReply.items.map((i: any) => i.action.data).join(' ')).toContain('action=retry');
  });

  it('どの状態でも全文と一覧に戻るは出す', () => {
    for (const state of ['published', 'awaiting_approval', 'failed', 'generating'] as const) {
      const m = buildArticleActions(article({ state })) as any;
      const data = m.quickReply.items.map((i: any) => i.action.data).join(' ');
      expect(data, state).toContain('action=fulltext');
      expect(data, state).toContain('action=menu_list');
    }
  });

  it('公開済みなら note の URL を見せる', () => {
    const m = buildArticleActions(article({ state: 'published' })) as any;
    expect(m.text).toContain('https://note.com/x/n/nabc');
  });
});
