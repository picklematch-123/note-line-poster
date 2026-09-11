-- 投稿の実行主体を「サーバー」から「顧客のブラウザ（拡張機能）」へ移せるようにする。
--
-- ★狙い: note から見たアクセス元を顧客本人の IP・本人のブラウザにすること。
--   全員が Cloudflare の同じ出口から叩いていると、1件のスパム判定で
--   全顧客が同時に止まる。実行主体を分ければ、影響は1顧客に閉じる。
--   同時に、agent モードでは Cookie を預からなくて済むようになる。

-- 実行方式: server = サーバーが note を叩く（最初の環境・逃げ道）
--           agent  = 顧客のブラウザ拡張が叩く（Cookie を預からない）
ALTER TABLE tenants ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'agent';

-- 拡張が居ないときにサーバーで代行してよいか（既定は不可）。
-- 代行を許すと「全顧客同時死」のリスクが戻るので、明示的に選ばせる。
ALTER TABLE tenants ADD COLUMN agent_fallback INTEGER NOT NULL DEFAULT 0;

-- ★既存のテナント（最初の環境）は今の動きを変えない。
--   いきなり「PCが起動していないと投稿できない」にすると事故になる。
UPDATE tenants SET execution_mode = 'server' WHERE id = 'tenant_default';

-- 拡張機能の端末。連携時に1つ発行し、以後この token で名乗る。
-- ★token は平文で持たない（ハッシュだけ保存する）。
CREATE TABLE agent_devices (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  token_hash    TEXT NOT NULL UNIQUE,   -- SHA-256（16進）
  label         TEXT,                   -- 'Chrome on macOS' など
  note_urlname  TEXT,
  last_seen_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_agent_devices_tenant ON agent_devices(tenant_id, revoked_at);

-- 拡張に実行させる仕事。1件 = 記事1本の公開（または下書き保存）。
CREATE TABLE agent_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  article_id    TEXT NOT NULL REFERENCES articles(id),
  kind          TEXT NOT NULL,          -- publish|draft
  plan_json     TEXT NOT NULL,          -- 実行手順（サーバーが組み立てる）
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending|leased|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  device_id     TEXT,
  lease_until   TEXT,                   -- 取りに来た拡張が落ちても再配布できるように
  result_json   TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_agent_jobs_pending ON agent_jobs(tenant_id, state, created_at);
CREATE INDEX idx_agent_jobs_article ON agent_jobs(article_id);
