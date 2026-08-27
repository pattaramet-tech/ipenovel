CREATE TABLE `paymentSlipLegacyCollisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` enum('reference','file','qr') NOT NULL,
	`identifierHash` varchar(64) NOT NULL,
	`sourceType` enum('order_payment','wallet_topup') NOT NULL,
	`sourceId` int NOT NULL,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentSlipLegacyCollisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentSlipLegacyCollisions_member_unique` UNIQUE(`kind`,`identifierHash`,`sourceType`,`sourceId`)
);
--> statement-breakpoint
CREATE TABLE `paymentSlipLegacyUnknown` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceType` enum('order_payment','wallet_topup') NOT NULL,
	`sourceId` int NOT NULL,
	`reason` varchar(64) NOT NULL,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentSlipLegacyUnknown_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentSlipLegacyUnknown_source_unique` UNIQUE(`sourceType`,`sourceId`)
);
--> statement-breakpoint
CREATE INDEX `paymentSlipLegacyCollisions_identifierHash_idx` ON `paymentSlipLegacyCollisions` (`kind`,`identifierHash`);--> statement-breakpoint
CREATE INDEX `paymentSlipLegacyUnknown_sourceType_idx` ON `paymentSlipLegacyUnknown` (`sourceType`);
