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
ALTER TABLE `workspaceGoogleConsentAttempts` ADD CONSTRAINT `wgca_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `wgca_user_expiry_idx` ON `workspaceGoogleConsentAttempts` (`userId`,`expiresAt`);