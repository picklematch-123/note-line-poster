/**
 * 記事プレビューの Flex Message。
 *
 * LINE の画面で「構成が見える」ことが承認の質を決める。
 * 本文全文は入らないので、見出し構成 + 画像位置 + 冒頭を見せる。
 */
import type { LineMessage } from '../client';
import { parse, parseHeadings } from '../../../core/article/placeholders';

const COLOR = {
  text: '#333333',
  sub: '#888888',
  accent: '#2E7D6F',
  image: '#C77D3A',
};

export interface PreviewInput {
  articleId: string;
  title: string;
  markdown: string;
  metaDescription: string;
  hashtags: string[];
  charCount: number;
  /** サムネイル（見出し画像）が設定されているか */
  hasEyecatch?: boolean;
}

/**
 * 見出しと画像位置を1つの階層リストにする。
 * h2 には番号を振る（全文表示の ■1 ■2 と一致させ、そのまま修正指示に使えるようにするため）。
 */
function structureLines(markdown: string): Array<{ label: string; mark: string; kind: 'h2' | 'h3' | 'image' }> {
  const headings = parseHeadings(markdown);
  const images = parse(markdown);
  const rows: Array<{ line: number; label: string; mark: string; kind: 'h2' | 'h3' | 'image' }> = [];

  let h2 = 0;
  for (const h of headings) {
    if (h.level === 2) h2++;
    rows.push({
      line: h.line,
      label: h.text,
      mark: h.level === 2 ? `■${h2}` : '└',
      kind: h.level === 2 ? 'h2' : 'h3',
    });
  }
  for (const p of images) {
    rows.push({ line: p.line, label: `[画像${p.index}]`, mark: '🖼', kind: 'image' });
  }
  return rows.sort((a, b) => a.line - b.line).map(({ label, mark, kind }) => ({ label, mark, kind }));
}

/** 本文冒頭（記法を落としたプレーンテキスト）。 */
function excerpt(markdown: string, max = 140): string {
  const plain = markdown
    .replace(/\[画像\d+\]/g, '')
    .replace(/^#{2,3}\s+.*$/gm, '')
    .replace(/[*>-]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

export function buildPreview(input: PreviewInput): LineMessage {
  const rows = structureLines(input.markdown);

  const structureBox = rows.slice(0, 14).map((r) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: r.mark,
        size: 'xs',
        color: r.kind === 'image' ? COLOR.image : COLOR.accent,
        flex: 2,
      },
      {
        type: 'text',
        text: r.label,
        size: 'sm',
        color: r.kind === 'image' ? COLOR.image : COLOR.text,
        weight: r.kind === 'h2' ? 'bold' : 'regular',
        flex: 8,
        wrap: true,
      },
    ],
  }));

  return {
    type: 'flex',
    altText: `記事ができました: ${input.title}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '記事ができました', size: 'xs', color: COLOR.sub },
          { type: 'text', text: input.title, weight: 'bold', size: 'lg', wrap: true, color: COLOR.text },
          {
            type: 'text',
            text: `約${input.charCount.toLocaleString()}字`
              + (input.hasEyecatch ? ' ・ サムネあり' : '')
              + (input.hashtags.length ? ' ・ ' + input.hashtags.slice(0, 3).map((h) => `#${h}`).join(' ') : ''),
            size: 'xs',
            color: COLOR.sub,
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '構成', size: 'xs', color: COLOR.sub, margin: 'md' },
          ...(structureBox.length
            ? structureBox
            : [{ type: 'text', text: '（見出しなし）', size: 'sm', color: COLOR.sub }]),
          ...(rows.length > 14
            ? [{ type: 'text', text: `ほか${rows.length - 14}項目`, size: 'xs', color: COLOR.sub }]
            : []),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '書き出し', size: 'xs', color: COLOR.sub, margin: 'md' },
          { type: 'text', text: excerpt(input.markdown), size: 'sm', wrap: true, color: COLOR.text },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: '全文を読む', data: `action=fulltext&id=${input.articleId}`, displayText: '全文を読む' },
          },
          {
            type: 'button',
            style: 'primary',
            color: COLOR.accent,
            height: 'sm',
            action: { type: 'postback', label: '公開する', data: `action=publish&id=${input.articleId}`, displayText: '公開する' },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: '下書きに保存する', data: `action=savedraft&id=${input.articleId}`, displayText: '下書きに保存する' },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: { type: 'postback', label: '修正する', data: `action=revise&id=${input.articleId}`, displayText: '修正する' },
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: { type: 'postback', label: 'やめる', data: `action=cancel&id=${input.articleId}`, displayText: 'やめる' },
              },
            ],
          },
          {
            type: 'text',
            text: 'この記事を片付けるまで、次の記事は作りません。「公開する」「下書きに保存する」「やめる」のどれかを選んでください',
            size: 'xxs',
            color: COLOR.sub,
            wrap: true,
            margin: 'sm',
          },
        ],
      },
    },
  };
}
