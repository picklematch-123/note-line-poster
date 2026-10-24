-- 文中画像の自動生成（P3）。AI が作った画像を、本文のどの目印 `[AI画像N]` に入れるか。
-- ★列の追加だけ（D1 では tenants などの作り直しができないため。CLAUDE.md 参照）。
-- gen_slot: `[AI画像N]` の N。サムネ（is_eyecatch=1）や写真では NULL のまま
ALTER TABLE images ADD COLUMN gen_slot INTEGER;
-- 作ったときの見出し。本文を作り直したとき、見出しが同じ画像をそのまま使い回すために持つ（二重課金を避ける）
ALTER TABLE images ADD COLUMN gen_heading TEXT;
