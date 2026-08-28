CREATE TABLE `accountMergeAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int,
	`actorAdminId` int,
	`action` varchar(32) NOT NULL,
	`sourceUserId` int,
	`targetUserId` int,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeCases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`originAccountRecoveryRequestId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`status` enum('pending','in_progress','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`createdByAdminId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	`cancelledAt` timestamp,
	`cancelReason` text,
	CONSTRAINT `accountMergeCases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_mergeCaseId_idx` ON `accountMergeAuditLogs` (`mergeCaseId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_sourceUserId_idx` ON `accountMergeAuditLogs` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_targetUserId_idx` ON `accountMergeAuditLogs` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_createdAt_idx` ON `accountMergeAuditLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_originAccountRecoveryRequestId_idx` ON `accountMergeCases` (`originAccountRecoveryRequestId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_sourceUserId_idx` ON `accountMergeCases` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_targetUserId_idx` ON `accountMergeCases` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_status_idx` ON `accountMergeCases` (`status`);