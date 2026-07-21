-- NOTE: rewritten to be idempotent, for the same reason as 0024 (see
-- docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md) - a database can reach
-- this point with `readingProgress` already fully caught up (e.g. it was
-- created directly by 0024's own repair in the same run, or these columns
-- were already added some other way, such as a manual `drizzle-kit push`)
-- and a bare ADD COLUMN would fail with "duplicate column". Every
-- statement below is information_schema-guarded, same pattern as 0024/0027 -
-- safe to run whether none, some, or all three columns already exist.
SET @ipenovel_0025_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'currentChapterNumber'
);
--> statement-breakpoint
SET @ipenovel_0025_sql = IF(@ipenovel_0025_exists = 0, "ALTER TABLE `readingProgress` ADD `currentChapterNumber` varchar(100)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0025_stmt FROM @ipenovel_0025_sql;
--> statement-breakpoint
EXECUTE ipenovel_0025_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0025_stmt;
--> statement-breakpoint
SET @ipenovel_0025_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'currentChapterTitle'
);
--> statement-breakpoint
SET @ipenovel_0025_sql = IF(@ipenovel_0025_exists = 0, "ALTER TABLE `readingProgress` ADD `currentChapterTitle` varchar(500)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0025_stmt FROM @ipenovel_0025_sql;
--> statement-breakpoint
EXECUTE ipenovel_0025_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0025_stmt;
--> statement-breakpoint
SET @ipenovel_0025_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'anchorKey'
);
--> statement-breakpoint
SET @ipenovel_0025_sql = IF(@ipenovel_0025_exists = 0, "ALTER TABLE `readingProgress` ADD `anchorKey` varchar(100)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0025_stmt FROM @ipenovel_0025_sql;
--> statement-breakpoint
EXECUTE ipenovel_0025_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0025_stmt;
