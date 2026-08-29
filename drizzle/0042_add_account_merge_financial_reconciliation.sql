CREATE TABLE `accountMergeFinancialReconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`walletSourceBefore` decimal(12,2) NOT NULL,
	`walletTargetBefore` decimal(12,2) NOT NULL,
	`walletTransferred` decimal(12,2) NOT NULL,
	`walletSourceAfter` decimal(12,2) NOT NULL,
	`walletTargetAfter` decimal(12,2) NOT NULL,
	`pointsSourceBefore` decimal(10,2) NOT NULL,
	`pointsTargetBefore` decimal(10,2) NOT NULL,
	`pointsTransferred` decimal(10,2) NOT NULL,
	`pointsSourceAfter` decimal(10,2) NOT NULL,
	`pointsTargetAfter` decimal(10,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeFinancialReconciliations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeFinancialReconciliations_mergeCaseId_unique` UNIQUE(`mergeCaseId`)
);
--> statement-breakpoint
CREATE INDEX `accountMergeFinancialReconciliations_sourceUserId_idx` ON `accountMergeFinancialReconciliations` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeFinancialReconciliations_targetUserId_idx` ON `accountMergeFinancialReconciliations` (`targetUserId`);