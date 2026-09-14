CREATE TABLE `workspaceAiProviderAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorAdminId` int NOT NULL,
	`action` varchar(80) NOT NULL,
	`profileId` int,
	`safeMetadataJson` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceAiProviderAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaceAiProviderProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`providerType` varchar(80) NOT NULL,
	`providerName` varchar(120) NOT NULL,
	`apiUrl` varchar(2048) NOT NULL,
	`model` varchar(160) NOT NULL,
	`reconcileUrlTemplate` varchar(2048),
	`timeoutMs` int NOT NULL DEFAULT 30000,
	`maxInputChars` int NOT NULL DEFAULT 200000,
	`secretContext` varchar(64) NOT NULL,
	`apiKeyCiphertext` text NOT NULL,
	`status` enum('enabled','disabled') NOT NULL DEFAULT 'enabled',
	`revision` int NOT NULL DEFAULT 1,
	`createdByAdminId` int NOT NULL,
	`updatedByAdminId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceAiProviderProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `waipp_name_unique` UNIQUE(`name`),
	CONSTRAINT `waipp_secret_context_unique` UNIQUE(`secretContext`)
);
--> statement-breakpoint
CREATE TABLE `workspaceAiProviderState` (
	`id` int NOT NULL,
	`activeProfileId` int,
	`revision` int NOT NULL DEFAULT 1,
	`updatedByAdminId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceAiProviderState_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workspaceAiProviderAuditLogs` ADD CONSTRAINT `waipal_actor_fk` FOREIGN KEY (`actorAdminId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiProviderAuditLogs` ADD CONSTRAINT `waipal_profile_fk` FOREIGN KEY (`profileId`) REFERENCES `workspaceAiProviderProfiles`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiProviderProfiles` ADD CONSTRAINT `waipp_created_by_fk` FOREIGN KEY (`createdByAdminId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiProviderProfiles` ADD CONSTRAINT `waipp_updated_by_fk` FOREIGN KEY (`updatedByAdminId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiProviderState` ADD CONSTRAINT `waips_active_profile_fk` FOREIGN KEY (`activeProfileId`) REFERENCES `workspaceAiProviderProfiles`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiProviderState` ADD CONSTRAINT `waips_updated_by_fk` FOREIGN KEY (`updatedByAdminId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `waipal_actor_created_idx` ON `workspaceAiProviderAuditLogs` (`actorAdminId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `waipal_profile_created_idx` ON `workspaceAiProviderAuditLogs` (`profileId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `waipp_status_idx` ON `workspaceAiProviderProfiles` (`status`);
