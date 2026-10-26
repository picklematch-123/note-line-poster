-- 画像のルール・参考画像（設計書 docs/design-image-rules-2026-10-26.md 3-1）。
-- ★追加だけ（D1 では tenants などの作り直しができないため。CLAUDE.md 参照）。
-- ★行が無い＝何も登録していない＝今までと同じ動き（検品もしない）。行ができたときの既定は「検品1回までやり直し」。

-- 種類（サムネ用 / 文中画像用）ごとのルール。本文は指示文づくりの入力にだけ使う（記事・公開物には出ない）
CREATE TABLE IF NOT EXISTS image_rules (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  kind             TEXT NOT NULL CHECK (kind IN ('thumbnail', 'inline')),
  body             TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 6000),
  title_mode       TEXT NOT NULL DEFAULT 'none' CHECK (title_mode IN ('none', 'title')),
  inspect_retries  INTEGER NOT NULL DEFAULT 1 CHECK (inspect_retries BETWEEN 0 AND 2),
  updated_by       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);

-- 参考画像（キャラクターの見た目など）。実体は画像の置き場（KV）。1環境 最大3枚・1枚 5MB 以下（アプリ側で検査）
CREATE TABLE IF NOT EXISTS image_refs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  role        TEXT NOT NULL DEFAULT 'character' CHECK (role IN ('character')),
  name        TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_refs_tenant ON image_refs(tenant_id, sort);
