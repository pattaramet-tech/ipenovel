-- Forward-only production repair migration.
--
-- Confirmed production diagnosis (read-only schema check, no application
-- code path touched, no data read):
--   - `dailyCheckins` table does NOT exist in production.
--   - `coupons`.`maxDiscountAmount` DOES already exist in production.
--   - `__drizzle_migrations` exists, and its recorded high-water mark is
--     already past migration 0027 (the migration responsible for creating
--     `dailyCheckins`).
--   - The production `dailyCheckin.getStatus` query fails with
--     ER_NO_SUCH_TABLE for `dailyCheckins`.
-- See docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md's follow-up section for the
-- full incident writeup this migration resolves.
--
-- Why editing or rerunning 0027 does not fix this: 0027's own
-- `CREATE TABLE IF NOT EXISTS dailyCheckins` is already correct and
-- idempotent - the bug is not in 0027's SQL. drizzle-orm's MySQL migrator
-- resumes purely by comparing each journal entry's `when` timestamp against
-- the single latest recorded `created_at` in `__drizzle_migrations` (see
-- drizzle-orm/mysql-core/dialect.js) - never by re-checking whether each
-- individual migration's target objects still exist. A database whose
-- recorded high-water mark is already at or past 0027's timestamp will
-- SKIP 0027 forever, regardless of whether `dailyCheckins` is actually
-- present, was dropped, or was never created in the first place (the exact
-- same "journal says ran, schema disagrees" class of bug this repo's own
-- docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md already documents and
-- fixed the same way, with migration 0028). Only a migration with a NEWER
-- timestamp than anything already recorded will ever be picked up again -
-- this file is that migration.
--
-- Purely additive and forward-only:
--   - Recreates `dailyCheckins` with the exact shape currently declared in
--     drizzle/schema.ts if it is missing.
--   - Re-verifies `dailyCheckins_userId_idx` the same way 0027 already
--     does, in case `dailyCheckins` exists but this secondary index does
--     not (the one partial state possible for this table, since the index
--     is created by a separate statement from the table itself).
--   - Re-verifies `coupons`.`maxDiscountAmount` the same way 0027 already
--     does, so this migration is also self-sufficient (safe to apply on
--     its own) on any environment where that column is genuinely missing,
--     even though production has already confirmed it is present there.
-- Never DROPs, TRUNCATEs, renames, or rewrites anything - if
-- `dailyCheckins` already exists, `CREATE TABLE IF NOT EXISTS` leaves every
-- existing row on it (and on `coupons`) completely untouched. Safe to run
-- in any state: table absent, table present but index missing, table and
-- index both present, column present, column missing, or run twice.
CREATE TABLE IF NOT EXISTS `dailyCheckins` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`checkinDate` varchar(10) NOT NULL,
	`campaignKey` varchar(50) NOT NULL DEFAULT 'default',
	`couponId` int NOT NULL,
	`status` enum('issued','used','void') NOT NULL DEFAULT 'issued',
	`issuedAt` timestamp NOT NULL DEFAULT (now()),
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyCheckins_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_daily_checkin_user_date_campaign` UNIQUE(`userId`,`checkinDate`,`campaignKey`),
	CONSTRAINT `unique_daily_checkins_coupon` UNIQUE(`couponId`)
);
--> statement-breakpoint
SET @ipenovel_0030_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND index_name = 'dailyCheckins_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0030_idx_sql = IF(
	@ipenovel_0030_idx_exists = 0,
	'CREATE INDEX `dailyCheckins_userId_idx` ON `dailyCheckins` (`userId`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0030_idx_stmt FROM @ipenovel_0030_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0030_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0030_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0030_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'coupons' AND column_name = 'maxDiscountAmount'
);
--> statement-breakpoint
SET @ipenovel_0030_alter_sql = IF(
	@ipenovel_0030_col_exists = 0,
	'ALTER TABLE `coupons` ADD `maxDiscountAmount` decimal(10,2)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0030_alter_stmt FROM @ipenovel_0030_alter_sql;
--> statement-breakpoint
EXECUTE ipenovel_0030_alter_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0030_alter_stmt;
