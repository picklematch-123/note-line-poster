-- 事業コンテキスト（その人が何者か）。
-- style_profiles は「どう書くか（文体・思考の癖）」、こちらは「何者か（事業の前提）」。
-- 記事の中身そのものを変えるのはこちら。
CREATE TABLE tenant_context (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  -- 本人が書いた原文（これを正とする。勝手に書き換えない）
  raw_text        TEXT NOT NULL,
  -- Claude が構造化したもの（業種・商品・客層・強み・NG など）
  structured_json TEXT,
  -- 生成時にプロンプトへ差し込む要約
  prompt_snippet  TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_tenant_context ON tenant_context(tenant_id, is_active);
