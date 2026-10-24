/**
 * 記事プレビューの Flex Message。
 *
 * LINE の画面で「構成が見える」ことが承認の質を決める。
 * 本文全文は入らないので、見出し構成 + 画像位置 + 冒頭を見せる。
 */
import type { LineMessage } from '../client';
import { parse, parseHeadings } from '../../../core/article/placeholders';
import type { ResearchView } from './research';
import type { InlineImagesView } from '../../../core/image/inline';
import { inlinePreviewLines } from './inline';

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
  /** サムネについて伝えること（作れなかった理由・未設定の案内など） */
  thumbnailNote?: string;
  /** サムネを AI が作ったか */
  thumbnailGenerated?: boolean;
  /** 「サムネを作り直す」を出すか（キー未設定のときは出さない） */
  canRegenerateThumbnail?: boolean;
  /** Webリサーチの結果（調べたか・出典の数・要確認の語）。無ければ表示しない */
  research?: ResearchView;
  /** AI が作った文中画像（P3）の枚数と状態。無ければ表示しない */
  inlineImages?: InlineImagesView;
}

/** 文中画像の件数と状態。★別のメッセージにせず、プレビューの中に載せる（LINE の通数を増やさない） */
function inlineBox(v: InlineImagesView | undefined): unknown[] {
  return inlinePreviewLines(v).map((r) => ({
    type: 'text', text: r.text, size: 'xs', color: r.warn ? COLOR.image : COLOR.sub, wrap: true,
  }));
}

/** 調べたかどうかと「要確認」の印。★別のメッセージにせず、プレビューの中に載せる（LINE の通数を増やさない） */
function researchBox(r: ResearchView | undefined): unknown[] {
  if (!r) return [];
  const rows: unknown[] = [
    { type: 'text', text: r.summary, size: 'xs', color: r.warn ? COLOR.image : COLOR.sub, wrap: true },
    ...r.notes.map((n) => ({ type: 'text', text: n, size: 'xs', color: COLOR.image, wrap: true })),
  ];
  if (r.flags.length) {
    rows.push({
      type: 'text',
      text: `要確認（調べた情報・ネタ・ナレッジに見当たらない語。公開前に確かめてください）`
        + (r.flagTotal > r.flags.length ? `・全${r.flagTotal}件` : ''),
      size: 'xs', color: COLOR.image, wrap: true, margin: 'sm',
    });
    for (const f of r.flags) {
      rows.push({ type: 'text', text: `・「${f.term}」 ${f.excerpt}`.slice(0, 120), size: 'xxs', color: COLOR.text, wrap: true });
    }
  }
  return rows;
}

/**
 * 見出しと画像位置を1つの階層リストにする。
 * h2 には番号を振る（全文表示の ■1 ■2 と一致させ、そのまま修正指示に使えるようにするため）。
 */
function structureLines(
  markdown: string, generatedShown?: readonly number[],
): Array<{ label: string; mark: string; kind: 'h2' | 'h3' | 'image' }> {
  const headings = parseHeadings(markdown);
  const images = parse(markdown);
  // AI 画像は、画像ができている番号だけ見せる（作れなかった番号は公開時に消えるため）。状態が無ければ全部
  const generated = parse(markdown, 'generated')
    .filter((p) => !generatedShown || generatedShown.includes(p.index));
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
  for (const p of generated) {
    // 写真の 🖼 と区別する（修正指示で「AI画像1を■3の下に」と言えるように番号も見せる）
    rows.push({ line: p.line, label: `AI画像${p.index}`, mark: '🎨', kind: 'image' });
  }
  return rows.sort((a, b) => a.line - b.line).map(({ label, mark, kind }) => ({ label, mark, kind }));
}

/** 本文冒頭（記法を落としたプレーンテキスト）。 */
function excerpt(markdown: string, max = 140): string {
  const plain = markdown
    .replace(/\[(?:AI)?画像\d+\]/g, '')
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
  const rows = structureLines(input.markdown, input.inlineImages?.created);

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
              + (input.hasEyecatch ? (input.thumbnailGenerated ? ' ・ サムネあり（AIが作成）' : ' ・ サムネあり') : ' ・ サムネなし')
              + (input.hashtags.length ? ' ・ ' + input.hashtags.slice(0, 3).map((h) => `#${h}`).join(' ') : ''),
            size: 'xs',
            color: COLOR.sub,
          },
          ...(input.thumbnailNote
            ? [{ type: 'text', text: input.thumbnailNote, size: 'xs', color: COLOR.image, wrap: true }]
            : []),
          ...researchBox(input.research),
          ...inlineBox(input.inlineImages),
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
          ...(input.research?.canRedo
            ? [{
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'postback', label: 'もう一度調べる', data: `action=research_redo&id=${input.articleId}`, displayText: 'もう一度調べる' },
            }]
            : []),
          ...(input.inlineImages?.canRegenerate && input.inlineImages.slots > 0
            ? [{
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'postback', label: '文中画像を作り直す', data: `action=inline_regen&id=${input.articleId}`, displayText: '文中画像を作り直す' },
            }]
            : []),
          ...(input.canRegenerateThumbnail
            ? [{
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'postback', label: 'サムネを作り直す', data: `action=thumb_regen&id=${input.articleId}`, displayText: 'サムネを作り直す' },
            }]
            : []),
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
