CREATE TABLE `workspaceDocumentFingerprints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bindingId` int NOT NULL,
	`snapshotId` int NOT NULL,
	`providerRevisionId` varchar(255) NOT NULL,
	`normalizedSha256` varchar(64) NOT NULL,
	`normalizationVersion` int NOT NULL,
	`lastPublishedSha256` varchar(64),
	`version` int NOT NULL DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceDocumentFingerprints_id` PRIMARY KEY(`id`),
	CONSTRAINT `wdf_binding_unique` UNIQUE(`bindingId`)
);
--> statement-breakpoint
ALTER TABLE `workspaceDocumentFingerprints` ADD CONSTRAINT `wdf_binding_fk` FOREIGN KEY (`bindingId`) REFERENCES `workspaceDocumentBindings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentFingerprints` ADD CONSTRAINT `wdf_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `workspaceDocumentSnapshots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wdf_normalized_hash_idx` ON `workspaceDocumentFingerprints` (`normalizedSha256`);--> statement-breakpoint
CREATE INDEX `wdf_last_published_hash_idx` ON `workspaceDocumentFingerprints` (`lastPublishedSha256`);