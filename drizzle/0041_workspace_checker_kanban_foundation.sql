CREATE TABLE `workspaceCheckerFindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`ruleKey` varchar(160) NOT NULL,
	`severity` enum('info','warning','error') NOT NULL,
	`locationKey` varchar(255) NOT NULL,
	`excerptSha256` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`disposition` enum('open','accepted','fixed','ignored') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceCheckerFindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `wcf_run_rule_location_excerpt_unique` UNIQUE(`runId`,`ruleKey`,`locationKey`,`excerptSha256`)
);
--> statement-breakpoint
CREATE TABLE `workspaceCheckerRuleSets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`versionNo` int NOT NULL,
	`contentSha256` varchar(64) NOT NULL,
	`engineVersion` varchar(120) NOT NULL,
	`rulesJson` text NOT NULL,
	`status` enum('published','retired') NOT NULL DEFAULT 'published',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceCheckerRuleSets_id` PRIMARY KEY(`id`),
	CONSTRAINT `wcrs_workspace_name_version_unique` UNIQUE(`workspaceId`,`name`,`versionNo`),
	CONSTRAINT `wcrs_workspace_hash_unique` UNIQUE(`workspaceId`,`contentSha256`)
);
--> statement-breakpoint
CREATE TABLE `workspaceCheckerRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`snapshotId` int NOT NULL,
	`ruleSetId` int NOT NULL,
	`engineVersion` varchar(120) NOT NULL,
	`status` enum('queued','running','passed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`idempotencyKey` varchar(255) NOT NULL,
	`leaseOwner` varchar(255),
	`leaseExpiresAt` timestamp,
	`version` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceCheckerRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `wcr_snapshot_rule_engine_unique` UNIQUE(`snapshotId`,`ruleSetId`,`engineVersion`),
	CONSTRAINT `wcr_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceKanbanBoards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`slug` varchar(120) NOT NULL,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceKanbanBoards_id` PRIMARY KEY(`id`),
	CONSTRAINT `wkb_workspace_slug_unique` UNIQUE(`workspaceId`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `workspaceKanbanCards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`boardId` int NOT NULL,
	`columnId` int NOT NULL,
	`bindingId` int,
	`logicalItemKey` varchar(255) NOT NULL,
	`rank` int NOT NULL DEFAULT 0,
	`status` enum('active','blocked','done','archived') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceKanbanCards_id` PRIMARY KEY(`id`),
	CONSTRAINT `wkcard_board_logical_key_unique` UNIQUE(`boardId`,`logicalItemKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceKanbanColumns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`boardId` int NOT NULL,
	`key` varchar(80) NOT NULL,
	`name` varchar(160) NOT NULL,
	`position` int NOT NULL,
	`wipLimit` int,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceKanbanColumns_id` PRIMARY KEY(`id`),
	CONSTRAINT `wkc_board_key_unique` UNIQUE(`boardId`,`key`),
	CONSTRAINT `wkc_board_position_unique` UNIQUE(`boardId`,`position`)
);
--> statement-breakpoint
CREATE TABLE `workspaceKanbanTransitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cardId` int NOT NULL,
	`fromColumnId` int,
	`toColumnId` int NOT NULL,
	`actorUserId` int NOT NULL,
	`reason` varchar(500) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceKanbanTransitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `wkt_card_idempotency_unique` UNIQUE(`cardId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceCheckerFindings` ADD CONSTRAINT `wcf_run_fk` FOREIGN KEY (`runId`) REFERENCES `workspaceCheckerRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceCheckerRuleSets` ADD CONSTRAINT `wcrs_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceCheckerRuns` ADD CONSTRAINT `wcr_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `workspaceDocumentSnapshots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceCheckerRuns` ADD CONSTRAINT `wcr_rule_set_fk` FOREIGN KEY (`ruleSetId`) REFERENCES `workspaceCheckerRuleSets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanBoards` ADD CONSTRAINT `wkb_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanCards` ADD CONSTRAINT `wkcard_board_fk` FOREIGN KEY (`boardId`) REFERENCES `workspaceKanbanBoards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanCards` ADD CONSTRAINT `wkcard_column_fk` FOREIGN KEY (`columnId`) REFERENCES `workspaceKanbanColumns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanCards` ADD CONSTRAINT `wkcard_binding_fk` FOREIGN KEY (`bindingId`) REFERENCES `workspaceDocumentBindings`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanColumns` ADD CONSTRAINT `wkc_board_fk` FOREIGN KEY (`boardId`) REFERENCES `workspaceKanbanBoards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanTransitions` ADD CONSTRAINT `wkt_card_fk` FOREIGN KEY (`cardId`) REFERENCES `workspaceKanbanCards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanTransitions` ADD CONSTRAINT `wkt_from_column_fk` FOREIGN KEY (`fromColumnId`) REFERENCES `workspaceKanbanColumns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanTransitions` ADD CONSTRAINT `wkt_to_column_fk` FOREIGN KEY (`toColumnId`) REFERENCES `workspaceKanbanColumns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceKanbanTransitions` ADD CONSTRAINT `wkt_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wcf_run_severity_idx` ON `workspaceCheckerFindings` (`runId`,`severity`);--> statement-breakpoint
CREATE INDEX `wcr_claim_idx` ON `workspaceCheckerRuns` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `wkb_workspace_status_idx` ON `workspaceKanbanBoards` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `wkcard_column_rank_idx` ON `workspaceKanbanCards` (`columnId`,`rank`);--> statement-breakpoint
CREATE INDEX `wkt_card_created_idx` ON `workspaceKanbanTransitions` (`cardId`,`createdAt`);