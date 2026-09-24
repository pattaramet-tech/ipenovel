CREATE TABLE `workspaceEditorialDraftApprovals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`draftId` int NOT NULL,
	`draftVersion` int NOT NULL,
	`approvedDraftSha256` varchar(64) NOT NULL,
	`checkerRunId` int NOT NULL,
	`qcEvidenceSha256` varchar(64) NOT NULL,
	`payloadSha256` varchar(64) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`approvedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialDraftApprovals_id` PRIMARY KEY(`id`),
	CONSTRAINT `weda_item_idempotency_unique` UNIQUE(`workItemId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialEpisodeStages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`approvalId` int NOT NULL,
	`draftId` int NOT NULL,
	`stagedDraftSha256` varchar(64) NOT NULL,
	`qcEvidenceSha256` varchar(64) NOT NULL,
	`episodeId` int NOT NULL,
	`novelId` int NOT NULL,
	`episodeNumber` varchar(100) NOT NULL,
	`episodeTitle` varchar(500) NOT NULL,
	`contentSha256` varchar(64) NOT NULL,
	`episodeStateSha256` varchar(64) NOT NULL,
	`payloadSha256` varchar(64) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`stagedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialEpisodeStages_id` PRIMARY KEY(`id`),
	CONSTRAINT `wees_item_idempotency_unique` UNIQUE(`workItemId`,`idempotencyKey`),
	CONSTRAINT `wees_approval_unique` UNIQUE(`approvalId`)
);
--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftApprovals` ADD CONSTRAINT `weda_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftApprovals` ADD CONSTRAINT `weda_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftApprovals` ADD CONSTRAINT `weda_checker_run_fk` FOREIGN KEY (`checkerRunId`) REFERENCES `workspaceEditorialCheckerRuns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftApprovals` ADD CONSTRAINT `weda_approved_by_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_approval_fk` FOREIGN KEY (`approvalId`) REFERENCES `workspaceEditorialDraftApprovals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_episode_fk` FOREIGN KEY (`episodeId`) REFERENCES `episodes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_novel_fk` FOREIGN KEY (`novelId`) REFERENCES `novels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_staged_by_fk` FOREIGN KEY (`stagedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `weda_item_draft_idx` ON `workspaceEditorialDraftApprovals` (`workItemId`,`draftId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wees_item_created_idx` ON `workspaceEditorialEpisodeStages` (`workItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wees_episode_idx` ON `workspaceEditorialEpisodeStages` (`episodeId`,`createdAt`);