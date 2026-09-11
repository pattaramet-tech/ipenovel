CREATE TABLE `workspacePublishOwnershipTransitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`publishRunId` int NOT NULL,
	`direction` enum('cutover','rollback') NOT NULL,
	`fromOwner` enum('sheets','workspace') NOT NULL,
	`toOwner` enum('sheets','workspace') NOT NULL,
	`fromEpoch` int NOT NULL,
	`toEpoch` int NOT NULL,
	`fromVersion` int NOT NULL,
	`toVersion` int NOT NULL,
	`readinessDigest` varchar(64) NOT NULL,
	`idempotencyKey` varchar(64) NOT NULL,
	`actorUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspacePublishOwnershipTransitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `wpot_idempotency_unique` UNIQUE(`workspaceNovelId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceOutbox` ADD `ownershipEpoch` int;--> statement-breakpoint
ALTER TABLE `workspacePublishOwnershipTransitions` ADD CONSTRAINT `wpot_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishOwnershipTransitions` ADD CONSTRAINT `wpot_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishOwnershipTransitions` ADD CONSTRAINT `wpot_publish_run_fk` FOREIGN KEY (`publishRunId`) REFERENCES `workspacePublishRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspacePublishOwnershipTransitions` ADD CONSTRAINT `wpot_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wpot_workspace_novel_created_idx` ON `workspacePublishOwnershipTransitions` (`workspaceNovelId`,`createdAt`);