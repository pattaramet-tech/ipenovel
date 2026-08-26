CREATE TABLE `ocrVerificationAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subjectType` enum('order_payment','wallet_topup') NOT NULL,
	`subjectId` int NOT NULL,
	`attemptNo` int NOT NULL DEFAULT 1,
	`trigger` enum('automatic','admin_recheck') NOT NULL,
	`initiatedByUserId` int,
	`startedAt` timestamp NOT NULL,
	`completedAt` timestamp,
	`providerMode` varchar(32),
	`providerModel` varchar(128),
	`providerHttpStatus` int,
	`providerAttemptCount` int NOT NULL DEFAULT 0,
	`stage` enum('image_preparation','provider_call','response_parse','field_extraction','verification','completed') NOT NULL,
	`result` enum('auto_approved','needs_review','technical_failure','config_blocked') NOT NULL,
	`reviewCategory` varchar(32),
	`reviewReason` varchar(64),
	`confidence` int,
	`verificationSnapshot` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ocrVerificationAttempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paymentSlipClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceType` enum('order_payment','wallet_topup') NOT NULL,
	`sourceId` int NOT NULL,
	`userId` int NOT NULL,
	`referenceHash` varchar(64),
	`fileHash` varchar(64),
	`qrPayloadHash` varchar(64),
	`semanticFingerprint` varchar(64),
	`claimedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentSlipClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentSlipClaims_referenceHash_unique` UNIQUE(`referenceHash`),
	CONSTRAINT `paymentSlipClaims_fileHash_unique` UNIQUE(`fileHash`),
	CONSTRAINT `paymentSlipClaims_qrPayloadHash_unique` UNIQUE(`qrPayloadHash`)
);
--> statement-breakpoint
CREATE INDEX `ocrVerificationAttempts_subject_idx` ON `ocrVerificationAttempts` (`subjectType`,`subjectId`);--> statement-breakpoint
CREATE INDEX `ocrVerificationAttempts_createdAt_idx` ON `ocrVerificationAttempts` (`createdAt`);--> statement-breakpoint
CREATE INDEX `ocrVerificationAttempts_initiatedByUserId_idx` ON `ocrVerificationAttempts` (`initiatedByUserId`);--> statement-breakpoint
CREATE INDEX `paymentSlipClaims_semanticFingerprint_idx` ON `paymentSlipClaims` (`semanticFingerprint`);--> statement-breakpoint
CREATE INDEX `paymentSlipClaims_source_idx` ON `paymentSlipClaims` (`sourceType`,`sourceId`);--> statement-breakpoint
CREATE INDEX `paymentSlipClaims_userId_idx` ON `paymentSlipClaims` (`userId`);