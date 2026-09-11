-- 修正指示を source_text に混ぜず、独立して持つ。
-- 混ぜると修正のたびに元ネタが汚れて、指示が累積してしまうため。
ALTER TABLE articles ADD COLUMN revision_instruction TEXT;
ALTER TABLE articles ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
