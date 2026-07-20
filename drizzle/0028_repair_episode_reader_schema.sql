-- Final, always-run repair migration. See
-- docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md for the full root-cause
-- audit: drizzle/0023_gifted_juggernaut.sql (which creates episodePurchases,
-- readingProgress, and six episodes reader columns) was never registered in
-- drizzle/meta/_journal.json, so drizzle-orm's migrator has never executed
-- it. Migrations 0024 and 0025 were rewritten in this same change to
-- idempotently repair this for any database that still runs them for real
-- (a genuinely fresh database, or any database whose recorded migration
-- history has not yet passed their timestamps).
--
-- This migration exists for the OTHER case: drizzle's MySQL migrator
-- resumes purely by comparing each migration's journal timestamp against
-- the single latest recorded timestamp (never by hash/content - see
-- mysql-core/dialect.js). A database whose __drizzle_migrations high-water
-- mark is already past 0024/0025 (for example, one previously brought up to
-- date by `drizzle-kit push` rather than this file-based chain, or one
-- whose recorded history advanced some other way) will SKIP the repaired
-- 0024/0025 entirely regardless of what they now contain, and therefore
-- needs a migration with a NEWER timestamp than anything before it to ever
-- run again. This file re-applies the exact same idempotent checks
-- (episodes columns/indexes, episodePurchases, readingProgress, and
-- readingProgress's TOC columns) unconditionally - for a database that is
-- already fully correct (the common case going forward), every check below
-- is a guarded no-op.
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
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'content'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, 'ALTER TABLE `episodes` ADD `content` mediumtext', 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'contentFormat'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `episodes` ADD `contentFormat` varchar(50) DEFAULT 'plain_text'", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'isPublished'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `episodes` ADD `isPublished` boolean DEFAULT true NOT NULL", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'publishedAt'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `episodes` ADD `publishedAt` timestamp", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'wordCount'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `episodes` ADD `wordCount` int", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'sortOrder'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `episodes` ADD `sortOrder` int", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodePurchases_userId_idx` ON `episodePurchases` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_novelId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodePurchases_novelId_idx` ON `episodePurchases` (`novelId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_episodeId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodePurchases_episodeId_idx` ON `episodePurchases` (`episodeId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodePurchases' AND index_name = 'episodePurchases_walletTransactionId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodePurchases_walletTransactionId_idx` ON `episodePurchases` (`walletTransactionId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `readingProgress_userId_idx` ON `readingProgress` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_novelId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `readingProgress_novelId_idx` ON `readingProgress` (`novelId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND index_name = 'readingProgress_episodeId_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `readingProgress_episodeId_idx` ON `readingProgress` (`episodeId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND index_name = 'episodes_isPublished_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodes_isPublished_idx` ON `episodes` (`isPublished`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND index_name = 'episodes_sortOrder_idx'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "CREATE INDEX `episodes_sortOrder_idx` ON `episodes` (`sortOrder`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'currentChapterNumber'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `readingProgress` ADD `currentChapterNumber` varchar(100)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'currentChapterTitle'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `readingProgress` ADD `currentChapterTitle` varchar(500)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
--> statement-breakpoint
SET @ipenovel_0028_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'readingProgress' AND column_name = 'anchorKey'
);
--> statement-breakpoint
SET @ipenovel_0028_sql = IF(@ipenovel_0028_exists = 0, "ALTER TABLE `readingProgress` ADD `anchorKey` varchar(100)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0028_stmt FROM @ipenovel_0028_sql;
--> statement-breakpoint
EXECUTE ipenovel_0028_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0028_stmt;
