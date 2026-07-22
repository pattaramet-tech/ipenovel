-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair - see migration 0018's header comment for the shared rationale.
-- Every original column, enum, default, primary key, and unique
-- constraint is preserved exactly - only how safely each object is
-- reached has changed.
CREATE TABLE IF NOT EXISTS `sportsMatchRewards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`matchId` int NOT NULL,
	`voteId` int NOT NULL,
	`userId` int NOT NULL,
	`couponId` int NOT NULL,
	`status` enum('issued','used','expired','void') NOT NULL DEFAULT 'issued',
	`issuedAt` timestamp NOT NULL DEFAULT (now()),
	`usedAt` timestamp,
	`expiredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsMatchRewards_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_sports_match_rewards_vote` UNIQUE(`voteId`),
	CONSTRAINT `unique_sports_match_rewards_coupon` UNIQUE(`couponId`)
);
--> statement-breakpoint
SET @ipenovel_0019_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchRewards' AND index_name = 'sportsMatchRewards_matchId_idx'
);
--> statement-breakpoint
SET @ipenovel_0019_idx_sql = IF(@ipenovel_0019_idx_exists = 0, "CREATE INDEX `sportsMatchRewards_matchId_idx` ON `sportsMatchRewards` (`matchId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0019_idx_stmt FROM @ipenovel_0019_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0019_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0019_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0019_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchRewards' AND index_name = 'sportsMatchRewards_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0019_idx_sql = IF(@ipenovel_0019_idx_exists = 0, "CREATE INDEX `sportsMatchRewards_userId_idx` ON `sportsMatchRewards` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0019_idx_stmt FROM @ipenovel_0019_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0019_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0019_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0019_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchRewards' AND index_name = 'sportsMatchRewards_status_idx'
);
--> statement-breakpoint
SET @ipenovel_0019_idx_sql = IF(@ipenovel_0019_idx_exists = 0, "CREATE INDEX `sportsMatchRewards_status_idx` ON `sportsMatchRewards` (`status`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0019_idx_stmt FROM @ipenovel_0019_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0019_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0019_idx_stmt;
