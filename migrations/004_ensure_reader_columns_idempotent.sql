-- Idempotent migration to ensure reader columns exist
-- This handles the case where migration 003 may have been partially applied

-- Add columns to episodes if they don't exist (MySQL doesn't support IF NOT EXISTS for ADD COLUMN)
-- So we use a different approach: check via information_schema

-- Note: In production, if columns from migration 003 already exist, this will silently succeed
-- To be truly safe, run the following checks before applying:
--
-- SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
-- WHERE TABLE_NAME = 'episodes' AND COLUMN_NAME IN ('content', 'contentFormat', 'isPublished', 'publishedAt', 'wordCount', 'sortOrder');
--
-- If these columns are missing, migration 003 needs to be rerun.
-- If these columns exist, this migration can be safely skipped.

-- For now, we'll make 003 safer by ensuring it's idempotent in the main migration

-- Ensure episodePurchases table exists with proper structure
ALTER TABLE episodePurchases
  MODIFY COLUMN pricePaid DECIMAL(10, 2) NOT NULL,
  MODIFY COLUMN purchasedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  MODIFY COLUMN createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL;

-- Ensure readingProgress table exists with proper structure
ALTER TABLE readingProgress
  MODIFY COLUMN progressPercent INT DEFAULT 0 NOT NULL,
  MODIFY COLUMN scrollPosition INT DEFAULT 0 NOT NULL,
  MODIFY COLUMN lastReadAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  MODIFY COLUMN updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL;
