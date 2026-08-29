CREATE TABLE `sportsCompetitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(255) NOT NULL,
	`competitionType` enum('league','cup') NOT NULL DEFAULT 'league',
	`logoImageUrl` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsCompetitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsCompetitions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE INDEX `sportsCompetitions_name_idx` ON `sportsCompetitions` (`name`);
--> statement-breakpoint
CREATE INDEX `sportsCompetitions_isActive_idx` ON `sportsCompetitions` (`isActive`);
--> statement-breakpoint
CREATE TABLE `sportsTeams` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(255) NOT NULL,
	`logoImageUrl` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsTeams_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsTeams_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE INDEX `sportsTeams_name_idx` ON `sportsTeams` (`name`);
--> statement-breakpoint
CREATE INDEX `sportsTeams_isActive_idx` ON `sportsTeams` (`isActive`);
--> statement-breakpoint
CREATE TABLE `sportsCompetitionTeams` (
	`id` int AUTO_INCREMENT NOT NULL,
	`competitionId` int NOT NULL,
	`teamId` int NOT NULL,
	`displayOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sportsCompetitionTeams_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsCompetitionTeams_competition_team_unique` UNIQUE(`competitionId`,`teamId`)
);
--> statement-breakpoint
CREATE INDEX `sportsCompetitionTeams_competitionId_idx` ON `sportsCompetitionTeams` (`competitionId`);
--> statement-breakpoint
CREATE INDEX `sportsCompetitionTeams_teamId_idx` ON `sportsCompetitionTeams` (`teamId`);
--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `competitionId` int;
--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `homeTeamId` int;
--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `awayTeamId` int;
--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `rewardKind` enum('coupon','points') NOT NULL DEFAULT 'coupon';
--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `rewardPointsAmount` decimal(10,2);
--> statement-breakpoint
ALTER TABLE `sportsMatches` MODIFY COLUMN `rewardDiscountType` enum('flat','percentage') NULL;
--> statement-breakpoint
ALTER TABLE `sportsMatches` MODIFY COLUMN `rewardDiscountValue` decimal(10,2) NULL;
--> statement-breakpoint
CREATE INDEX `sportsMatches_competitionId_idx` ON `sportsMatches` (`competitionId`);
--> statement-breakpoint
CREATE INDEX `sportsMatches_homeTeamId_idx` ON `sportsMatches` (`homeTeamId`);
--> statement-breakpoint
CREATE INDEX `sportsMatches_awayTeamId_idx` ON `sportsMatches` (`awayTeamId`);
--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `rewardKind` enum('coupon','points') NOT NULL DEFAULT 'coupon';
--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` MODIFY COLUMN `couponId` int NULL;
--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `pointsAmount` decimal(10,2);
--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `pointsTransactionId` int;
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_sports_match_rewards_points_tx` ON `sportsMatchRewards` (`pointsTransactionId`);