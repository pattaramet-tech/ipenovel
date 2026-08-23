CREATE TABLE `paymentSlipReviewResolutions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subjectType` enum('order_payment','wallet_topup') NOT NULL,
	`subjectId` int NOT NULL,
	`resolutionType` enum('legacy_case_confirmed_distinct','legacy_case_confirmed_duplicate') NOT NULL,
	`matchedSourceType` enum('order_payment','wallet_topup'),
	`matchedSourceId` int,
	`legacyAliasHash` varchar(64),
	`adminUserId` int NOT NULL,
	`reason` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentSlipReviewResolutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentSlipReviewResolutions_subject_unique` UNIQUE(`subjectType`,`subjectId`)
);
--> statement-breakpoint
ALTER TABLE `paymentSlipClaims` ADD `legacyReferenceUpperHash` varchar(64);--> statement-breakpoint
CREATE INDEX `paymentSlipReviewResolutions_adminUserId_idx` ON `paymentSlipReviewResolutions` (`adminUserId`);--> statement-breakpoint
CREATE INDEX `paymentSlipReviewResolutions_createdAt_idx` ON `paymentSlipReviewResolutions` (`createdAt`);--> statement-breakpoint
CREATE INDEX `paymentSlipClaims_legacyReferenceUpperHash_idx` ON `paymentSlipClaims` (`legacyReferenceUpperHash`);