/**
 * D1 アクセス層。
 *
 * Phase 1 は単一テナントだが、全クエリに tenant_id を通しておく。
 * Phase 2 でマルチテナント化するとき、ここを触らずに済むようにするため。
 */
import { newId } from '../../lib/id';
import { nowIso, jstDate } from '../../lib/time';
import { assertTransition, type ArticleState } from '../../core/article/state';

export const DEFAULT_TENANT_ID = 'tenant_default';

/**
 * 新しく作られるテナントの表示名。
 * ★1顧客 = 1環境で配る前提なので、ここに特定の人の名前を入れない。
 */
export const DEFAULT_TENANT_NAME = 'オーナー';

export interface TenantRow {
  id: string;
  status: string;
  publish_enabled: number;
  tos_accepted_at: string | null;
  daily_post_limit: number;
  min_interval_sec: number;
  /** server = サーバーが note を叩く / agent = 顧客のブラウザ拡張が叩く */
  execution_mode: 'server' | 'agent';
  /** 拡張が居ないときにサーバーで代行してよいか（既定は不可） */
  agent_fallback: number;
}

export interface ArticleRow {
  id: string;
  tenant_id: string;
  state: ArticleState;
  source_text: string;
  keywords_json: string | null;
  outline_json: string | null;
  title: string | null;
  body_md: string | null;
  body_html: string | null;
  meta_description: string | null;
  hashtags_json: string | null;
  image_alts_json: string | null;
  note_id: string | null;
  note_key: string | null;
  note_url: string | null;
  error_code: string | null;
  error_message: string | null;
  llm_input_tokens: number;
  llm_output_tokens: number;
  revision_instruction: string | null;
  revision_count: number;
  approved_at: string | null;
  approved_by: string | null;
  published_at: string | null;
  /** note 上から消えたと分かった時刻。入っていれば一覧に出さない */
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImageRow {
  id: string;
  article_id: string | null;
  slot_index: number | null;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  alt_text: string | null;
  note_image_url: string | null;
  line_message_id: string | null;
  is_eyecatch: number;
}

export class Db {
  constructor(private readonly d1: D1Database) {}

  /** 生の D1。ここを直接使うのは core/agent など、専用のクエリを持つ場所だけにする。 */
  get raw(): D1Database {
    return this.d1;
  }

  // ── テナント ─────────────────────────────────────────
  async ensureTenant(id = DEFAULT_TENANT_ID): Promise<TenantRow> {
    const found = await this.d1
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(id)
      .first<TenantRow>();
    if (found) return found;

    const now = nowIso();
    await this.d1
      // ★execution_mode は必ず明示して入れる（省略してはいけない）。
      //   「サーバーから投稿」＝パソコンを開いていなくても投稿できる。
      //   顧客ごとに別の Cloudflare アカウントで動かす前提なので、
      //   ここでいう「サーバー」は顧客自身のサーバーを指す。
      //
      //   ★テーブル側の既定値は 0006 の 'agent' のまま残っている。直せない。
      //     SQLite は列の既定値だけを変えられずテーブルの作り直しが要るが、
      //     D1 は tenants を参照している子テーブルに行があると作り直しを拒否する
      //     （2026-08-29 実測。defer_foreign_keys / foreign_keys=OFF でも同じ）。
      //     つまり、ここで省略した瞬間その環境は agent で始まり、顧客は
      //     「Chrome を開かないと投稿されない」状態になる。
      //     test/unit/schema.test.ts が明示漏れを検査している。
      .prepare(`INSERT INTO tenants (id, name, plan, status, execution_mode, tos_version, tos_accepted_at, created_at, updated_at)
                VALUES (?, ?, 'trial', 'active', 'server', 'phase1', ?, ?, ?)`)
      // ★name は D1 を直接覗いたときの目印にしか使っていない（アプリは読まない）。
      //   顧客ごとに別環境で動く配布物なので、特定の人の名前を入れない。
      .bind(id, DEFAULT_TENANT_NAME, now, now, now)
      .run();
    return (await this.d1.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<TenantRow>())!;
  }

  /** テナント設定を読む（無ければ作る）。 */
  async getTenant(id = DEFAULT_TENANT_ID): Promise<TenantRow> {
    return this.ensureTenant(id);
  }

  /**
   * 投稿まわりの設定を変える。
   * ★レート制限は API 費用ではなく note アカウントを守るためのもの。
   *   0 を入れると無制限になる。誰が何に変えたかは監査に残す。
   */
  async updateTenantSettings(
    tenantId: string,
    patch: Partial<Pick<TenantRow, 'daily_post_limit' | 'min_interval_sec' | 'execution_mode' | 'agent_fallback'>>,
    actor: string,
  ): Promise<TenantRow> {
    const allowed = ['daily_post_limit', 'min_interval_sec', 'execution_mode', 'agent_fallback'] as const;
    const fields = allowed.filter((k) => patch[k] !== undefined);
    if (fields.length === 0) return this.getTenant(tenantId);

    await this.d1
      .prepare(`UPDATE tenants SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...fields.map((f) => patch[f] as string | number), nowIso(), tenantId)
      .run();
    await this.audit(tenantId, 'tenant.settings', actor, null, 'ok', patch);
    return this.getTenant(tenantId);
  }

  // ── オーナー（承認できる唯一の LINE ユーザー）─────────
  /**
   * 最初にメッセージを送ってきた人をオーナーとして登録する。
   * ユーザーIDを手で転記させないための仕組み。
   * ★一度登録したら上書きしない（後から来た他人がオーナーを奪えないようにする）。
   */
  async resolveOwnerLineUserId(tenantId: string, candidate: string): Promise<{ ownerId: string; justRegistered: boolean }> {
    const row = await this.d1
      .prepare('SELECT owner_line_user_id FROM line_channels WHERE tenant_id = ? LIMIT 1')
      .bind(tenantId)
      .first<{ owner_line_user_id: string | null }>();

    if (row?.owner_line_user_id) {
      return { ownerId: row.owner_line_user_id, justRegistered: false };
    }

    const now = nowIso();
    if (row) {
      await this.d1
        .prepare('UPDATE line_channels SET owner_line_user_id = ? WHERE tenant_id = ?')
        .bind(candidate, tenantId)
        .run();
    } else {
      await this.d1
        .prepare(`INSERT INTO line_channels (id, tenant_id, webhook_path_token, owner_line_user_id, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .bind(newId(), tenantId, newId(), candidate, now)
        .run();
    }
    await this.audit(tenantId, 'owner.registered', `line:${candidate}`, null, 'ok');
    return { ownerId: candidate, justRegistered: true };
  }

  /**
   * 持ち主の登録を消す。次に話しかけた人が新しい持ち主になる。
   *
   * ★誤って別の人が持ち主になったとき、これが無いと D1 を直接いじるしかなかった
   *   （2026-08-31 源蔵レビューの指摘）。
   * ★env に LINE_OWNER_USER_ID が入っている場合は、そちらが優先されるので効かない。
   *   呼び出し側で先に確かめること。
   */
  async clearOwnerLineUserId(tenantId: string, actor: string): Promise<boolean> {
    const res = await this.d1
      .prepare(`UPDATE line_channels SET owner_line_user_id = NULL
                 WHERE tenant_id = ? AND owner_line_user_id IS NOT NULL`)
      .bind(tenantId)
      .run();

    const cleared = (res.meta?.changes ?? 0) > 0;
    if (cleared) await this.audit(tenantId, 'owner.cleared', actor, null, 'ok');
    return cleared;
  }

  /** 登録済みのオーナーを読む（未登録なら null）。 */
  async getOwnerLineUserId(tenantId: string): Promise<string | null> {
    const row = await this.d1
      .prepare('SELECT owner_line_user_id FROM line_channels WHERE tenant_id = ? LIMIT 1')
      .bind(tenantId)
      .first<{ owner_line_user_id: string | null }>();
    return row?.owner_line_user_id ?? null;
  }

  // ── 記事 ─────────────────────────────────────────────
  async createArticle(tenantId: string, sourceText: string): Promise<ArticleRow> {
    const id = newId();
    const now = nowIso();
    await this.d1
      .prepare(`INSERT INTO articles (id, tenant_id, state, source_text, created_at, updated_at)
                VALUES (?, ?, 'received', ?, ?, ?)`)
      .bind(id, tenantId, sourceText, now, now)
      .run();
    await this.logEvent(id, null, 'received', 'system');
    return (await this.getArticle(id))!;
  }

  async getArticle(id: string): Promise<ArticleRow | null> {
    return this.d1.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first<ArticleRow>();
  }

  /**
   * 本人の判断を待っている記事を1件返す。
   * ★これがある間は新しい記事を作らせない（誤って別記事が生まれるのを防ぐ）。
   */
  async findArticleAwaitingDecision(tenantId: string): Promise<ArticleRow | null> {
    return this.d1
      .prepare(`SELECT * FROM articles
                WHERE tenant_id = ? AND state IN
                  ('received','generating','preview_ready','awaiting_approval','editing','failed')
                ORDER BY created_at DESC LIMIT 1`)
      .bind(tenantId)
      .first<ArticleRow>();
  }

  /** 何らかの続きがある記事（投稿待ち・連携切れも含む）。 */
  async findActiveArticle(tenantId: string): Promise<ArticleRow | null> {
    return this.d1
      .prepare(`SELECT * FROM articles
                WHERE tenant_id = ? AND state IN
                  ('received','generating','preview_ready','awaiting_approval','editing','blocked','awaiting_session','failed')
                ORDER BY created_at DESC LIMIT 1`)
      .bind(tenantId)
      .first<ArticleRow>();
  }

  /** 直近の記事を一覧する（LINE で連番指定して呼び出すため）。 */
  /**
   * 一覧に出す記事。
   *
   * ★「もう無いもの」は出さない:
   *   ・取りやめた（cancelled）・期限切れ（expired）・失敗した（failed）
   *     → note には1本も上がっていない
   *   ・note の画面から消された（removed_at）
   *     → 記録は残っているが、開いても 404 になる
   *   作りかけ（確認待ち・修正中など）は生きているので残す。
   */
  async listRecentArticles(tenantId: string, limit = 10): Promise<ArticleRow[]> {
    const r = await this.d1
      .prepare(`SELECT * FROM articles
                WHERE tenant_id = ?
                  AND state NOT IN ('cancelled', 'expired', 'failed')
                  AND removed_at IS NULL
                ORDER BY created_at DESC LIMIT ?`)
      .bind(tenantId, limit)
      .all<ArticleRow>();
    return r.results ?? [];
  }

  /** 公開済みとして記録している記事の note キー（実態との突き合わせに使う）。 */
  async listPublishedNoteKeys(tenantId: string): Promise<Array<{ id: string; note_key: string | null }>> {
    const r = await this.d1
      .prepare(`SELECT id, note_key FROM articles
                 WHERE tenant_id = ? AND state = 'published'
                   AND note_key IS NOT NULL AND removed_at IS NULL`)
      .bind(tenantId)
      .all<{ id: string; note_key: string | null }>();
    return r.results ?? [];
  }

  /**
   * note 上から消えた記事に印を付ける。
   * ★state は変えない。「公開した」という履歴は事実として残す。
   */
  async markRemovedFromNote(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = nowIso();
    await this.d1.batch(
      ids.map((id) => this.d1
        .prepare('UPDATE articles SET removed_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, id)),
    );
  }

  async updateArticle(id: string, patch: Partial<ArticleRow>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    await this.d1
      .prepare(`UPDATE articles SET ${sets}, updated_at = ? WHERE id = ?`)
      .bind(...values, nowIso(), id)
      .run();
  }

  /**
   * 状態遷移を記録つきで行う。
   * ★遷移表で必ず検証する。不正な遷移はここで例外にして、壊れた状態を保存させない。
   *   （検証を呼び出し側任せにしていたため、不正な状態が保存されて後段で失敗する
   *     バグが起きた。2026-08-28 修正）
   */
  async setState(id: string, from: ArticleState | null, to: ArticleState, actor: string, detail?: unknown): Promise<void> {
    if (from) assertTransition(from, to);
    await this.updateArticle(id, { state: to });
    await this.logEvent(id, from, to, actor, detail);
  }

  /**
   * 失敗として記録する。現在の状態がどこであっても落とす。
   * ★エラー処理専用。遷移表の検証を意図的に迂回するのはここだけ。
   *   （正常系で使わないこと）
   */
  async markFailed(id: string, actor: string, detail?: unknown): Promise<void> {
    const current = await this.getArticle(id);
    await this.updateArticle(id, { state: 'failed' });
    await this.logEvent(id, current?.state ?? null, 'failed', actor, detail);
  }

  async logEvent(articleId: string, from: ArticleState | null, to: ArticleState, actor: string, detail?: unknown): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO article_events (id, article_id, from_state, to_state, actor, detail_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), articleId, from, to, actor, detail ? JSON.stringify(detail) : null, nowIso())
      .run();
  }

  // ── 画像 ─────────────────────────────────────────────
  async addImage(tenantId: string, row: {
    articleId: string | null; r2Key: string; mimeType: string; sizeBytes: number; lineMessageId: string;
  }): Promise<void> {
    await this.d1
      .prepare(`INSERT OR IGNORE INTO images
                (id, tenant_id, article_id, r2_key, mime_type, size_bytes, line_message_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), tenantId, row.articleId, row.r2Key, row.mimeType, row.sizeBytes, row.lineMessageId, nowIso())
      .run();
  }

  /** 本文に差し込む画像（サムネは含まない）。 */
  async listImages(articleId: string): Promise<ImageRow[]> {
    const r = await this.d1
      .prepare('SELECT * FROM images WHERE article_id = ? AND is_eyecatch = 0 ORDER BY created_at ASC')
      .bind(articleId)
      .all<ImageRow>();
    return r.results ?? [];
  }

  /** サムネイル（見出し画像）。1記事に1枚。 */
  async getEyecatch(articleId: string): Promise<ImageRow | null> {
    return this.d1
      .prepare('SELECT * FROM images WHERE article_id = ? AND is_eyecatch = 1 ORDER BY created_at DESC LIMIT 1')
      .bind(articleId)
      .first<ImageRow>();
  }

  /** すべての画像（サムネ含む）。受信順の通し番号を出すときに使う。 */
  async listAllImages(articleId: string): Promise<ImageRow[]> {
    const r = await this.d1
      .prepare('SELECT * FROM images WHERE article_id = ? ORDER BY created_at ASC')
      .bind(articleId)
      .all<ImageRow>();
    return r.results ?? [];
  }

  /**
   * 指定した画像をサムネイルにする。ほかのサムネ指定は外す（1記事1枚）。
   * @returns 見つからなければ false
   */
  async setEyecatch(articleId: string, imageId: string): Promise<boolean> {
    const target = await this.d1
      .prepare('SELECT id FROM images WHERE id = ? AND article_id = ?')
      .bind(imageId, articleId)
      .first<{ id: string }>();
    if (!target) return false;
    await this.d1.prepare('UPDATE images SET is_eyecatch = 0 WHERE article_id = ?').bind(articleId).run();
    await this.d1.prepare('UPDATE images SET is_eyecatch = 1 WHERE id = ?').bind(imageId).run();
    return true;
  }

  async clearEyecatch(articleId: string): Promise<void> {
    await this.d1.prepare('UPDATE images SET is_eyecatch = 0 WHERE article_id = ?').bind(articleId).run();
  }

  async setImageNoteUrl(id: string, url: string, slotIndex: number): Promise<void> {
    await this.d1
      .prepare('UPDATE images SET note_image_url = ?, slot_index = ? WHERE id = ?')
      .bind(url, slotIndex, id)
      .run();
  }

  // ── ポリシー判定に必要な数値 ─────────────────────────
  async todayPublishCount(tenantId: string): Promise<number> {
    const r = await this.d1
      .prepare('SELECT COUNT(*) AS c FROM publish_log WHERE tenant_id = ? AND jst_date = ?')
      .bind(tenantId, jstDate())
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async lastPublishedAt(tenantId: string): Promise<string | null> {
    const r = await this.d1
      .prepare('SELECT published_at FROM publish_log WHERE tenant_id = ? ORDER BY published_at DESC LIMIT 1')
      .bind(tenantId)
      .first<{ published_at: string }>();
    return r?.published_at ?? null;
  }

  async globalRecentCount(seconds = 60): Promise<number> {
    const since = new Date(Date.now() - seconds * 1000).toISOString();
    const r = await this.d1
      .prepare('SELECT COUNT(*) AS c FROM publish_log WHERE published_at >= ?')
      .bind(since)
      .first<{ c: number }>();
    return r?.c ?? 0;
  }

  async recordPublish(tenantId: string, articleId: string): Promise<void> {
    const now = nowIso();
    await this.d1
      .prepare('INSERT INTO publish_log (id, tenant_id, article_id, published_at, jst_date) VALUES (?, ?, ?, ?, ?)')
      .bind(newId(), tenantId, articleId, now, jstDate())
      .run();
  }

  // ── 緊急停止フラグ ───────────────────────────────────
  async getFlag(key: string): Promise<boolean> {
    const r = await this.d1
      .prepare('SELECT value FROM system_flags WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return r?.value === '1';
  }

  /** 数値の設定値を読む（system_flags を流用）。未設定なら既定値。 */
  async getNumberFlag(key: string, fallback: number): Promise<number> {
    const r = await this.d1
      .prepare('SELECT value FROM system_flags WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    if (!r) return fallback;
    const n = Number(r.value);
    return Number.isFinite(n) ? n : fallback;
  }

  async setNumberFlag(key: string, value: number, reason: string, by: string): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO system_flags (key, value, reason, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, reason=excluded.reason,
                  updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(key, String(value), reason, by, nowIso())
      .run();
    await this.audit(null, 'flag.set', by, key, 'ok', { value, reason });
  }

  async setFlag(key: string, on: boolean, reason: string, by: string): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO system_flags (key, value, reason, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, reason=excluded.reason,
                  updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(key, on ? '1' : '0', reason, by, nowIso())
      .run();
    await this.audit(null, 'killswitch.toggle', by, key, 'ok', { on, reason });
  }

  // ── 監査ログ（★秘密情報を入れないこと）───────────────
  async audit(tenantId: string | null, action: string, actor: string, target: string | null, result: string, detail?: unknown): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO audit_logs (id, tenant_id, action, actor, target, result, detail_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), tenantId, action, actor, target, result, detail ? JSON.stringify(detail) : null, nowIso())
      .run();
  }

  // ── 事業コンテキスト（その人が何者か。記事の中身を決める）─────
  async getActiveContext(tenantId: string): Promise<{ id: string; raw_text: string; prompt_snippet: string | null } | null> {
    return this.d1
      .prepare('SELECT id, raw_text, prompt_snippet FROM tenant_context WHERE tenant_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1')
      .bind(tenantId)
      .first<{ id: string; raw_text: string; prompt_snippet: string | null }>();
  }

  async saveContext(tenantId: string, rawText: string, structured: unknown, promptSnippet: string): Promise<string> {
    const id = newId();
    const now = nowIso();
    // 過去のものは残すが無効化する（履歴として追える）
    await this.d1.prepare('UPDATE tenant_context SET is_active = 0 WHERE tenant_id = ?').bind(tenantId).run();
    await this.d1
      .prepare(`INSERT INTO tenant_context
                (id, tenant_id, raw_text, structured_json, prompt_snippet, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, tenantId, rawText, JSON.stringify(structured), promptSnippet, now, now)
      .run();
    await this.audit(tenantId, 'context.saved', 'line', null, 'ok');
    return id;
  }

  /** 既存のコンテキストに書き足す。上書きではなく積み増していく。 */
  async appendContextText(tenantId: string, addition: string): Promise<string> {
    const current = await this.getActiveContext(tenantId);
    return current ? `${current.raw_text}\n\n${addition}` : addition;
  }

  async clearContext(tenantId: string): Promise<void> {
    await this.d1.prepare('UPDATE tenant_context SET is_active = 0 WHERE tenant_id = ?').bind(tenantId).run();
    await this.audit(tenantId, 'context.cleared', 'line', null, 'ok');
  }

  // ── スタイルプロファイル（ナレッジ機能）───────────────
  async getActiveStyleProfile(tenantId: string): Promise<{ id: string; prompt_snippet: string | null } | null> {
    return this.d1
      .prepare('SELECT id, prompt_snippet FROM style_profiles WHERE tenant_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1')
      .bind(tenantId)
      .first<{ id: string; prompt_snippet: string | null }>();
  }

  async saveStyleProfile(tenantId: string, profileJson: unknown, promptSnippet: string, sampleCount: number): Promise<string> {
    const id = newId();
    const now = nowIso();
    await this.d1.prepare('UPDATE style_profiles SET is_active = 0 WHERE tenant_id = ?').bind(tenantId).run();
    await this.d1
      .prepare(`INSERT INTO style_profiles
                (id, tenant_id, name, profile_json, prompt_snippet, sample_count, analyzed_at, is_active, created_at, updated_at)
                VALUES (?, ?, 'default', ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, tenantId, JSON.stringify(profileJson), promptSnippet, sampleCount, now, now, now)
      .run();
    return id;
  }

  async addKnowledgeSource(tenantId: string, row: {
    kind: string; sourceUrl: string | null; title: string | null; content: string;
  }): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO knowledge_sources
                (id, tenant_id, kind, source_url, title, content, char_count, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(newId(), tenantId, row.kind, row.sourceUrl, row.title, row.content, row.content.length, nowIso())
      .run();
  }

  async listPendingKnowledge(tenantId: string): Promise<Array<{ id: string; content: string }>> {
    const r = await this.d1
      .prepare("SELECT id, content FROM knowledge_sources WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 20")
      .bind(tenantId)
      .all<{ id: string; content: string }>();
    return r.results ?? [];
  }

  async markKnowledgeAnalyzed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.d1
      .prepare(`UPDATE knowledge_sources SET status = 'analyzed' WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
  }
}
