CREATE TABLE `walletAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`balance` decimal(12,2) NOT NULL DEFAULT '0.00',
	`totalTopupApproved` decimal(12,2) DEFAULT '0.00',
	`totalSpent` decimal(12,2) DEFAULT '0.00',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `walletAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `walletAccounts_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `walletTopups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`requestedAmount` decimal(12,2) NOT NULL,
	`slipImageUrl` text,
	`status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`rejectionReason` text,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `walletTopups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `walletTransactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('topup_pending','topup_approved','topup_rejected','debit','refund','adjust') NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`balanceBefore` decimal(12,2) NOT NULL,
	`balanceAfter` decimal(12,2) NOT NULL,
	`referenceType` varchar(50),
	`referenceId` int,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `walletTransactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `walletAccounts_userId_idx` ON `walletAccounts` (`userId`);--> statement-breakpoint
CREATE INDEX `walletTopups_userId_idx` ON `walletTopups` (`userId`);--> statement-breakpoint
CREATE INDEX `walletTopups_status_idx` ON `walletTopups` (`status`);--> statement-breakpoint
CREATE INDEX `walletTopups_createdAt_idx` ON `walletTopups` (`createdAt`);--> statement-breakpoint
CREATE INDEX `walletTransactions_userId_idx` ON `walletTransactions` (`userId`);--> statement-breakpoint
CREATE INDEX `walletTransactions_createdAt_idx` ON `walletTransactions` (`createdAt`);