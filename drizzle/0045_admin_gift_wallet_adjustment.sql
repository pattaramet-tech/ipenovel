CREATE TABLE `adminGiftWalletAdjustments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`action` enum('NOVEL_GIFT','WALLET_CREDIT','WALLET_CLAWBACK') NOT NULL,
	`targetUserId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`reason` text NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`amount` decimal(12,2),
	`balanceBefore` decimal(12,2),
	`balanceAfter` decimal(12,2),
	`novelId` int,
	`entitlementCount` int,
	`linkedOriginalAdjustmentId` int,
	`walletTransactionId` int,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `adminGiftWalletAdjustments_id` PRIMARY KEY(`id`),
	CONSTRAINT `adminGiftWalletAdjustments_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `adminGiftWalletAdjustments_target_created_idx` ON `adminGiftWalletAdjustments` (`targetUserId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `adminGiftWalletAdjustments_action_created_idx` ON `adminGiftWalletAdjustments` (`action`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `adminGiftWalletAdjustments_original_idx` ON `adminGiftWalletAdjustments` (`linkedOriginalAdjustmentId`);
--> statement-breakpoint
CREATE TABLE `adminGiftEntitlements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`reason` text NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`adjustmentId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `adminGiftEntitlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `adminGiftEntitlements_user_episode_unique` UNIQUE(`userId`,`episodeId`),
	CONSTRAINT `adminGiftEntitlements_key_episode_unique` UNIQUE(`idempotencyKey`,`episodeId`)
);
--> statement-breakpoint
CREATE INDEX `adminGiftEntitlements_user_created_idx` ON `adminGiftEntitlements` (`userId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `adminGiftEntitlements_novel_idx` ON `adminGiftEntitlements` (`novelId`);
--> statement-breakpoint
ALTER TABLE `adminGiftEntitlements` ADD CONSTRAINT `adminGiftEntitlements_adjustment_fk` FOREIGN KEY (`adjustmentId`) REFERENCES `adminGiftWalletAdjustments`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `adminGiftWalletAdjustments` ADD CONSTRAINT `adminGiftWalletAdjustments_original_fk` FOREIGN KEY (`linkedOriginalAdjustmentId`) REFERENCES `adminGiftWalletAdjustments`(`id`) ON DELETE no action ON UPDATE no action;
