-- Webリサーチ（P2）の結果。検査済みの事実メモ・参照したURL一覧・状態・照合結果を JSON で持つ。
-- ★記事の作り直しで同じ調査をやり直さない（課金済みのため）よう、記事の行に置く。
-- ★既存の行は NULL＝「調査の仕組みが無かった頃の記事」として、今までどおり扱う。
ALTER TABLE articles ADD COLUMN research_json TEXT;
