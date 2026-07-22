-- NOTE: rewritten to repair a missing historical precondition. The
-- migration that was originally supposed to create episodes.content (and
-- contentFormat/isPublished/publishedAt/wordCount/sortOrder/
-- episodePurchases/readingProgress) - drizzle/0023_gifted_juggernaut.sql -
-- was never registered in drizzle/meta/_journal.json, so drizzle-orm's
-- migrator (which reads ONLY journal.entries and never scans the
-- directory - see drizzle-orm/migrator.js's readMigrationFiles()) has
-- never executed it on any database whose schema was built purely from
-- this migration chain. That left THIS migration - which assumed
-- episodes.content already existed - failing with an unknown-column error
-- on a genuinely fresh database. See
-- docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md for the full audit.
--
-- Safe to edit unconditionally: drizzle's MySQL migrator resumes purely by
-- comparing each migration's journal timestamp against the single latest
-- recorded timestamp (never by hash/content - verified by reading
-- mysql-core/dialect.js directly), so a database that already recorded
-- this migration skips it by timestamp regardless of what it now
-- contains, and a database that never recorded it (true of every database
-- this bug has ever been hit on, since a failed migration is never
-- recorded) runs this repaired version instead.
--
-- Every statement below is idempotent (information_schema-guarded, same
-- pattern as 0027) and reproduces gifted_juggernaut.sql's ORIGINAL,
-- pre-0025 definitions exactly: content as TEXT (this migration's own
-- MODIFY COLUMN below still upgrades it to MEDIUMTEXT afterward) and
-- readingProgress WITHOUT the TOC columns 0025 adds afterward - see
-- requirement 9 ("correct historical stage"). A database that already has
-- all of this (e.g. via a previous partial run of this same repair, or a
-- manually-managed schema) sees every guarded statement below no-op.
--
-- drizzle/0028_repair_episode_reader_schema.sql re-applies the same
-- guarded checks unconditionally (it always runs, since its timestamp is
-- newer than anything before it) for databases whose recorded migration
-- history is already past this point but whose actual schema drifted for
-- some other reason - this file alone cannot repair those, since they
-- skip it by timestamp.
CREATE TABLE IF NOT EXISTS `episodePurchases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeId` int NOT NULL,
	`pricePaid` decimal(10,2) NOT NULL,
	`walletTransactionId` int,
	`purchasedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `episodePurchases_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_user_episode_purchase` UNIQUE(`userId`,`episodeId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `readingProgress` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeId` int NOT NULL,
	`progressPercent` int NOT NULL DEFAULT 0,
	`scrollPosition` int NOT NULL DEFAULT 0,
	`lastReadAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `readingProgress_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_user_episode_progress` UNIQUE(`userId`,`episodeId`)
);
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'content'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, 'ALTER TABLE `episodes` ADD `content` text', 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'contentFormat'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "ALTER TABLE `episodes` ADD `contentFormat` varchar(50) DEFAULT 'plain_text'", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'isPublished'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "ALTER TABLE `episodes` ADD `isPublished` boolean DEFAULT true NOT NULL", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'publishedAt'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "ALTER TABLE `episodes` ADD `publishedAt` timestamp", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'wordCount'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "ALTER TABLE `episodes` ADD `wordCount` int", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'sortOrder'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "ALTER TABLE `episodes` ADD `sortOrder` int", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodePurchases_userId_idx` ON `episodePurchases` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_novelId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodePurchases_novelId_idx` ON `episodePurchases` (`novelId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_episodeId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodePurchases_episodeId_idx` ON `episodePurchases` (`episodeId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_walletTransactionId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodePurchases_walletTransactionId_idx` ON `episodePurchases` (`walletTransactionId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `readingProgress_userId_idx` ON `readingProgress` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_novelId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `readingProgress_novelId_idx` ON `readingProgress` (`novelId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_episodeId_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `readingProgress_episodeId_idx` ON `readingProgress` (`episodeId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND index_name = 'episodes_isPublished_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodes_isPublished_idx` ON `episodes` (`isPublished`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
SET @ipenovel_0024_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND index_name = 'episodes_sortOrder_idx'
);
--> statement-breakpoint
SET @ipenovel_0024_sql = IF(@ipenovel_0024_exists = 0, "CREATE INDEX `episodes_sortOrder_idx` ON `episodes` (`sortOrder`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0024_stmt FROM @ipenovel_0024_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_stmt;
--> statement-breakpoint
-- LONGTEXT is a wider, storage-compatible supertype of MEDIUMTEXT (max
-- 4GiB vs 16MiB) - MODIFY COLUMN ... mediumtext on a column that is
-- already LONGTEXT is a genuine downgrade, and TiDB implements any
-- column-type change as a full Reorg-Data operation that copies and
-- re-validates every row. Running that downgrade against a database
-- where the column is already LONGTEXT is pure waste at best, and at
-- worst aborts the whole migration (a production row already exceeding
-- the reorg's internal entry-size ceiling caused exactly that - errno
-- 8025 "Entry too large"). Existing LONGTEXT content must therefore be
-- preserved exactly - never downgraded - while a genuinely narrower type
-- (TEXT/TINYTEXT) still widens to MEDIUMTEXT as originally intended.
SET @ipenovel_0024_content_type = (
	SELECT LOWER(DATA_TYPE) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'content'
);
--> statement-breakpoint
SET @ipenovel_0024_content_sql = IF(
	@ipenovel_0024_content_type IN ('mediumtext', 'longtext'),
	'DO 0',
	'ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext'
);
--> statement-breakpoint
PREPARE ipenovel_0024_content_stmt FROM @ipenovel_0024_content_sql;
--> statement-breakpoint
EXECUTE ipenovel_0024_content_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0024_content_stmt;
