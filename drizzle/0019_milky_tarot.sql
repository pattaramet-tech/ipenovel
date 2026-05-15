CREATE TABLE `sportsMatchRewards` (
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
CREATE INDEX `sportsMatchRewards_matchId_idx` ON `sportsMatchRewards` (`matchId`);--> statement-breakpoint
CREATE INDEX `sportsMatchRewards_userId_idx` ON `sportsMatchRewards` (`userId`);--> statement-breakpoint
CREATE INDEX `sportsMatchRewards_status_idx` ON `sportsMatchRewards` (`status`);