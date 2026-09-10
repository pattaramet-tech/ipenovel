CREATE TABLE `accountMergeCompensations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`historicalMergeCaseId` int NOT NULL,
	`recoveryRequestId` int NOT NULL,
	`donorUserId` int NOT NULL,
	`survivorUserId` int NOT NULL,
	`googleIdentityId` int NOT NULL,
	`status` enum('pending','in_progress','completed','failed') NOT NULL DEFAULT 'pending',
	`expectedSnapshotDigest` varchar(64) NOT NULL,
	`createdByAdminId` int NOT NULL,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`failedAt` timestamp,
	`failureReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accountMergeCompensations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeCompensations_historical_case_unique` UNIQUE(`historicalMergeCaseId`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeCompensationReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`compensationId` int NOT NULL,
	`historicalMergeCaseId` int NOT NULL,
	`recoveryRequestId` int NOT NULL,
	`donorUserId` int NOT NULL,
	`survivorUserId` int NOT NULL,
	`googleIdentityId` int NOT NULL,
	`expectedSnapshotDigest` varchar(64) NOT NULL,
	`beforeSnapshot` text NOT NULL,
	`afterSnapshot` text NOT NULL,
	`actionCounts` text NOT NULL,
	`financialProof` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeCompensationReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeCompensationReceipts_compensation_unique` UNIQUE(`compensationId`),
	CONSTRAINT `accountMergeCompensationReceipts_historical_case_unique` UNIQUE(`historicalMergeCaseId`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeCompensationAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`compensationId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`action` varchar(48) NOT NULL,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeCompensationAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeCompensationDedupeRecords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`compensationId` int NOT NULL,
	`domain` varchar(40) NOT NULL,
	`donorRowId` int NOT NULL,
	`survivorRowId` int NOT NULL,
	`keySummary` varchar(255) NOT NULL,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeCompensationDedupeRecords_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeCompensationDedupeRecords_comp_domain_donor_unique` UNIQUE(`compensationId`,`domain`,`donorRowId`)
);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensations_recovery_request_idx` ON `accountMergeCompensations` (`recoveryRequestId`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensations_donor_user_idx` ON `accountMergeCompensations` (`donorUserId`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensations_survivor_user_idx` ON `accountMergeCompensations` (`survivorUserId`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensations_status_idx` ON `accountMergeCompensations` (`status`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensationReceipts_recovery_request_idx` ON `accountMergeCompensationReceipts` (`recoveryRequestId`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensationAuditLogs_compensation_idx` ON `accountMergeCompensationAuditLogs` (`compensationId`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensationAuditLogs_created_at_idx` ON `accountMergeCompensationAuditLogs` (`createdAt`);
--> statement-breakpoint
CREATE INDEX `accountMergeCompensationDedupeRecords_compensation_idx` ON `accountMergeCompensationDedupeRecords` (`compensationId`);
