-- 画像の alt テキスト。note は alt を保持するので SEO・アクセシビリティ両面で有効。
ALTER TABLE articles ADD COLUMN image_alts_json TEXT;
