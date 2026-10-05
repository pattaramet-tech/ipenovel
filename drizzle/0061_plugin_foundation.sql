-- IPE-PLUGIN-001B: OAuth 2.1 + MCP foundation (read-only identity slice).
-- Isolated server/plugin/ namespace tables. Purely additive - no existing
-- table, column, constraint, or row is touched. See docs/
-- IPE-PLUGIN-001B_OAUTH_MCP_FOUNDATION.md.

CREATE TABLE `pluginOAuthClients` (
  `id` int AUTO_INCREMENT NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `clientSecretHash` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `redirectUris` text NOT NULL,
  `allowedScopes` text NOT NULL,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `pluginOAuthClients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poc_client_id_unique` ON `pluginOAuthClients` (`clientId`);
--> statement-breakpoint
CREATE TABLE `pluginOAuthConsentAttempts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `stateHash` varchar(64) NOT NULL,
  `csrfTokenHash` varchar(64) NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `redirectUri` varchar(500) NOT NULL,
  `scope` text NOT NULL,
  `codeChallenge` varchar(128) NOT NULL,
  `codeChallengeMethod` varchar(16) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `consumedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `pluginOAuthConsentAttempts_id` PRIMARY KEY(`id`),
  CONSTRAINT `poca_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poca_state_hash_unique` ON `pluginOAuthConsentAttempts` (`stateHash`);
--> statement-breakpoint
CREATE INDEX `poca_expiry_idx` ON `pluginOAuthConsentAttempts` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `pluginOAuthAuthorizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `scope` text NOT NULL,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `revokedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `lastUsedAt` timestamp,
  CONSTRAINT `pluginOAuthAuthorizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `poa_client_fk` FOREIGN KEY (`clientId`) REFERENCES `pluginOAuthClients`(`clientId`) ON DELETE CASCADE,
  CONSTRAINT `poa_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poa_user_client_unique` ON `pluginOAuthAuthorizations` (`userId`,`clientId`);
--> statement-breakpoint
CREATE TABLE `pluginOAuthAuthorizationCodes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `codeHash` varchar(64) NOT NULL,
  `authorizationId` int NOT NULL,
  `userId` int NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `redirectUri` varchar(500) NOT NULL,
  `scope` text NOT NULL,
  `codeChallenge` varchar(128) NOT NULL,
  `codeChallengeMethod` varchar(16) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `consumedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `pluginOAuthAuthorizationCodes_id` PRIMARY KEY(`id`),
  CONSTRAINT `poac_authorization_fk` FOREIGN KEY (`authorizationId`) REFERENCES `pluginOAuthAuthorizations`(`id`) ON DELETE CASCADE,
  CONSTRAINT `poac_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poac_code_hash_unique` ON `pluginOAuthAuthorizationCodes` (`codeHash`);
--> statement-breakpoint
CREATE INDEX `poac_expiry_idx` ON `pluginOAuthAuthorizationCodes` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `pluginAccessGrants` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `authorizationId` int NOT NULL,
  `userId` int NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `scope` text NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `revokedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `pluginAccessGrants_id` PRIMARY KEY(`id`),
  CONSTRAINT `pag_authorization_fk` FOREIGN KEY (`authorizationId`) REFERENCES `pluginOAuthAuthorizations`(`id`) ON DELETE CASCADE,
  CONSTRAINT `pag_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pag_token_hash_unique` ON `pluginAccessGrants` (`tokenHash`);
--> statement-breakpoint
CREATE INDEX `pag_user_expiry_idx` ON `pluginAccessGrants` (`userId`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `pag_expiry_idx` ON `pluginAccessGrants` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `pluginRefreshGrants` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `authorizationId` int NOT NULL,
  `userId` int NOT NULL,
  `clientId` varchar(64) NOT NULL,
  `scope` text NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `revokedAt` timestamp,
  `rotatedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `pluginRefreshGrants_id` PRIMARY KEY(`id`),
  CONSTRAINT `prg_authorization_fk` FOREIGN KEY (`authorizationId`) REFERENCES `pluginOAuthAuthorizations`(`id`) ON DELETE CASCADE,
  CONSTRAINT `prg_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prg_token_hash_unique` ON `pluginRefreshGrants` (`tokenHash`);
--> statement-breakpoint
CREATE INDEX `prg_expiry_idx` ON `pluginRefreshGrants` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `pluginAuditLogs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventType` varchar(120) NOT NULL,
  `actorUserId` int,
  `clientId` varchar(64),
  `correlationId` varchar(255) NOT NULL,
  `safeMetadata` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `pluginAuditLogs_id` PRIMARY KEY(`id`),
  CONSTRAINT `pal_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `pal_correlation_idx` ON `pluginAuditLogs` (`correlationId`);
--> statement-breakpoint
CREATE INDEX `pal_event_created_idx` ON `pluginAuditLogs` (`eventType`,`createdAt`);
