CREATE TABLE `accountRecoveryAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recoveryRequestId` int NOT NULL,
	`actorAdminId` int,
	`action` varchar(32) NOT NULL,
	`sourceUserId` int,
	`targetUserId` int,
	`authIdentityId` int,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountRecoveryAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `accountRecoveryRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`requesterUserId` int NOT NULL,
	`requestedLegacyUserId` int,
	`claimedLegacyEmail` varchar(320),
	`claimedLegacyOpenId` varchar(64),
	`claimedDisplayName` varchar(255),
	`evidenceNote` text,
	`referenceOrderNumber` varchar(50),
	`status` enum('pending','approved','rejected','cancelled','blocked') NOT NULL DEFAULT 'pending',
	`reviewedByAdminId` int,
	`reviewedAt` timestamp,
	`reviewReason` text,
	`sourceUserId` int,
	`targetUserId` int,
	`pendingRequesterMarker` int GENERATED ALWAYS AS ((case when `status` = 'pending' then `requesterUserId` else NULL end)) STORED,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accountRecoveryRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountRecoveryRequests_one_pending_per_requester_unique` UNIQUE(`pendingRequesterMarker`)
);
--> statement-breakpoint
ALTER TABLE `accountRecoveryAuditLogs` ADD CONSTRAINT `accountRecoveryAuditLogs_recoveryRequestId_fk` FOREIGN KEY (`recoveryRequestId`) REFERENCES `accountRecoveryRequests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `accountRecoveryAuditLogs_recoveryRequestId_idx` ON `accountRecoveryAuditLogs` (`recoveryRequestId`);--> statement-breakpoint
CREATE INDEX `accountRecoveryAuditLogs_createdAt_idx` ON `accountRecoveryAuditLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `accountRecoveryRequests_requesterUserId_idx` ON `accountRecoveryRequests` (`requesterUserId`);--> statement-breakpoint
CREATE INDEX `accountRecoveryRequests_status_idx` ON `accountRecoveryRequests` (`status`);--> statement-breakpoint
CREATE INDEX `accountRecoveryRequests_createdAt_idx` ON `accountRecoveryRequests` (`createdAt`);