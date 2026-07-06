CREATE TABLE `episodePurchases` (
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
CREATE TABLE `readingProgress` (
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
ALTER TABLE `episodes` ADD `content` text;--> statement-breakpoint
ALTER TABLE `episodes` ADD `contentFormat` varchar(50) DEFAULT 'plain_text';--> statement-breakpoint
ALTER TABLE `episodes` ADD `isPublished` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `episodes` ADD `publishedAt` timestamp;--> statement-breakpoint
ALTER TABLE `episodes` ADD `wordCount` int;--> statement-breakpoint
ALTER TABLE `episodes` ADD `sortOrder` int;--> statement-breakpoint
CREATE INDEX `episodePurchases_userId_idx` ON `episodePurchases` (`userId`);--> statement-breakpoint
CREATE INDEX `episodePurchases_novelId_idx` ON `episodePurchases` (`novelId`);--> statement-breakpoint
CREATE INDEX `episodePurchases_episodeId_idx` ON `episodePurchases` (`episodeId`);--> statement-breakpoint
CREATE INDEX `episodePurchases_walletTransactionId_idx` ON `episodePurchases` (`walletTransactionId`);--> statement-breakpoint
CREATE INDEX `readingProgress_userId_idx` ON `readingProgress` (`userId`);--> statement-breakpoint
CREATE INDEX `readingProgress_novelId_idx` ON `readingProgress` (`novelId`);--> statement-breakpoint
CREATE INDEX `readingProgress_episodeId_idx` ON `readingProgress` (`episodeId`);--> statement-breakpoint
CREATE INDEX `episodes_isPublished_idx` ON `episodes` (`isPublished`);--> statement-breakpoint
CREATE INDEX `episodes_sortOrder_idx` ON `episodes` (`sortOrder`);