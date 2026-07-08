-- Add table-of-contents resume columns to the existing readingProgress table.
--
-- readingProgress already tracked progressPercent/scrollPosition per
-- (userId, episodeId). For a package episode (many chapters bundled into one
-- row of content), absolute scroll position alone is fragile - changing font
-- size reflows the page and shifts every scroll offset. These columns let
-- the reader resume at a stable in-package chapter/anchor instead.
--
-- Idempotent: safe to re-run - ADD COLUMN on a column that already exists
-- will error with "Duplicate column name", which simply means this
-- migration was already applied.

ALTER TABLE readingProgress
  ADD COLUMN currentChapterNumber VARCHAR(100) NULL,
  ADD COLUMN currentChapterTitle VARCHAR(500) NULL,
  ADD COLUMN anchorKey VARCHAR(100) NULL;
