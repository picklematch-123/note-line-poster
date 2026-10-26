/**
 * /health が照合する「コードが依存している表と列」。
 *
 * ★マイグレーションを流し忘れてデプロイすると、顧客が操作した瞬間に「no such column」で落ちる。
 *   それを先に見つけるための一覧。列やテーブルを増やしたらここにも足す。
 * ★src/index.ts の中に直接書いていたものを、テストで「全マイグレーションを流すと揃う」ことを
 *   確かめられるように切り出した（2026-10-26 画像のルール 0014）。
 */
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  articles: ['revision_instruction', 'revision_count', 'image_alts_json', 'note_id', 'note_key', 'removed_at', 'requested_by', 'research_json', 'ai_images_confirmed_at'],
  images: ['is_eyecatch', 'slot_index', 'note_image_url', 'source', 'gen_prompt', 'gen_slot', 'gen_heading'],
  tenant_context: ['prompt_snippet'],
  style_profiles: ['prompt_snippet'],
  note_sessions: ['cookies_ref', 'user_agent', 'status'],
  tenants: ['execution_mode', 'agent_fallback', 'daily_post_limit', 'min_interval_sec'],
  agent_devices: ['token_hash', 'last_seen_at', 'revoked_at'],
  agent_jobs: ['plan_json', 'state', 'lease_until'],
  tenant_secrets: ['ciphertext', 'iv', 'wrapped_dek', 'dek_iv', 'key_version'],
  line_members: ['line_user_id', 'role', 'display_name'],
  // 0014 画像のルール・参考画像
  image_rules: ['tenant_id', 'kind', 'body', 'title_mode', 'inspect_retries', 'updated_by', 'updated_at'],
  image_refs: ['id', 'tenant_id', 'role', 'name', 'r2_key', 'mime', 'size_bytes', 'sort', 'created_at'],
};
