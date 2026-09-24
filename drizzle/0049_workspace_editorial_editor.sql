CREATE TABLE `workspaceEditorialDraftEditEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`fromDraftId` int NOT NULL,
	`toDraftId` int NOT NULL,
	`editKind` enum('replace_sentence','replace_range','replace_paragraph','undo') NOT NULL,
	`paragraphKey` varchar(64),
	`findingKey` varchar(64),
	`startOffset` int,
	`endOffset` int,
	`expectedTextSha256` varchar(64) NOT NULL,
	`replacementTextSha256` varchar(64) NOT NULL,
	`payloadSha256` varchar(64) NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`actorUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialDraftEditEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `wede_item_idempotency_unique` UNIQUE(`workItemId`,`idempotencyKey`),
	CONSTRAINT `wede_to_draft_unique` UNIQUE(`toDraftId`)
);
--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftEditEvents` ADD CONSTRAINT `wede_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftEditEvents` ADD CONSTRAINT `wede_from_draft_fk` FOREIGN KEY (`fromDraftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftEditEvents` ADD CONSTRAINT `wede_to_draft_fk` FOREIGN KEY (`toDraftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftEditEvents` ADD CONSTRAINT `wede_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wede_item_created_idx` ON `workspaceEditorialDraftEditEvents` (`workItemId`,`createdAt`);