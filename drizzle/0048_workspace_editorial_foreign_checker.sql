CREATE TABLE `workspaceEditorialCheckerAllowWords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`normalizedWord` varchar(500) NOT NULL,
	`displayWord` varchar(500) NOT NULL,
	`status` enum('active','removed') NOT NULL DEFAULT 'active',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceEditorialCheckerAllowWords_id` PRIMARY KEY(`id`),
	CONSTRAINT `wecaw_workspace_word_unique` UNIQUE(`workspaceId`,`normalizedWord`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialCheckerFindingStates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`findingKey` varchar(64) NOT NULL,
	`disposition` enum('open','accepted','fixed','ignored') NOT NULL DEFAULT 'open',
	`note` text NOT NULL,
	`actorUserId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceEditorialCheckerFindingStates_id` PRIMARY KEY(`id`),
	CONSTRAINT `wecfs_item_finding_unique` UNIQUE(`workItemId`,`findingKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialCheckerFindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`findingKey` varchar(64) NOT NULL,
	`ruleKey` varchar(80) NOT NULL,
	`severity` enum('info','warning','error') NOT NULL,
	`sourceTabId` varchar(255) NOT NULL,
	`tabTitle` varchar(500) NOT NULL,
	`paragraphKey` varchar(64) NOT NULL,
	`paragraphOrder` int NOT NULL,
	`paragraphFingerprint` varchar(64) NOT NULL,
	`offsetEncoding` varchar(16) NOT NULL,
	`startOffset` int NOT NULL,
	`endOffset` int NOT NULL,
	`token` mediumtext NOT NULL,
	`normalizedToken` mediumtext NOT NULL,
	`sentenceStartOffset` int NOT NULL,
	`sentenceEndOffset` int NOT NULL,
	`sentenceText` mediumtext NOT NULL,
	`contextText` mediumtext NOT NULL,
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialCheckerFindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `wecf_run_finding_unique` UNIQUE(`runId`,`findingKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialCheckerResolutionEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`findingKey` varchar(64) NOT NULL,
	`fromDisposition` enum('open','accepted','fixed','ignored'),
	`toDisposition` enum('open','accepted','fixed','ignored') NOT NULL,
	`note` text NOT NULL,
	`actorUserId` int NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialCheckerResolutionEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `wecre_item_idempotency_unique` UNIQUE(`workItemId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialCheckerRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`draftId` int NOT NULL,
	`engineVersion` varchar(120) NOT NULL,
	`allowListSha256` varchar(64) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`status` enum('passed','failed') NOT NULL,
	`findingCount` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialCheckerRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `wecr_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerAllowWords` ADD CONSTRAINT `wecaw_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerAllowWords` ADD CONSTRAINT `wecaw_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerFindingStates` ADD CONSTRAINT `wecfs_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerFindingStates` ADD CONSTRAINT `wecfs_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerFindings` ADD CONSTRAINT `wecf_run_fk` FOREIGN KEY (`runId`) REFERENCES `workspaceEditorialCheckerRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerResolutionEvents` ADD CONSTRAINT `wecre_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerResolutionEvents` ADD CONSTRAINT `wecre_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerRuns` ADD CONSTRAINT `wecr_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerRuns` ADD CONSTRAINT `wecr_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialCheckerRuns` ADD CONSTRAINT `wecr_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wecaw_workspace_status_idx` ON `workspaceEditorialCheckerAllowWords` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `wecfs_item_disposition_idx` ON `workspaceEditorialCheckerFindingStates` (`workItemId`,`disposition`);--> statement-breakpoint
CREATE INDEX `wecf_run_paragraph_idx` ON `workspaceEditorialCheckerFindings` (`runId`,`paragraphKey`,`startOffset`);--> statement-breakpoint
CREATE INDEX `wecre_item_created_idx` ON `workspaceEditorialCheckerResolutionEvents` (`workItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wecr_work_item_created_idx` ON `workspaceEditorialCheckerRuns` (`workItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wecr_draft_idx` ON `workspaceEditorialCheckerRuns` (`draftId`);