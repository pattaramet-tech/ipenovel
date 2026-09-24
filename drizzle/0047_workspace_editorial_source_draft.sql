CREATE TABLE `workspaceEditorialDraftParagraphs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftTabId` int NOT NULL,
	`paragraphKey` varchar(64) NOT NULL,
	`sourceParagraphIndex` int NOT NULL,
	`paragraphOrder` int NOT NULL,
	`text` mediumtext NOT NULL,
	`sourceParagraphFingerprint` varchar(64) NOT NULL,
	`sourceOccurrenceCount` int NOT NULL,
	`sourceOccurrenceOrdinal` int NOT NULL,
	`paragraphFingerprint` varchar(64) NOT NULL,
	`occurrenceCount` int NOT NULL,
	`occurrenceOrdinal` int NOT NULL,
	CONSTRAINT `workspaceEditorialDraftParagraphs_id` PRIMARY KEY(`id`),
	CONSTRAINT `wedp_draft_order_unique` UNIQUE(`draftTabId`,`paragraphOrder`),
	CONSTRAINT `wedp_draft_paragraph_key_unique` UNIQUE(`draftTabId`,`paragraphKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialDraftTabs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftId` int NOT NULL,
	`sourceTabId` varchar(255) NOT NULL,
	`tabOrder` int NOT NULL,
	`title` varchar(500) NOT NULL,
	`fingerprintSequenceJson` mediumtext NOT NULL,
	`structuralSha256` varchar(64) NOT NULL,
	`chapterNumber` varchar(100),
	`chapterTitle` varchar(500),
	`warningsJson` text NOT NULL,
	CONSTRAINT `workspaceEditorialDraftTabs_id` PRIMARY KEY(`id`),
	CONSTRAINT `wedt_draft_tab_unique` UNIQUE(`draftId`,`sourceTabId`),
	CONSTRAINT `wedt_draft_order_unique` UNIQUE(`draftId`,`tabOrder`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialDraftTransforms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftId` int NOT NULL,
	`parentDraftId` int,
	`transformCode` varchar(100) NOT NULL,
	`beforeSha256` varchar(64),
	`afterSha256` varchar(64) NOT NULL,
	`detailsJson` text NOT NULL,
	`actorUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialDraftTransforms_id` PRIMARY KEY(`id`),
	CONSTRAINT `wedx_draft_unique` UNIQUE(`draftId`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialDrafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`sourceSnapshotId` int NOT NULL,
	`parentDraftId` int,
	`version` int NOT NULL,
	`origin` enum('source_import','source_refresh','manual') NOT NULL,
	`transformCode` varchar(100) NOT NULL,
	`draftSha256` varchar(64) NOT NULL,
	`presentationJson` text NOT NULL,
	`warningsJson` text NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialDrafts_id` PRIMARY KEY(`id`),
	CONSTRAINT `wed_work_item_version_unique` UNIQUE(`workItemId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialSourceSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceId` int NOT NULL,
	`revisionKey` varchar(255) NOT NULL,
	`sourceSha256` varchar(64) NOT NULL,
	`rawContentJson` mediumtext NOT NULL,
	`byteLength` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceEditorialSourceSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `wess_source_revision_unique` UNIQUE(`sourceId`,`revisionKey`)
);
--> statement-breakpoint
CREATE TABLE `workspaceEditorialSources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workItemId` int NOT NULL,
	`sourceKind` enum('google_doc','uploaded_file') NOT NULL,
	`sourceKey` varchar(255) NOT NULL,
	`providerDocumentId` varchar(255),
	`mimeType` varchar(160) NOT NULL,
	`title` varchar(500) NOT NULL,
	`status` enum('active','removed') NOT NULL DEFAULT 'active',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceEditorialSources_id` PRIMARY KEY(`id`),
	CONSTRAINT `wes_item_source_unique` UNIQUE(`workItemId`,`sourceKind`,`sourceKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftParagraphs` ADD CONSTRAINT `wedp_draft_tab_fk` FOREIGN KEY (`draftTabId`) REFERENCES `workspaceEditorialDraftTabs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftTabs` ADD CONSTRAINT `wedt_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftTransforms` ADD CONSTRAINT `wedx_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDraftTransforms` ADD CONSTRAINT `wedx_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDrafts` ADD CONSTRAINT `wed_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDrafts` ADD CONSTRAINT `wed_source_snapshot_fk` FOREIGN KEY (`sourceSnapshotId`) REFERENCES `workspaceEditorialSourceSnapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialDrafts` ADD CONSTRAINT `wed_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialSourceSnapshots` ADD CONSTRAINT `wess_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `workspaceEditorialSources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialSourceSnapshots` ADD CONSTRAINT `wess_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialSources` ADD CONSTRAINT `wes_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceEditorialSources` ADD CONSTRAINT `wes_created_by_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wedp_fingerprint_idx` ON `workspaceEditorialDraftParagraphs` (`paragraphFingerprint`);--> statement-breakpoint
CREATE INDEX `wedp_source_fingerprint_idx` ON `workspaceEditorialDraftParagraphs` (`sourceParagraphFingerprint`);--> statement-breakpoint
CREATE INDEX `wed_work_item_created_idx` ON `workspaceEditorialDrafts` (`workItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wed_hash_idx` ON `workspaceEditorialDrafts` (`draftSha256`);--> statement-breakpoint
CREATE INDEX `wess_source_hash_idx` ON `workspaceEditorialSourceSnapshots` (`sourceId`,`sourceSha256`);--> statement-breakpoint
CREATE INDEX `wess_source_created_idx` ON `workspaceEditorialSourceSnapshots` (`sourceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wes_work_item_idx` ON `workspaceEditorialSources` (`workItemId`,`status`);