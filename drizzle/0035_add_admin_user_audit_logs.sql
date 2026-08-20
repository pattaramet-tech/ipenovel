CREATE TABLE `adminUserAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorAdminId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`action` enum('update_name','update_role','delete_user') NOT NULL,
	`reason` text NOT NULL,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `adminUserAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `adminUserAuditLogs_actorAdminId_idx` ON `adminUserAuditLogs` (`actorAdminId`);--> statement-breakpoint
CREATE INDEX `adminUserAuditLogs_targetUserId_idx` ON `adminUserAuditLogs` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `adminUserAuditLogs_createdAt_idx` ON `adminUserAuditLogs` (`createdAt`);