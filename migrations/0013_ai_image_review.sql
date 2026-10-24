-- AI が作った文中画像（P3）を、公開前に人が確かめたかの印（2026-10-24 源蔵レビュー P3 必須3）。
-- ★列の追加だけ（D1 では tenants などの作り直しができないため。CLAUDE.md 参照）。
-- 「下書きに保存」していない記事で、AI 画像つきの初回「公開する」を押したら一度だけ確認を出す。
-- 「このまま公開する」を押した時刻を入れる。NULL ＝ まだ確かめていない
ALTER TABLE articles ADD COLUMN ai_images_confirmed_at TEXT DEFAULT NULL;
