-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair. Production's recorded migration history high-water mark is
-- currently before this migration's own timestamp; per the confirmed
-- diagnosis both `sportsMatchVotes`/`sportsMatches` and their indexes are
-- completely absent there, so this migration's bare CREATE TABLE
-- statements would succeed as-is - but the whole legacy chain (0017-0023)
-- is being made uniformly idempotent so any later resume, partial
-- application, or re-run converges safely regardless of exact starting
-- state, matching the pattern already established for migrations
-- 0024-0030. Every original column, enum, default, primary key, and
-- unique constraint is preserved exactly - only how safely each object is
-- reached has changed.
CREATE TABLE IF NOT EXISTS `sportsMatchVotes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`matchId` int NOT NULL,
	`userId` int NOT NULL,
	`prediction` enum('home_win','draw','away_win') NOT NULL,
	`pointsSpent` decimal(10,2) NOT NULL DEFAULT '0.00',
	`status` enum('pending','won','lost','refunded') NOT NULL DEFAULT 'pending',
	`rewardCouponId` int,
	`rewardCouponCode` varchar(50),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsMatchVotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_sports_match_user_vote` UNIQUE(`matchId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sportsMatches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`leagueName` varchar(255),
	`homeTeamName` varchar(255) NOT NULL,
	`awayTeamName` varchar(255) NOT NULL,
	`homeTeamImageUrl` text,
	`awayTeamImageUrl` text,
	`coverImageUrl` text,
	`matchStartAt` timestamp,
	`voteDeadlineAt` timestamp NOT NULL,
	`voteCostPoints` decimal(10,2) NOT NULL DEFAULT '0.00',
	`rewardDiscountType` enum('flat','percentage') NOT NULL,
	`rewardDiscountValue` decimal(10,2) NOT NULL,
	`rewardMinPurchaseAmount` decimal(10,2) DEFAULT '0.00',
	`rewardCouponExpiresAt` timestamp,
	`status` enum('draft','open','closed','settled','cancelled') NOT NULL DEFAULT 'draft',
	`result` enum('home_win','draw','away_win'),
	`isActive` boolean NOT NULL DEFAULT true,
	`displayOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsMatches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchVotes' AND index_name = 'sportsMatchVotes_matchId_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatchVotes_matchId_idx` ON `sportsMatchVotes` (`matchId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchVotes' AND index_name = 'sportsMatchVotes_userId_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatchVotes_userId_idx` ON `sportsMatchVotes` (`userId`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatchVotes' AND index_name = 'sportsMatchVotes_status_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatchVotes_status_idx` ON `sportsMatchVotes` (`status`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatches' AND index_name = 'sportsMatches_status_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatches_status_idx` ON `sportsMatches` (`status`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatches' AND index_name = 'sportsMatches_isActive_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatches_isActive_idx` ON `sportsMatches` (`isActive`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatches' AND index_name = 'sportsMatches_voteDeadlineAt_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatches_voteDeadlineAt_idx` ON `sportsMatches` (`voteDeadlineAt`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
--> statement-breakpoint
SET @ipenovel_0018_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'sportsMatches' AND index_name = 'sportsMatches_displayOrder_idx'
);
--> statement-breakpoint
SET @ipenovel_0018_idx_sql = IF(@ipenovel_0018_idx_exists = 0, "CREATE INDEX `sportsMatches_displayOrder_idx` ON `sportsMatches` (`displayOrder`)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0018_idx_stmt FROM @ipenovel_0018_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0018_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0018_idx_stmt;
