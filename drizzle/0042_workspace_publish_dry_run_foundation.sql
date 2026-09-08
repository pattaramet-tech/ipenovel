CREATE TABLE `workspaceOutbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`publishRunId` int NOT NULL,
	`eventType` varchar(120) NOT NULL,
	`payloadObjectKey` varchar(500) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`status` enum('pending','claimed','delivered','failed','dead_letter') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`leaseOwner` varchar(255),
	`leaseExpiresAt` timestamp,
	`availableAt` timestamp NOT NULL DEFAULT (now()),
	`deliveredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceOutbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `wo_event_idempotency_unique` UNIQUE(`eventType`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspacePublishItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`itemKey` varchar(255) NOT NULL,
	`episodeId` int,
	`sourceSha256` varchar(64) NOT NULL,
	`status` enum('pending','publishing','published','failed','skipped') NOT NULL DEFAULT 'pending',
	`providerReceipt` varchar(500),
	`errorClass` varchar(160),
	`version` int NOT NULL DEFAULT 1,
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspacePublishItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `wpi_run_item_unique` UNIQUE(`runId`,`itemKey`),
	CONSTRAINT `wpi_run_episode_source_unique` UNIQUE(`runId`,`episodeId`,`sourceSha256`)
);
--> statement-breakpoint
CREATE TABLE `workspacePublishRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`destinationId` int NOT NULL,
	`snapshotId` int NOT NULL,
	`checkerRunId` int,
	`status` enum('draft','validating','ready','publishing','published','partially_failed','failed','cancelled') NOT NULL DEFAULT 'draft',
	`idempotencyKey` varchar(255) NOT NULL,
	`expectedLastPublishedSha256` varchar(64),
	`version` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspacePublishRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `wpr_destination_idempotency_unique` UNIQUE(`destinationId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspacePublishingDestinations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`targetType` varchar(80) NOT NULL,
	`targetId` int NOT NULL,
	`status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
	`policyVersion` varchar(120) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspacePublishingDestinations_id` PRIMARY KEY(`id`),
	CONSTRAINT `wpd_novel_target_unique` UNIQUE(`workspaceNovelId`,`targetType`,`targetId`)
);
--> statement-breakpoint
ALTER TABLE `workspaceOutbox` ADD CONSTRAINT `wo_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceOutbox` ADD CONSTRAINT `wo_publish_run_fk` FOREIGN KEY (`publishRunId`) REFERENCES `workspacePublishRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishItems` ADD CONSTRAINT `wpi_run_fk` FOREIGN KEY (`runId`) REFERENCES `workspacePublishRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishItems` ADD CONSTRAINT `wpi_episode_fk` FOREIGN KEY (`episodeId`) REFERENCES `episodes`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishRuns` ADD CONSTRAINT `wpr_destination_fk` FOREIGN KEY (`destinationId`) REFERENCES `workspacePublishingDestinations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishRuns` ADD CONSTRAINT `wpr_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `workspaceDocumentSnapshots`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishRuns` ADD CONSTRAINT `wpr_checker_run_fk` FOREIGN KEY (`checkerRunId`) REFERENCES `workspaceCheckerRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishingDestinations` ADD CONSTRAINT `wpd_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wo_claim_idx` ON `workspaceOutbox` (`status`,`availableAt`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `wpi_status_idx` ON `workspacePublishItems` (`status`);--> statement-breakpoint
CREATE INDEX `wpr_status_started_idx` ON `workspacePublishRuns` (`status`,`startedAt`);--> statement-breakpoint
CREATE INDEX `wpd_status_idx` ON `workspacePublishingDestinations` (`status`);