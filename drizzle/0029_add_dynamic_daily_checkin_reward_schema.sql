-- Stage 1A of the configurable daily check-in reward system - see
-- docs/DAILY_CHECKIN_DYNAMIC_REWARDS_DESIGN.md. Adds the four new, purely
-- additive tables (dailyCheckinCampaigns, dailyCheckinCouponTemplates,
-- dailyCheckinRewardRules, dailyCheckinRewardGrants) the configurable
-- reward model needs. Nothing about the existing dailyCheckins table, the
-- legacy JSON campaign config, or the claim/status API is touched here -
-- see the design doc's PART L migration plan for the later stages that do.
--
-- Idempotent via the two techniques already established in this migration
-- chain (0024/0026/0027/0028): CREATE TABLE IF NOT EXISTS for each table,
-- and information_schema.statistics-guarded
-- SET/PREPARE/EXECUTE/DEALLOCATE PREPARE for every secondary/unique index.
-- Unlike 0024's guarded ADD COLUMN treatment of the pre-existing `episodes`
-- table, these four tables are introduced in this single migration with no
-- earlier migration that could have left one of them with an incomplete
-- column set - CREATE TABLE IF NOT EXISTS already fully covers "does not
-- exist yet" for all of their columns at once. The only realistic partial
-- state for a brand-new table is one or more of its own secondary/unique
-- indexes missing (e.g. an earlier run of this exact migration that
-- created the tables but was interrupted before every guarded index ran),
-- which the guarded CREATE INDEX statements below handle completely. This
-- makes a rerun safe in any state: absent, indexes-missing, fully present,
-- run twice, or run after the migration history itself is rewound.
CREATE TABLE IF NOT EXISTS `dailyCheckinCampaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`campaignKey` varchar(50) NOT NULL,
	`name` varchar(150) NOT NULL,
	`description` text,
	`timezone` varchar(50) NOT NULL DEFAULT 'Asia/Bangkok',
	`startDate` varchar(10) NOT NULL,
	`endDate` varchar(10) NOT NULL,
	`status` enum('draft','active','ended') NOT NULL DEFAULT 'draft',
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyCheckinCampaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dailyCheckinCouponTemplates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`campaignId` int NOT NULL,
	`discountType` enum('flat','percentage') NOT NULL,
	`discountValue` decimal(10,2) NOT NULL,
	`maxDiscountAmount` decimal(10,2),
	`minPurchaseAmount` decimal(10,2) NOT NULL DEFAULT '0.00',
	`validityDays` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyCheckinCouponTemplates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dailyCheckinRewardRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`campaignId` int NOT NULL,
	`ruleType` enum('daily','milestone') NOT NULL,
	`rewardKind` enum('points','coupon') NOT NULL,
	`milestoneDay` int,
	`repeatEvery` int,
	`pointsAmount` decimal(10,2),
	`couponTemplateId` int,
	`dedupeKey` varchar(120) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyCheckinRewardRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dailyCheckinRewardGrants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`dailyCheckinId` int NOT NULL,
	`userId` int NOT NULL,
	`campaignId` int NOT NULL,
	`ruleId` int NOT NULL,
	`rewardKind` enum('points','coupon') NOT NULL,
	`grantReason` enum('daily','milestone') NOT NULL,
	`milestoneDay` int,
	`milestoneInstanceNumber` int,
	`streakCountAtGrant` int NOT NULL,
	`pointsAmount` decimal(10,2),
	`pointsTransactionId` int,
	`couponId` int,
	`discountType` enum('flat','percentage'),
	`discountValue` decimal(10,2),
	`maxDiscountAmount` decimal(10,2),
	`minPurchaseAmount` decimal(10,2),
	`status` enum('granted','used','void') NOT NULL DEFAULT 'granted',
	`usedAt` timestamp,
	`voidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dailyCheckinRewardGrants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinCampaigns' AND index_name = 'dailyCheckinCampaigns_campaignKey_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinCampaigns_campaignKey_unique` ON `dailyCheckinCampaigns` (`campaignKey`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinCampaigns' AND index_name = 'dailyCheckinCampaigns_status_date_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinCampaigns_status_date_idx` ON `dailyCheckinCampaigns` (`status`,`startDate`,`endDate`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinCouponTemplates' AND index_name = 'dailyCheckinCouponTemplates_campaignId_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinCouponTemplates_campaignId_idx` ON `dailyCheckinCouponTemplates` (`campaignId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardRules' AND index_name = 'dailyCheckinRewardRules_campaign_dedupe_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinRewardRules_campaign_dedupe_unique` ON `dailyCheckinRewardRules` (`campaignId`,`dedupeKey`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardRules' AND index_name = 'dailyCheckinRewardRules_campaign_active_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinRewardRules_campaign_active_idx` ON `dailyCheckinRewardRules` (`campaignId`,`isActive`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_checkin_rule_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinRewardGrants_checkin_rule_unique` ON `dailyCheckinRewardGrants` (`dailyCheckinId`,`ruleId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_user_rule_instance_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinRewardGrants_user_rule_instance_unique` ON `dailyCheckinRewardGrants` (`userId`,`ruleId`,`milestoneInstanceNumber`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_campaign_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinRewardGrants_campaign_idx` ON `dailyCheckinRewardGrants` (`campaignId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_user_created_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinRewardGrants_user_created_idx` ON `dailyCheckinRewardGrants` (`userId`,`createdAt`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_status_idx'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE INDEX `dailyCheckinRewardGrants_status_idx` ON `dailyCheckinRewardGrants` (`status`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_couponId_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinRewardGrants_couponId_unique` ON `dailyCheckinRewardGrants` (`couponId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
--> statement-breakpoint
SET @ipenovel_0029_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckinRewardGrants' AND index_name = 'dailyCheckinRewardGrants_pointsTransactionId_unique'
);
--> statement-breakpoint
SET @ipenovel_0029_sql = IF(@ipenovel_0029_exists = 0, "CREATE UNIQUE INDEX `dailyCheckinRewardGrants_pointsTransactionId_unique` ON `dailyCheckinRewardGrants` (`pointsTransactionId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0029_stmt FROM @ipenovel_0029_sql;
--> statement-breakpoint
EXECUTE ipenovel_0029_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0029_stmt;
