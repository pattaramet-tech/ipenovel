CREATE TABLE `workspaceEditorialWorkItemEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`eventType` enum('created','backfilled','assignee_changed') NOT NULL,
	`actorUserId` int NOT NULL,
	`fromAssigneeUserId` int,
	`toAssigneeUserId` int,
	`idempotencyKey` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialWorkItemEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `weie_item_idempotency_unique` UNIQUE(`workItemId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialWorkItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cardId` int NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`workItemType` enum('new_story','new_episode') NOT NULL,
	`itemKey` varchar(160) NOT NULL,
	`episodeNumber` varchar(100),
	`episodeTitle` varchar(500),
	`assigneeUserId` int,
	`createdByUserId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceEditorialWorkItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `wei_card_unique` UNIQUE(`cardId`),
	CONSTRAINT `wei_novel_type_item_unique` UNIQUE(`workspaceNovelId`,`workItemType`,`itemKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItemEvents` ADD CONSTRAINT `weie_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItemEvents` ADD CONSTRAINT `weie_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItemEvents` ADD CONSTRAINT `weie_from_assignee_fk` FOREIGN KEY (`fromAssigneeUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItemEvents` ADD CONSTRAINT `weie_to_assignee_fk` FOREIGN KEY (`toAssigneeUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD CONSTRAINT `wei_card_fk` FOREIGN KEY (`cardId`) REFERENCES `workspaceKanbanCards`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD CONSTRAINT `wei_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD CONSTRAINT `wei_assignee_fk` FOREIGN KEY (`assigneeUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD CONSTRAINT `wei_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `weie_item_created_idx` ON `workspaceEditorialWorkItemEvents` (`workItemId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `wei_novel_idx` ON `workspaceEditorialWorkItems` (`workspaceNovelId`);
--> statement-breakpoint
CREATE INDEX `wei_assignee_idx` ON `workspaceEditorialWorkItems` (`assigneeUserId`);
