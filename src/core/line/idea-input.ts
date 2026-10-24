/** LINE に送られたネタを、利用者が見る1文字（書記素）単位で数える。 */
export function countIdeaGraphemes(text: string): number {
  return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].length;
}

export const MIN_IDEA_GRAPHEMES = 3;
export const MAX_IDEA_GRAPHEMES = 500;

export function validateIdeaLength(text: string): { valid: boolean; count: number } {
  const count = countIdeaGraphemes(text);
  return {
    valid: count >= MIN_IDEA_GRAPHEMES && count <= MAX_IDEA_GRAPHEMES,
    count,
  };
}
