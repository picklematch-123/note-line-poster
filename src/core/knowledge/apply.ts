/**
 * 整理したナレッジを反映する。
 *
 * ★整理には数分かかることがある。その間に本人が書き足したり消したりすると、
 *   「古い内容を整理した結果」で「新しい内容」を上書きしてしまう。
 *   → 整理を始めたときに保存した行が、**いまも有効な行のままか**を確かめてから反映する。
 *   違っていたら何もしない（新しい内容の整理が、あとから反映される）。
 */
import type { Db } from '../../ports/storage/db';
import type { KnowledgeDigest } from '../generation/schema';
import { buildContextSnippet } from '../generation/context';

export async function applyKnowledgeDigest(
  db: Db, tenantId: string, contextId: string, data: KnowledgeDigest,
): Promise<'applied' | 'stale'> {
  const current = await db.getActiveContext(tenantId);
  if (!current || current.id !== contextId) return 'stale';
  // ★要約（LLM）だけに頼らない。原文の指示とURLを機械的に付け直す
  await db.saveContext(tenantId, current.raw_text, data, buildContextSnippet(current.raw_text, data));
  return 'applied';
}
