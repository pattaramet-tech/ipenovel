-- NOTE: rewritten to be idempotent after the daily check-in integration
-- test suite proved this migration cannot safely re-run. Integration tests
-- intentionally rewind the __drizzle_migrations high-water mark to 0023
-- while leaving the indexes this migration created in place (to reproduce
-- "history says an earlier point, schema says later" states for other
-- migrations) - the next migration run then re-attempts 0026's three bare
-- CREATE INDEX statements and fails with a duplicate-key-name error. Every
-- statement below is guarded the same information_schema.statistics way as
-- migrations 0024/0027/0028: safe to run against a fully-absent,
-- partially-present, or fully-present state.
--
-- Safe to edit unconditionally for the same resume reason documented in
-- drizzle/0024_widen_episode_content_mediumtext.sql: drizzle's MySQL
-- migrator resumes purely by comparing each migration's journal timestamp
-- against the single latest recorded timestamp (never by hash/content), so
-- a database that already recorded this migration skips it by timestamp
-- regardless of what it now contains, and a database that has not
-- successfully recorded it runs this repaired, idempotent version instead.
SET @ipenovel_0026_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND index_name = 'episodes_isPublished_createdAt_idx'
);
--> statement-breakpoint
SET @ipenovel_0026_sql = IF(@ipenovel_0026_exists = 0, "CREATE INDEX `episodes_isPublished_createdAt_idx` ON `episodes` (`isPublished`,`createdAt`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0026_stmt FROM @ipenovel_0026_sql;
--> statement-breakpoint
EXECUTE ipenovel_0026_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0026_stmt;
--> statement-breakpoint
SET @ipenovel_0026_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'novels' AND index_name = 'novels_publicationStatus_createdAt_idx'
);
--> statement-breakpoint
SET @ipenovel_0026_sql = IF(@ipenovel_0026_exists = 0, "CREATE INDEX `novels_publicationStatus_createdAt_idx` ON `novels` (`publicationStatus`,`createdAt`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0026_stmt FROM @ipenovel_0026_sql;
--> statement-breakpoint
EXECUTE ipenovel_0026_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0026_stmt;
--> statement-breakpoint
SET @ipenovel_0026_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'purchases' AND index_name = 'purchases_novelId_idx'
);
--> statement-breakpoint
SET @ipenovel_0026_sql = IF(@ipenovel_0026_exists = 0, "CREATE INDEX `purchases_novelId_idx` ON `purchases` (`novelId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0026_stmt FROM @ipenovel_0026_sql;
--> statement-breakpoint
EXECUTE ipenovel_0026_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0026_stmt;
