CREATE TABLE `workspaceAiArtifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`attemptId` int NOT NULL,
	`artifactType` varchar(120) NOT NULL,
	`contentObjectKey` varchar(500) NOT NULL,
	`contentSha256` varchar(64) NOT NULL,
	`moderationStatus` enum('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceAiArtifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `waa_attempt_type_hash_unique` UNIQUE(`attemptId`,`artifactType`,`contentSha256`)
);
--> statement-breakpoint
CREATE TABLE `workspaceAiJobAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`attemptNo` int NOT NULL,
	`leaseOwner` varchar(255) NOT NULL,
	`leaseExpiresAt` timestamp NOT NULL,
	`providerRequestId` varchar(255),
	`status` enum('claimed','running','succeeded','failed','abandoned') NOT NULL DEFAULT 'claimed',
	`errorClass` varchar(160),
	`version` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`finishedAt` timestamp,
	CONSTRAINT `workspaceAiJobAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `waja_job_attempt_unique` UNIQUE(`jobId`,`attemptNo`)
);
--> statement-breakpoint
CREATE TABLE `workspaceAiJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`snapshotId` int NOT NULL,
	`operation` varchar(120) NOT NULL,
	`promptVersion` varchar(120) NOT NULL,
	`modelPolicyVersion` varchar(120) NOT NULL,
	`priority` int NOT NULL DEFAULT 0,
	`status` enum('queued','claimed','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
	`idempotencyKey` varchar(255) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceAiJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `waj_workspace_idempotency_unique` UNIQUE(`workspaceId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `workspaceAiArtifacts` ADD CONSTRAINT `waa_attempt_fk` FOREIGN KEY (`attemptId`) REFERENCES `workspaceAiJobAttempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiJobAttempts` ADD CONSTRAINT `waja_job_fk` FOREIGN KEY (`jobId`) REFERENCES `workspaceAiJobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiJobs` ADD CONSTRAINT `waj_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaceAiJobs` ADD CONSTRAINT `waj_snapshot_fk` FOREIGN KEY (`snapshotId`) REFERENCES `workspaceDocumentSnapshots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `waa_content_hash_idx` ON `workspaceAiArtifacts` (`contentSha256`);--> statement-breakpoint
CREATE INDEX `waja_status_lease_idx` ON `workspaceAiJobAttempts` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `waja_provider_request_idx` ON `workspaceAiJobAttempts` (`providerRequestId`);--> statement-breakpoint
CREATE INDEX `waj_claim_idx` ON `workspaceAiJobs` (`status`,`priority`,`createdAt`);