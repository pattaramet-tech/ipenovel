CREATE TABLE `accountMergeAuditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int,
	`actorAdminId` int,
	`action` varchar(32) NOT NULL,
	`sourceUserId` int,
	`targetUserId` int,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeAuditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeCases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`originAccountRecoveryRequestId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`status` enum('pending','in_progress','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`guardedSourceMarker` int GENERATED ALWAYS AS ((case when `status` <> 'cancelled' then `sourceUserId` else NULL end)) STORED,
	`createdByAdminId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`failedAt` timestamp,
	`failureReason` text,
	`cancelledAt` timestamp,
	`cancelReason` text,
	CONSTRAINT `accountMergeCases_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeCases_one_guarded_per_source_unique` UNIQUE(`guardedSourceMarker`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeDataDedupeRecords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`domain` varchar(40) NOT NULL,
	`sourceRowId` int NOT NULL,
	`targetRowId` int NOT NULL,
	`keySummary` varchar(255) NOT NULL,
	`safeMetadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeDataDedupeRecords_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeDataDedupeRecords_case_domain_source_unique` UNIQUE(`mergeCaseId`,`domain`,`sourceRowId`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeDataReconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`safeSummary` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeDataReconciliations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeDataReconciliations_mergeCaseId_unique` UNIQUE(`mergeCaseId`)
);
--> statement-breakpoint
CREATE TABLE `accountMergeFinancialReconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mergeCaseId` int NOT NULL,
	`sourceUserId` int NOT NULL,
	`targetUserId` int NOT NULL,
	`actorAdminId` int NOT NULL,
	`walletSourceBefore` decimal(12,2) NOT NULL,
	`walletTargetBefore` decimal(12,2) NOT NULL,
	`walletTransferred` decimal(12,2) NOT NULL,
	`walletSourceAfter` decimal(12,2) NOT NULL,
	`walletTargetAfter` decimal(12,2) NOT NULL,
	`pointsSourceBefore` decimal(10,2) NOT NULL,
	`pointsTargetBefore` decimal(10,2) NOT NULL,
	`pointsTransferred` decimal(10,2) NOT NULL,
	`pointsSourceAfter` decimal(10,2) NOT NULL,
	`pointsTargetAfter` decimal(10,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountMergeFinancialReconciliations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accountMergeFinancialReconciliations_mergeCaseId_unique` UNIQUE(`mergeCaseId`)
);
--> statement-breakpoint
CREATE TABLE `sportsCompetitionTeams` (
	`id` int AUTO_INCREMENT NOT NULL,
	`competitionId` int NOT NULL,
	`teamId` int NOT NULL,
	`displayOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sportsCompetitionTeams_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsCompetitionTeams_competition_team_unique` UNIQUE(`competitionId`,`teamId`)
);
--> statement-breakpoint
CREATE TABLE `sportsCompetitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(255) NOT NULL,
	`competitionType` enum('league','cup') NOT NULL DEFAULT 'league',
	`logoImageUrl` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsCompetitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsCompetitions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `sportsTeams` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(255) NOT NULL,
	`logoImageUrl` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sportsTeams_id` PRIMARY KEY(`id`),
	CONSTRAINT `sportsTeams_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
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
CREATE TABLE `workspaceGoogleConsentAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`stateHash` varchar(64) NOT NULL,
	`encryptedCodeVerifier` text NOT NULL,
	`keyVersion` int NOT NULL,
	`fixedRedirectUri` varchar(500) NOT NULL,
	`scope` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceGoogleConsentAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `wgca_state_hash_unique` UNIQUE(`stateHash`)
);
--> statement-breakpoint
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
ALTER TABLE `sportsMatchRewards` MODIFY COLUMN `couponId` int;--> statement-breakpoint
ALTER TABLE `sportsMatches` MODIFY COLUMN `rewardDiscountType` enum('flat','percentage');--> statement-breakpoint
ALTER TABLE `sportsMatches` MODIFY COLUMN `rewardDiscountValue` decimal(10,2);--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `rewardKind` enum('coupon','points') DEFAULT 'coupon' NOT NULL;--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `pointsAmount` decimal(10,2);--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD `pointsTransactionId` int;--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `competitionId` int;--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `homeTeamId` int;--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `awayTeamId` int;--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `rewardKind` enum('coupon','points') DEFAULT 'coupon' NOT NULL;--> statement-breakpoint
ALTER TABLE `sportsMatches` ADD `rewardPointsAmount` decimal(10,2);--> statement-breakpoint
ALTER TABLE `sportsMatchRewards` ADD CONSTRAINT `unique_sports_match_rewards_points_tx` UNIQUE(`pointsTransactionId`);--> statement-breakpoint
ALTER TABLE `workspaceAuditEvents` ADD CONSTRAINT `wae_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAuditEvents` ADD CONSTRAINT `wae_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentBindings` ADD CONSTRAINT `wdb_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentBindings` ADD CONSTRAINT `wdb_document_fk` FOREIGN KEY (`documentId`) REFERENCES `workspaceDocuments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocumentSnapshots` ADD CONSTRAINT `wds_document_fk` FOREIGN KEY (`documentId`) REFERENCES `workspaceDocuments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceDocuments` ADD CONSTRAINT `wd_connection_fk` FOREIGN KEY (`connectionId`) REFERENCES `workspaceGoogleConnections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceGoogleConnections` ADD CONSTRAINT `wgc_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceGoogleConsentAttempts` ADD CONSTRAINT `wgca_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMembers` ADD CONSTRAINT `workspaceMembers_workspaceId_workspaceWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMembers` ADD CONSTRAINT `workspaceMembers_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMigrationRegistry` ADD CONSTRAINT `wmr_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceMigrationRegistry` ADD CONSTRAINT `workspaceMigrationRegistry_changedBy_users_id_fk` FOREIGN KEY (`changedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceNovels` ADD CONSTRAINT `workspaceNovels_workspaceId_workspaceWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceNovels` ADD CONSTRAINT `workspaceNovels_novelId_novels_id_fk` FOREIGN KEY (`novelId`) REFERENCES `novels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceReadOnlyBindings` ADD CONSTRAINT `wrob_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceWorkspaces` ADD CONSTRAINT `workspaceWorkspaces_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_mergeCaseId_idx` ON `accountMergeAuditLogs` (`mergeCaseId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_sourceUserId_idx` ON `accountMergeAuditLogs` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_targetUserId_idx` ON `accountMergeAuditLogs` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeAuditLogs_createdAt_idx` ON `accountMergeAuditLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_originAccountRecoveryRequestId_idx` ON `accountMergeCases` (`originAccountRecoveryRequestId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_sourceUserId_idx` ON `accountMergeCases` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_targetUserId_idx` ON `accountMergeCases` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeCases_status_idx` ON `accountMergeCases` (`status`);--> statement-breakpoint
CREATE INDEX `accountMergeDataDedupeRecords_mergeCaseId_idx` ON `accountMergeDataDedupeRecords` (`mergeCaseId`);--> statement-breakpoint
CREATE INDEX `accountMergeDataReconciliations_sourceUserId_idx` ON `accountMergeDataReconciliations` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeDataReconciliations_targetUserId_idx` ON `accountMergeDataReconciliations` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeFinancialReconciliations_sourceUserId_idx` ON `accountMergeFinancialReconciliations` (`sourceUserId`);--> statement-breakpoint
CREATE INDEX `accountMergeFinancialReconciliations_targetUserId_idx` ON `accountMergeFinancialReconciliations` (`targetUserId`);--> statement-breakpoint
CREATE INDEX `sportsCompetitionTeams_competitionId_idx` ON `sportsCompetitionTeams` (`competitionId`);--> statement-breakpoint
CREATE INDEX `sportsCompetitionTeams_teamId_idx` ON `sportsCompetitionTeams` (`teamId`);--> statement-breakpoint
CREATE INDEX `sportsCompetitions_name_idx` ON `sportsCompetitions` (`name`);--> statement-breakpoint
CREATE INDEX `sportsCompetitions_isActive_idx` ON `sportsCompetitions` (`isActive`);--> statement-breakpoint
CREATE INDEX `sportsTeams_name_idx` ON `sportsTeams` (`name`);--> statement-breakpoint
CREATE INDEX `sportsTeams_isActive_idx` ON `sportsTeams` (`isActive`);--> statement-breakpoint
CREATE INDEX `wae_workspace_created_idx` ON `workspaceAuditEvents` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wae_entity_created_idx` ON `workspaceAuditEvents` (`entityType`,`entityId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `wae_correlation_idx` ON `workspaceAuditEvents` (`correlationId`);--> statement-breakpoint
CREATE INDEX `wdb_document_status_idx` ON `workspaceDocumentBindings` (`documentId`,`status`);--> statement-breakpoint
CREATE INDEX `wds_document_observed_idx` ON `workspaceDocumentSnapshots` (`documentId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `wd_connection_status_idx` ON `workspaceDocuments` (`connectionId`,`status`);--> statement-breakpoint
CREATE INDEX `wgc_status_expiry_idx` ON `workspaceGoogleConnections` (`status`,`tokenExpiresAt`);--> statement-breakpoint
CREATE INDEX `wgca_user_expiry_idx` ON `workspaceGoogleConsentAttempts` (`userId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `workspaceMembers_user_status_idx` ON `workspaceMembers` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `workspaceMigrationRegistry_owner_capability_idx` ON `workspaceMigrationRegistry` (`owner`,`capability`);--> statement-breakpoint
CREATE INDEX `workspaceNovels_novel_status_idx` ON `workspaceNovels` (`novelId`,`status`);--> statement-breakpoint
CREATE INDEX `workspaceWorkspaces_owner_status_idx` ON `workspaceWorkspaces` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `sportsMatches_competitionId_idx` ON `sportsMatches` (`competitionId`);--> statement-breakpoint
CREATE INDEX `sportsMatches_homeTeamId_idx` ON `sportsMatches` (`homeTeamId`);--> statement-breakpoint
CREATE INDEX `sportsMatches_awayTeamId_idx` ON `sportsMatches` (`awayTeamId`);