CREATE TABLE `accountMergeDataDedupeRecords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`domain` varchar(40) NOT NULL,
	`sourceRowId` int NOT NULL,
	`targetRowId` int NOT NULL,
	`keySummary` varchar(255) NOT NULL,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeDataDedupeRecords_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeDataDedupeRecords_case_domain_source_unique` UNIQUE(`mergeCaseId`,`domain`,`sourceRowId`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeDataReconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`safeSummary` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeDataReconciliations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeDataReconciliations_mergeCaseId_unique` UNIQUE(`mergeCaseId`)
);
--> statement-breakpoint
CREATE INDEX `accountMergeDataDedupeRecords_mergeCaseId_idx` ON `accountMergeDataDedupeRecords` (`mergeCaseId`);--> statement-breakpoint
CREATE INDEX `accountMergeDataReconciliations_sourceUserId_idx` ON `accountMergeDataReconciliations` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeDataReconciliations_targetUserId_idx` ON `accountMergeDataReconciliations` (`targetUserId`);