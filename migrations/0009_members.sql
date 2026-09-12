-- ========== 投稿者（持ち主以外で、記事を作って公開できる人）==========
-- ★持ち主（line_channels.owner_line_user_id）は1人のまま。
--   ここに入るのは「投稿作業を任せる人」。note 連携・投稿設定・持ち主の変更などは
--   引き続き持ち主だけが行う（アプリ側で判定する）。
CREATE TABLE line_members (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  line_user_id  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  display_name  TEXT,                 -- 持ち主に「誰を登録したか」を見せるためだけに使う
  added_by      TEXT,                 -- 追加を許可した持ち主の userId
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, line_user_id)
);

-- ========== 記事ごとの「いま手を動かしている人」==========
-- ★これが無いと、2人で使ったときに入力が混ざる。
--   A さんの記事が確認待ちの間に B さんが送った文章が、A さんの記事への修正指示として扱われていた。
--   NULL は「この仕組みを入れる前に作られた記事」＝持ち主のものとして扱う（アプリ側）。
ALTER TABLE articles ADD COLUMN requested_by TEXT;
CREATE INDEX idx_articles_requested_by ON articles(tenant_id, requested_by);
