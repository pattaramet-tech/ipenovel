-- IPE-ENGAGEMENT (P2R3B-R8A) — Feedback / Support Tickets / Content Reports /
-- Novel Comments / Star Ratings + central idempotency and rate-limit
-- infrastructure. Additive schema candidate only.
-- Registered in drizzle/meta/_journal.json as tag 0068_engagement_foundation
-- (idx 68, when 1794400000000; idx 67 stays reserved for the notifications
-- lineage 0067_notifications_engagement already on main).
-- CANDIDATE ONLY: NOT applied to any database in this round. Requires
-- user-reference lifecycle classification registration (including the
-- server/db.ts recovery/merge query registries), disposable-DB
-- qualification and explicit Staging-first migration approval.
-- No historical backfill; all engagement consumers are OFF by default.
-- Integrity policy (matches the 0067 additive pattern): NO FOREIGN KEY
-- constraints and NO CASCADE anywhere - cross-table integrity is enforced
-- by the engagement services, and recovery/hard-delete/merge behavior is
-- governed by the lifecycle classification registries instead.
-- Rollback ONLY after every engagement consumer is disabled and verified:
-- drop rateLimitWindows, engagementIdempotencyRecords, novelRatingAggregates,
-- novelRatings, novelCommentModerationAudit, novelComments,
-- contentReportDecisions, contentReports, supportTicketMessageRedactions,
-- supportTicketStatusEvents, supportTicketMessages, supportTickets,
-- engagementFeedback (in that order). Do not automatically drop any user
-- engagement data.

CREATE TABLE `engagementFeedback` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `category` enum('bug','suggestion','usability','other') NOT NULL DEFAULT 'bug',
  `subject` varchar(160) NOT NULL,
  `message` text NOT NULL,
  `status` enum('new','acknowledged','closed') NOT NULL DEFAULT 'new',
  `clientRequestKey` varchar(96) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `engagementFeedback_user_clientRequestKey_uq` (`userId`, `clientRequestKey`),
  KEY `engagementFeedback_user_createdAt_idx` (`userId`, `createdAt`)
);
--> statement-breakpoint
CREATE TABLE `supportTickets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ownerUserId` int NOT NULL,
  `subject` varchar(160) NOT NULL,
  `category` enum('account','payment','reading','technical','other') NOT NULL,
  `status` enum('open','waiting_user','waiting_staff','resolved','closed') NOT NULL DEFAULT 'open',
  `assignedAdminId` int NULL,
  `clientRequestKey` varchar(96) NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `supportTickets_owner_clientRequestKey_uq` (`ownerUserId`, `clientRequestKey`),
  KEY `supportTickets_owner_status_updatedAt_idx` (`ownerUserId`, `status`, `updatedAt`)
);
--> statement-breakpoint
CREATE TABLE `supportTicketMessages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ticketId` int NOT NULL,
  `actorUserId` int NOT NULL,
  `actorKind` enum('customer','staff') NOT NULL,
  `body` text NOT NULL,
  `clientRequestKey` varchar(96) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `supportTicketMessages_ticket_actor_clientRequestKey_uq` (`ticketId`, `actorUserId`, `clientRequestKey`),
  KEY `supportTicketMessages_ticket_createdAt_idx` (`ticketId`, `createdAt`)
);
--> statement-breakpoint
CREATE TABLE `supportTicketStatusEvents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ticketId` int NOT NULL,
  `fromStatus` enum('open','waiting_user','waiting_staff','resolved','closed') NOT NULL,
  `toStatus` enum('open','waiting_user','waiting_staff','resolved','closed') NOT NULL,
  `actorUserId` int NOT NULL,
  `actorKind` enum('customer','staff') NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `supportTicketStatusEvents_ticket_id_idx` (`ticketId`, `id`)
);
--> statement-breakpoint
CREATE TABLE `supportTicketMessageRedactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `messageId` int NOT NULL,
  `redactedByAdminUserId` int NOT NULL,
  `reasonCode` varchar(48) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `supportTicketMessageRedactions_message_idx` (`messageId`)
);
--> statement-breakpoint
CREATE TABLE `contentReports` (
  `id` int NOT NULL AUTO_INCREMENT,
  `reporterUserId` int NOT NULL,
  `targetType` enum('novel','episode','comment') NOT NULL,
  `targetId` int NOT NULL,
  `reason` enum('spam','abuse','copyright','illegal','other') NOT NULL,
  `details` text NOT NULL,
  `status` enum('new','in_review','resolved','dismissed') NOT NULL DEFAULT 'new',
  `clientRequestKey` varchar(96) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `contentReports_reporter_clientRequestKey_uq` (`reporterUserId`, `clientRequestKey`),
  KEY `contentReports_status_createdAt_idx` (`status`, `createdAt`),
  KEY `contentReports_target_idx` (`targetType`, `targetId`)
);
--> statement-breakpoint
CREATE TABLE `contentReportDecisions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `reportId` int NOT NULL,
  `adminUserId` int NOT NULL,
  `fromStatus` enum('new','in_review','resolved','dismissed') NOT NULL,
  `toStatus` enum('new','in_review','resolved','dismissed') NOT NULL,
  `reasonCode` varchar(48) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `contentReportDecisions_report_id_idx` (`reportId`, `id`)
);
--> statement-breakpoint
CREATE TABLE `novelComments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `novelId` int NOT NULL,
  `authorUserId` int NOT NULL,
  `parentCommentId` int NULL,
  `message` text NOT NULL,
  `status` enum('pending','visible','hidden','deleted') NOT NULL DEFAULT 'visible',
  `clientRequestKey` varchar(96) NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `novelComments_author_clientRequestKey_uq` (`authorUserId`, `clientRequestKey`),
  KEY `novelComments_novel_parent_status_id_idx` (`novelId`, `parentCommentId`, `status`, `id`)
);
--> statement-breakpoint
CREATE TABLE `novelCommentModerationAudit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `commentId` int NOT NULL,
  `actorUserId` int NOT NULL,
  `fromStatus` enum('pending','visible','hidden','deleted') NOT NULL,
  `toStatus` enum('pending','visible','hidden','deleted') NOT NULL,
  `reasonCode` varchar(48) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `novelCommentModerationAudit_comment_id_idx` (`commentId`, `id`)
);
--> statement-breakpoint
CREATE TABLE `novelRatings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `novelId` int NOT NULL,
  `userId` int NOT NULL,
  `stars` tinyint NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `novelRatings_user_novel_uq` (`userId`, `novelId`),
  KEY `novelRatings_novel_idx` (`novelId`),
  CONSTRAINT `novelRatings_stars_range_chk` CHECK (`stars` BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE `novelRatingAggregates` (
  `novelId` int NOT NULL,
  `sum` int NOT NULL DEFAULT 0,
  `count` int NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`novelId`)
);
--> statement-breakpoint
CREATE TABLE `engagementIdempotencyRecords` (
  `id` int NOT NULL AUTO_INCREMENT,
  `entity` enum('feedback','ticket','ticketMessage','report','comment','rating') NOT NULL,
  `userId` int NOT NULL,
  `clientRequestKey` varchar(96) NOT NULL,
  `canonicalPayload` text NOT NULL,
  `resultJson` json NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `engagementIdempotencyRecords_entity_user_key_uq` (`entity`, `userId`, `clientRequestKey`),
  KEY `engagementIdempotencyRecords_user_createdAt_idx` (`userId`, `createdAt`)
);
--> statement-breakpoint
CREATE TABLE `rateLimitWindows` (
  `id` int NOT NULL AUTO_INCREMENT,
  `scopeKey` varchar(191) NOT NULL,
  `windowStart` bigint NOT NULL,
  `count` int NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `rateLimitWindows_scope_windowStart_uq` (`scopeKey`, `windowStart`)
);
