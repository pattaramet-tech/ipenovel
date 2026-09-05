CREATE TABLE `workspaceMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','editor','reviewer','viewer') NOT NULL,
	`status` enum('active','invited','suspended','removed') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceMembers_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaceMembers_workspace_user_unique` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `workspaceMigrationRegistry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`capability` enum('kanban','checker','ai_queue','export','publish') NOT NULL,
	`owner` enum('sheets','workspace','paused') NOT NULL DEFAULT 'sheets',
	`cutoverEpoch` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`changedAt` timestamp NOT NULL DEFAULT (now()),
	`changedBy` int,
	CONSTRAINT `workspaceMigrationRegistry_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaceMigrationRegistry_workspaceNovel_capability_unique` UNIQUE(`workspaceNovelId`,`capability`)
);
--> statement-breakpoint
CREATE TABLE `workspaceNovels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`novelId` int NOT NULL,
	`status` enum('active','paused','unlinked') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceNovels_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaceNovels_workspace_novel_unique` UNIQUE(`workspaceId`,`novelId`)
);
--> statement-breakpoint
CREATE TABLE `workspaceReadOnlyBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`sourceKind` enum('synthetic') NOT NULL DEFAULT 'synthetic',
	`sourceKey` varchar(255) NOT NULL,
	`displayName` varchar(500) NOT NULL,
	`role` enum('source','chapter','glossary','reference') NOT NULL DEFAULT 'source',
	`sequence` int NOT NULL DEFAULT 1,
	`status` enum('active','paused','removed') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceReadOnlyBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaceReadOnlyBindings_novel_source_unique` UNIQUE(`workspaceNovelId`,`sourceKind`,`sourceKey`),
	CONSTRAINT `workspaceReadOnlyBindings_novel_role_sequence_unique` UNIQUE(`workspaceNovelId`,`role`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `workspaceWorkspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`status` enum('active','suspended','archived') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deletedAt` timestamp,
	CONSTRAINT `workspaceWorkspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workspaceMembers` ADD CONSTRAINT `workspaceMembers_workspaceId_workspaceWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMembers` ADD CONSTRAINT `workspaceMembers_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMigrationRegistry` ADD CONSTRAINT `wmr_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMigrationRegistry` ADD CONSTRAINT `workspaceMigrationRegistry_changedBy_users_id_fk` FOREIGN KEY (`changedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceNovels` ADD CONSTRAINT `workspaceNovels_workspaceId_workspaceWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceNovels` ADD CONSTRAINT `workspaceNovels_novelId_novels_id_fk` FOREIGN KEY (`novelId`) REFERENCES `novels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceReadOnlyBindings` ADD CONSTRAINT `wrob_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceWorkspaces` ADD CONSTRAINT `workspaceWorkspaces_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workspaceMembers_user_status_idx` ON `workspaceMembers` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `workspaceMigrationRegistry_owner_capability_idx` ON `workspaceMigrationRegistry` (`owner`,`capability`);--> statement-breakpoint
CREATE INDEX `workspaceNovels_novel_status_idx` ON `workspaceNovels` (`novelId`,`status`);--> statement-breakpoint
CREATE INDEX `workspaceWorkspaces_owner_status_idx` ON `workspaceWorkspaces` (`ownerUserId`,`status`);