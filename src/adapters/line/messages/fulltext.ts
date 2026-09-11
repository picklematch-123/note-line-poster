/**
 * 記事の全文を LINE のテキストメッセージとして送る。
 *
 * ★note やブラウザに遷移させず、LINE 内で完結させるための機能。
 *   見出しに番号を振るので、そのまま「3番目の見出しの下に」と指示できる。
 *
 * LINE のテキストは1通5,000字まで、1回の送信で5通まで。
 * 承認ボタンからの postback に対する Reply で返せば課金されない。
 */
import type { LineMessage } from '../client';
import { text } from '../client';

/** 安全側に倒した1通あたりの上限。 */
const CHUNK_LIMIT = 4600;
/** 1回に送れる通数。 */
const MAX_MESSAGES = 5;

/**
 * Markdown を LINE で読みやすい形に整える。
 * - `## 見出し` → `■1 見出し`（番号は修正指示に使う）
 * - `### 小見出し` → `　└ 小見出し`
 * - `- 項目` → `・項目`
 * - `**強調**` → `強調`（LINE に太字が無いため記号を落とす）
 */
export function toLineText(markdown: string): string {
  let h2 = 0;
  return markdown
    .split('\n')
    .map((line) => {
      const m2 = /^##\s+(.+)$/.exec(line);
      if (m2) { h2++; return `\n■${h2} ${m2[1]}`; }

      const m3 = /^###\s+(.+)$/.exec(line);
      if (m3) return `\n　└ ${m3[1]}`;

      const li = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (li) return `・${clean(li[1])}`;

      const ol = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
      if (ol) return `${ol[1]}. ${clean(ol[2])}`;

      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) return `｜${clean(q[1])}`;

      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return '────────';

      return clean(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clean(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）');
}

/** 長い本文を、段落の切れ目で分割する。 */
export function chunk(body: string, limit = CHUNK_LIMIT): string[] {
  if (body.length <= limit) return [body];

  const out: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    // 段落 → 行 の順に、なるべく自然な位置で切る
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface FullTextInput {
  articleId: string;
  title: string;
  markdown: string;
  metaDescription: string;
  hashtags: string[];
  imageCount: number;
}

/** 全文メッセージ一式を組み立てる。 */
export function buildFullText(input: FullTextInput): LineMessage[] {
  const body = toLineText(input.markdown);
  const parts = chunk(body);

  const messages: LineMessage[] = [];

  // 1通目にタイトルを付ける
  messages.push(text(`【タイトル】\n${input.title}\n\n────────\n${parts[0]}`));

  for (let i = 1; i < parts.length && messages.length < MAX_MESSAGES - 1; i++) {
    messages.push(text(`（つづき ${i + 1}/${parts.length}）\n\n${parts[i]}`));
  }

  // 最後に、指示の出し方と操作ボタンを添える
  const hints: string[] = [];
  if (input.imageCount > 0) {
    hints.push(`・画像${input.imageCount === 1 ? '1' : '2'}を■3の下に移して`);
    if (input.imageCount >= 2) hints.push('・画像1と画像2を入れ替えて');
  }
  hints.push('・■2をもっと具体的に書き直して');
  hints.push('・タイトルを別の案にして');

  messages.push({
    type: 'text',
    text:
      `【この記事について】\n` +
      `${input.metaDescription}\n\n` +
      (input.hashtags.length ? `タグ: ${input.hashtags.map((h) => `#${h}`).join(' ')}\n\n` : '') +
      `修正したいときは、そのまま文章で送ってください。\n${hints.join('\n')}`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'postback', label: '公開する', data: `action=publish&id=${input.articleId}`, displayText: '公開する' },
        },
        {
          type: 'action',
          action: { type: 'postback', label: 'やめる', data: `action=cancel&id=${input.articleId}`, displayText: 'やめる' },
        },
      ],
    },
  });

  return messages;
}
