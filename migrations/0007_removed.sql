-- note 上から消された記事を、一覧に出さないようにする。
--
-- ★状態（state）とは別に持つ。
--   「公開した」という履歴は事実として残しつつ、
--   「いま note に無い」という事実を別の列で記録する。
--   state を書き換えると、公開済みからの修正フローが壊れる。
ALTER TABLE articles ADD COLUMN removed_at TEXT;

CREATE INDEX idx_articles_removed ON articles(tenant_id, removed_at);
