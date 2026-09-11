-- note-line-poster 初期スキーマ
-- Phase 1 は単一テナントだが、Phase 2 のマルチテナント化を見越して
-- 最初から tenant_id を全テーブルに持たせる（後付けは高コストなため）

-- ========== テナント ==========
CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT,
  plan              TEXT NOT NULL DEFAULT 'trial',   -- trial|standard|pro
  status            TEXT NOT NULL DEFAULT 'active',  -- active|suspended|deleted
  publish_enabled   INTEGER NOT NULL DEFAULT 1,      -- テナント単位の投稿停止
  daily_post_limit  INTEGER NOT NULL DEFAULT 3,      -- 1日あたりの投稿上限
  min_interval_sec  INTEGER NOT NULL DEFAULT 1800,   -- 連投防止の最小間隔（30分）
  tos_version       TEXT,
  tos_accepted_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ========== LINE チャネル（BYO-Account: 顧客ごとに1つ）==========
CREATE TABLE line_channels (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  channel_id          TEXT,
  secret_ref          TEXT,                 -- tenant_secrets.id（チャネルシークレット）
  access_token_ref    TEXT,                 -- tenant_secrets.id（長期アクセストークン）
  webhook_path_token  TEXT NOT NULL UNIQUE, -- /line/webhook/{token} でテナントを識別
  owner_line_user_id  TEXT,                 -- ★承認できる唯一の userId
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_line_channels_tenant ON line_channels(tenant_id);

-- ========== note セッション ==========
CREATE TABLE note_sessions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  note_urlname      TEXT,
  cookies_ref       TEXT NOT NULL,          -- tenant_secrets.id（Cookie一式）
  user_agent        TEXT NOT NULL,          -- 取得時のUAを固定（Cookieとセットで使う）
  status            TEXT NOT NULL DEFAULT 'active',  -- active|expiring|expired
  last_verified_at  TEXT,
  expires_at        TEXT,
  notified_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_note_sessions_tenant ON note_sessions(tenant_id);

-- ========== 暗号化シークレット ==========
CREATE TABLE tenant_secrets (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  kind         TEXT NOT NULL,   -- anthropic_api_key|line_channel_secret
                                -- |line_access_token|note_cookies
  ciphertext   BLOB NOT NULL,
  iv           BLOB NOT NULL,
  wrapped_dek  BLOB NOT NULL,
  dek_iv       BLOB NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  last_4       TEXT,            -- 表示用（キー確認UI）。本体は復号しないと読めない
  created_at   TEXT NOT NULL,
  rotated_at   TEXT
);
CREATE INDEX idx_secrets_tenant_kind ON tenant_secrets(tenant_id, kind);

-- ========== スタイルプロファイル（文体・思考プロセスのナレッジ）==========
-- 過去記事・YouTube文字起こし等から抽出した「その人らしさ」を保持する
CREATE TABLE style_profiles (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL DEFAULT 'default',
  -- Claude が分析した構造化プロファイル（JSON）
  -- { tone, vocabulary[], sentenceRhythm, structurePatterns[],
  --   openingPatterns[], closingPatterns[], thinkingStyle, avoidList[] }
  profile_json    TEXT,
  -- 生成時にそのままプロンプトへ差し込む要約（トークン節約のため事前生成）
  prompt_snippet  TEXT,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  analyzed_at     TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_style_profiles_tenant ON style_profiles(tenant_id, is_active);

-- ========== ナレッジ素材（プロファイルの元ネタ）==========
CREATE TABLE knowledge_sources (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  profile_id   TEXT REFERENCES style_profiles(id),
  kind         TEXT NOT NULL,   -- note_article|blog_url|youtube|text
  source_url   TEXT,
  title        TEXT,
  content      TEXT NOT NULL,   -- 取得した本文/文字起こし
  char_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|analyzed|failed
  error_message TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_knowledge_tenant ON knowledge_sources(tenant_id, status);

-- ========== 記事 ==========
CREATE TABLE articles (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  state             TEXT NOT NULL,
  source_text       TEXT NOT NULL,     -- LINEで投げられたネタ原文
  keywords_json     TEXT,
  outline_json      TEXT,
  style_profile_id  TEXT REFERENCES style_profiles(id),
  title             TEXT,
  body_md           TEXT,              -- [画像N] プレースホルダ入り
  body_html         TEXT,              -- note へ送る直前のHTML（note から読み戻せないため必須）
  meta_description  TEXT,
  hashtags_json     TEXT,
  note_id           TEXT,              -- note の数値ID
  note_key          TEXT,              -- URL の n/xxxx 部分
  note_url          TEXT,
  error_code        TEXT,
  error_message     TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens  INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens INTEGER NOT NULL DEFAULT 0,
  approved_at       TEXT,
  approved_by       TEXT,              -- LINE userId
  published_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_articles_tenant_state ON articles(tenant_id, state);
CREATE INDEX idx_articles_tenant_created ON articles(tenant_id, created_at);

-- ========== 画像 ==========
CREATE TABLE images (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  article_id      TEXT REFERENCES articles(id),
  slot_index      INTEGER,            -- [画像1] の 1
  r2_key          TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  caption         TEXT,
  alt_text        TEXT,
  note_image_url  TEXT,               -- note へアップ後のURL
  line_message_id TEXT,               -- 冪等性キー（Webhook 再送対策）
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_images_article ON images(article_id, slot_index);
CREATE UNIQUE INDEX idx_images_line_msg ON images(tenant_id, line_message_id);

-- ========== 状態遷移の監査 ==========
CREATE TABLE article_events (
  id          TEXT PRIMARY KEY,
  article_id  TEXT NOT NULL REFERENCES articles(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT NOT NULL,   -- system|line:{userId}|mcp|rest|cron
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_article_events ON article_events(article_id, created_at);

-- ========== 監査ログ ==========
-- ★detail_json に秘密情報を入れないこと
CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  target      TEXT,
  result      TEXT NOT NULL,   -- ok|denied|error
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at);

-- ========== 投稿レート制限の記録 ==========
CREATE TABLE publish_log (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  article_id    TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  jst_date      TEXT NOT NULL    -- 'YYYY-MM-DD'（日次上限のカウント用）
);
CREATE INDEX idx_publish_log_tenant_date ON publish_log(tenant_id, jst_date);

-- ========== システムフラグ（緊急停止）==========
CREATE TABLE system_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  reason     TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO system_flags (key, value, reason, updated_by, updated_at) VALUES
  ('publish_enabled', '1', '初期値', 'system', datetime('now')),
  ('signup_enabled',  '1', '初期値', 'system', datetime('now'));
