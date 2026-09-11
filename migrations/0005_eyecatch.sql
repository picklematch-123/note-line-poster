-- サムネイル（見出し画像）。note では eyecatch と呼ばれ、og:image になる。
-- 本文中の画像とは別枠なので、フラグで区別する。
ALTER TABLE images ADD COLUMN is_eyecatch INTEGER NOT NULL DEFAULT 0;
