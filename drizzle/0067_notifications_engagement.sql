-- PAT-15–30 Notifications & Engagement. Additive schema candidate only.
-- Registered in drizzle/meta/_journal.json as tag 0067_notifications_engagement (idx 67, when 1791800000000; idx 66 stays reserved for main lineage 0066_reader_session_controls on reconciliation).
-- Requires main/PAT-5 reconciliation, user-reference lifecycle classification,
-- disposable-DB qualification and explicit Staging-first migration approval.
-- No historical backfill; all producers and delivery remain OFF by default.
-- Rollback ONLY after every app/worker referencing these tables is disabled,
-- drained and verified: drop notificationDigestMemberships, notificationDigestBatches,
-- notificationDigestEpisodes, notificationPublicationMarkers,
-- notificationBulkOperations, notificationPreferences, notificationRecipients,
-- notificationOutbox, notificationEvents, notificationSequence (in that order).
-- Do not automatically drop any user notification data.

CREATE TABLE `notificationEvents` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `eventKey` varchar(384) NOT NULL,
  `kind` varchar(64) NOT NULL,
  `sourceType` varchar(96) NOT NULL,
  `sourceId` varchar(96) NOT NULL,
  `transitionKey` varchar(96) NOT NULL,
  `targetUserId` int NULL,
  `eligibleAfter` timestamp NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationEvents_eventKey_uq` (`eventKey`),
  KEY `notificationEvents_kind_occurredAt_idx` (`kind`,`occurredAt`),
  KEY `notificationEvents_targetUserId_idx` (`targetUserId`)
);
--> statement-breakpoint
CREATE TABLE `notificationOutbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `eventId` bigint unsigned NOT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'pending',
  `attempt` int NOT NULL DEFAULT 0,
  `nextAttemptAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `leaseToken` varchar(96) NULL,
  `leasedUntil` timestamp NULL,
  `audienceCursor` varchar(255) NULL,
  `lastFailureCode` varchar(48) NULL,
  `completedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationOutbox_eventId_uq` (`eventId`),
  KEY `notificationOutbox_state_nextAttemptAt_idx` (`state`,`nextAttemptAt`,`id`),
  KEY `notificationOutbox_state_leasedUntil_idx` (`state`,`leasedUntil`)
);
--> statement-breakpoint
CREATE TABLE `notificationRecipients` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `eventId` bigint unsigned NOT NULL,
  `userId` int NOT NULL,
  `receivedSequence` bigint unsigned NOT NULL,
  `category` varchar(24) NOT NULL,
  `readAt` timestamp NULL,
  `dismissedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationRecipients_event_user_uq` (`eventId`,`userId`),
  UNIQUE KEY `notificationRecipients_receivedSequence_uq` (`receivedSequence`),
  KEY `notificationRecipients_user_category_id_idx` (`userId`,`category`,`id`),
  KEY `notificationRecipients_user_sequence_idx` (`userId`,`receivedSequence`),
  KEY `notificationRecipients_user_dismissed_read_idx` (`userId`,`dismissedAt`,`readAt`)
);
--> statement-breakpoint
CREATE TABLE `notificationPreferences` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `kind` varchar(64) NOT NULL,
  `enabled` boolean NOT NULL,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationPreferences_user_kind_uq` (`userId`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `notificationBulkOperations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `actorUserId` int NOT NULL,
  `operationKey` varchar(96) NOT NULL,
  `kind` varchar(24) NOT NULL,
  `cutoffSequence` bigint unsigned NOT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'pending',
  `affected` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt` timestamp NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationBulkOperations_actor_key_uq` (`actorUserId`,`operationKey`),
  KEY `notificationBulkOperations_actor_created_idx` (`actorUserId`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE `notificationSequence` (
  `id` int NOT NULL,
  `nextSequence` bigint unsigned NOT NULL,
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
INSERT INTO `notificationSequence` (`id`,`nextSequence`) VALUES (1,1);
--> statement-breakpoint
CREATE TABLE `notificationPublicationMarkers` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `entityType` varchar(24) NOT NULL,
  `entityId` bigint unsigned NOT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'published',
  `firstPublishedAt` timestamp NULL,
  `firstEventId` bigint unsigned NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationPublicationMarkers_type_entity_uq` (`entityType`,`entityId`)
);
--> statement-breakpoint
CREATE TABLE `notificationDigestEpisodes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `eventId` bigint unsigned NOT NULL,
  `episodeId` bigint unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationDigestEpisodes_event_episode_uq` (`eventId`,`episodeId`)
);
--> statement-breakpoint
CREATE TABLE `notificationDigestBatches` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batchKey` varchar(96) NOT NULL,
  `novelId` int NOT NULL,
  `sourceIdentity` varchar(160) NOT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'collecting',
  `watermarkAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `finalizedAt` timestamp NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationDigestBatches_batchKey_uq` (`batchKey`),
  KEY `notificationDigestBatches_state_created_idx` (`state`,`createdAt`),
  KEY `notificationDigestBatches_novel_idx` (`novelId`)
);
--> statement-breakpoint
CREATE TABLE `notificationDigestMemberships` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batchId` bigint unsigned NOT NULL,
  `episodeId` bigint unsigned NOT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'claimed',
  `claimedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `firstEventKey` varchar(384) NULL,
  `emittedAt` timestamp NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notificationDigestMemberships_episode_uq` (`episodeId`),
  KEY `notificationDigestMemberships_batch_state_idx` (`batchId`,`state`)
);
