-- 画像の出どころ。LINE で送られた写真('user')と、AI が作った画像('generated')を区別する。
-- ★既存の行はすべて 'user' になる（既定値）。生成画像は費用がかかるので、数えられるようにしておく。
ALTER TABLE images ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
-- 生成に使ったプロンプト（監査・作り直し用。秘密情報は入らない）
ALTER TABLE images ADD COLUMN gen_prompt TEXT;
