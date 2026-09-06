CREATE TABLE `workspaceAuditEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`actorUserId` int,
	`eventType` varchar(120) NOT NULL,
	`entityType` varchar(120) NOT NULL,
	`entityId` varchar(255) NOT NULL,
	`correlationId` varchar(255) NOT NULL,
	`metadataJson` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceAuditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaceDocumentBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceNovelId` int NOT NULL,
	`documentId` int NOT NULL,
	`role` enum('source','chapter','glossary','reference') NOT NULL DEFAULT 'source',
	`sequence` int NOT NULL DEFAULT 1,
	`status` enum('active','paused','removed') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceDocumentBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `wdb_novel_document_role_unique` UNIQUE(`workspaceNovelId`,`documentId`,`role`),
	CONSTRAINT `wdb_novel_role_sequence_unique` UNIQUE(`workspaceNovelId`,`role`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `workspaceDocumentSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`documentId` int NOT NULL,
	`providerRevisionId` varchar(255) NOT NULL,
	`normalizedSha256` varchar(64) NOT NULL,
	`normalizationVersion` int NOT NULL,
	`byteLength` int NOT NULL,
	`observedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceDocumentSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `wds_document_revision_unique` UNIQUE(`documentId`,`providerRevisionId`),
	CONSTRAINT `wds_document_hash_version_unique` UNIQUE(`documentId`,`normalizedSha256`,`normalizationVersion`)
);
--> statement-breakpoint
CREATE TABLE `workspaceDocuments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`connectionId` int NOT NULL,
	`providerFileId` varchar(255) NOT NULL,
	`mimeType` varchar(160) NOT NULL,
	`titleCache` varchar(500) NOT NULL,
	`status` enum('active','inaccessible','deleted','unbound') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`lastObservedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceDocuments_id` PRIMARY KEY(`id`),
	CONSTRAINT `wd_connection_file_unique` UNIQUE(`connectionId`,`providerFileId`)
);
--> statement-breakpoint
CREATE TABLE `workspaceGoogleConnections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`providerSubject` varchar(255) NOT NULL,
	`encryptedRefreshToken` text,
	`keyVersion` int NOT NULL,
	`grantedScopes` text NOT NULL,
	`tokenExpiresAt` timestamp,
	`status` enum('active','reconnect_required','revoked') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`lastUsedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaceGoogleConnections_id` PRIMARY KEY(`id`),
	CONSTRAINT `wgc_user_subject_unique` UNIQUE(`userId`,`providerSubject`)
);
--> statement-breakpoint
ALTER TABLE `workspaceAuditEvents` ADD CONSTRAINT `wae_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAuditEvents` ADD CONSTRAINT `wae_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentBindings` ADD CONSTRAINT `wdb_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentBindings` ADD CONSTRAINT `wdb_document_fk` FOREIGN KEY (`documentId`) REFERENCES `workspaceDocuments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentSnapshots` ADD CONSTRAINT `wds_document_fk` FOREIGN KEY (`documentId`) REFERENCES `workspaceDocuments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocuments` ADD CONSTRAINT `wd_connection_fk` FOREIGN KEY (`connectionId`) REFERENCES `workspaceGoogleConnections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceGoogleConnections` ADD CONSTRAINT `wgc_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wae_workspace_created_idx` ON `workspaceAuditEvents` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wae_entity_created_idx` ON `workspaceAuditEvents` (`entityType`,`entityId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wae_correlation_idx` ON `workspaceAuditEvents` (`correlationId`);--> statement-breakpoint
CREATE INDEX `wdb_document_status_idx` ON `workspaceDocumentBindings` (`documentId`,`status`);--> statement-breakpoint
CREATE INDEX `wds_document_observed_idx` ON `workspaceDocumentSnapshots` (`documentId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `wd_connection_status_idx` ON `workspaceDocuments` (`connectionId`,`status`);--> statement-breakpoint
CREATE INDEX `wgc_status_expiry_idx` ON `workspaceGoogleConnections` (`status`,`tokenExpiresAt`);