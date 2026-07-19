-- NOTE: rewritten to be idempotent after a production incident where this
-- migration never ran automatically (no deploy step executed migrations at
-- all - see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md). Because drizzle's
-- migrator runs every pending migration's statements in one fail-fast loop
-- inside a single call, if this migration is ever left partially applied
-- (e.g. the table got created but the ALTER TABLE below did not run before
-- something failed), a bare re-run would hit "table already exists" on the
-- very first statement and never reach the rest. Every statement here is
-- therefore written to be safe to re-run in ANY state: not started,
-- partially applied, or fully applied. This does not change the intended
-- end schema - only how safely it converges to it.
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
SET @ipenovel_0027_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'coupons' AND column_name = 'maxDiscountAmount'
);
--> statement-breakpoint
SET @ipenovel_0027_alter_sql = IF(
	@ipenovel_0027_col_exists = 0,
	'ALTER TABLE `coupons` ADD `maxDiscountAmount` decimal(10,2)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0027_alter_stmt FROM @ipenovel_0027_alter_sql;
--> statement-breakpoint
EXECUTE ipenovel_0027_alter_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0027_alter_stmt;
--> statement-breakpoint
SET @ipenovel_0027_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND index_name = 'dailyCheckins_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0027_idx_sql = IF(
	@ipenovel_0027_idx_exists = 0,
	'CREATE INDEX `dailyCheckins_userId_idx` ON `dailyCheckins` (`userId`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0027_idx_stmt FROM @ipenovel_0027_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0027_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0027_idx_stmt;
