import { describe, it, expect } from 'vitest';
import { toLineText, chunk, buildFullText } from '../../src/adapters/line/messages/fulltext';

const MD = [
  'リード文です。',
  '',
  '## 最初の見出し',
  '',
  '[画像1]',
  '',
  '本文A。**強調**もあります。',
  '',
  '### 小見出し',
  '',
  '- 箇条書き1',
  '- 箇条書き2',
  '',
  '## 次の見出し',
  '',
  '> 引用です',
  '',
  '[リンク](https://example.com)',
].join('\n');

describe('toLineText', () => {
  it('h2 に通し番号を振る（修正指示に使うため）', () => {
    const out = toLineText(MD);
    expect(out).toContain('■1 最初の見出し');
    expect(out).toContain('■2 次の見出し');
  });

  it('h3 は番号を振らず字下げする', () => {
    expect(toLineText(MD)).toContain('└ 小見出し');
  });

  it('箇条書きを LINE で読める記号にする', () => {
    const out = toLineText(MD);
    expect(out).toContain('・箇条書き1');
    expect(out).not.toContain('- 箇条書き1');
  });

  it('LINE に太字が無いので ** を落とす', () => {
    const out = toLineText(MD);
    expect(out).toContain('本文A。強調もあります。');
    expect(out).not.toContain('**');
  });

  it('リンクを「文言（URL）」の形にする', () => {
    expect(toLineText(MD)).toContain('リンク（https://example.com）');
  });

  it('引用を記号にする', () => {
    expect(toLineText(MD)).toContain('｜引用です');
  });

  it('画像プレースホルダは残す（位置が分かるように）', () => {
    expect(toLineText(MD)).toContain('[画像1]');
  });

  it('番号リストはそのまま番号を保つ', () => {
    expect(toLineText('1. あ\n2. い')).toContain('1. あ');
  });

  it('区切り線を変換する', () => {
    expect(toLineText('---')).toBe('────────');
  });
});

describe('chunk', () => {
  it('上限以下なら分割しない', () => {
    expect(chunk('短い本文', 100)).toEqual(['短い本文']);
  });

  it('上限を超えたら分割する', () => {
    const body = Array.from({ length: 50 }, (_, i) => `段落${i}です。`).join('\n\n');
    const parts = chunk(body, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('分割しても内容が失われない', () => {
    const body = Array.from({ length: 30 }, (_, i) => `段落${i}`).join('\n\n');
    const joined = chunk(body, 60).join('\n\n');
    for (let i = 0; i < 30; i++) expect(joined).toContain(`段落${i}`);
  });

  it('段落の切れ目を優先して切る', () => {
    const body = 'あ'.repeat(40) + '\n\n' + 'い'.repeat(40);
    const parts = chunk(body, 50);
    expect(parts[0]).toBe('あ'.repeat(40));
  });
});

describe('buildFullText', () => {
  const input = {
    articleId: 'a1',
    title: 'テストタイトル',
    markdown: MD,
    metaDescription: 'これは説明です。',
    hashtags: ['タグ1', 'タグ2'],
    imageCount: 1,
  };

  it('タイトルと本文、案内の順で組み立てる', () => {
    const msgs = buildFullText(input);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(String(msgs[0].text)).toContain('テストタイトル');
    expect(String(msgs[0].text)).toContain('■1 最初の見出し');
  });

  it('最後のメッセージに公開ボタンを付ける', () => {
    const msgs = buildFullText(input);
    const last = msgs[msgs.length - 1] as any;
    expect(last.quickReply.items.some((i: any) => i.action.data.includes('action=publish'))).toBe(true);
    expect(last.quickReply.items.some((i: any) => i.action.data.includes('action=cancel'))).toBe(true);
  });

  it('画像があるときは画像移動の例を出す', () => {
    const last = buildFullText(input)[buildFullText(input).length - 1] as any;
    expect(last.text).toContain('画像');
  });

  it('画像が無いときは画像の例を出さない', () => {
    const msgs = buildFullText({ ...input, imageCount: 0, markdown: '## 見出し\n\n本文' });
    const last = msgs[msgs.length - 1] as any;
    expect(last.text).not.toContain('を■3の下に移して');
  });

  it('LINE の上限（5通）を超えない', () => {
    const long = Array.from({ length: 400 }, (_, i) => `## 見出し${i}\n\n${'あ'.repeat(200)}`).join('\n\n');
    const msgs = buildFullText({ ...input, markdown: long });
    expect(msgs.length).toBeLessThanOrEqual(5);
  });

  it('1通あたり LINE の文字数上限を超えない', () => {
    const long = Array.from({ length: 100 }, (_, i) => `## 見出し${i}\n\n${'あ'.repeat(100)}`).join('\n\n');
    for (const m of buildFullText({ ...input, markdown: long })) {
      expect(String(m.text).length).toBeLessThanOrEqual(5000);
    }
  });
});
