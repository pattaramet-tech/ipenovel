CREATE TABLE `sportsMatchVotes` (
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
CREATE TABLE `sportsMatches` (
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
CREATE INDEX `sportsMatchVotes_matchId_idx` ON `sportsMatchVotes` (`matchId`);--> statement-breakpoint
CREATE INDEX `sportsMatchVotes_userId_idx` ON `sportsMatchVotes` (`userId`);--> statement-breakpoint
CREATE INDEX `sportsMatchVotes_status_idx` ON `sportsMatchVotes` (`status`);--> statement-breakpoint
CREATE INDEX `sportsMatches_status_idx` ON `sportsMatches` (`status`);--> statement-breakpoint
CREATE INDEX `sportsMatches_isActive_idx` ON `sportsMatches` (`isActive`);--> statement-breakpoint
CREATE INDEX `sportsMatches_voteDeadlineAt_idx` ON `sportsMatches` (`voteDeadlineAt`);--> statement-breakpoint
CREATE INDEX `sportsMatches_displayOrder_idx` ON `sportsMatches` (`displayOrder`);