CREATE TABLE `slipEvidenceObjects` (
	`objectKey` varchar(512) NOT NULL,
	`ownerUserId` int NOT NULL,
	`fileHash` varchar(64) NOT NULL,
	`byteSize` int unsigned NOT NULL,
	`contentType` varchar(100) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `slipEvidenceObjects_objectKey` PRIMARY KEY(`objectKey`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD `evidenceVersion` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `evidenceClass` enum('legacy_compatibility_required','modern_immutable','legacy_migrated_immutable') DEFAULT 'legacy_compatibility_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `evidenceObjectKey` varchar(512);--> statement-breakpoint
ALTER TABLE `payments` ADD `evidenceFileHash` varchar(64);--> statement-breakpoint
ALTER TABLE `payments` ADD `extractedDataEvidenceVersion` bigint unsigned;--> statement-breakpoint
-- Existing rows are deliberately NOT certified as having version-bound OCR
-- evidence. We can count the current slip epoch, but historical extractedData
-- may predate the integrity fixes and therefore remains unbound (NULL).
UPDATE `payments`
SET `evidenceVersion` = CASE WHEN `slipImageUrl` IS NOT NULL AND `slipImageUrl` <> '' THEN 1 ELSE 0 END;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `evidenceVersion` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `evidenceClass` enum('legacy_compatibility_required','modern_immutable','legacy_migrated_immutable') DEFAULT 'legacy_compatibility_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `evidenceObjectKey` varchar(512);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `evidenceFileHash` varchar(64);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `extractedDataEvidenceVersion` bigint unsigned;--> statement-breakpoint
-- Same conservative rule as order payments: old extraction is not promoted to
-- trusted version-bound evidence merely because the row currently has a slip.
UPDATE `walletTopups`
SET `evidenceVersion` = CASE WHEN `slipImageUrl` IS NOT NULL AND `slipImageUrl` <> '' THEN 1 ELSE 0 END;--> statement-breakpoint
CREATE INDEX `slipEvidenceObjects_ownerUserId_idx` ON `slipEvidenceObjects` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `slipEvidenceObjects_fileHash_idx` ON `slipEvidenceObjects` (`fileHash`);--> statement-breakpoint
CREATE INDEX `payments_evidenceObjectKey_idx` ON `payments` (`evidenceObjectKey`);--> statement-breakpoint
CREATE INDEX `walletTopups_evidenceObjectKey_idx` ON `walletTopups` (`evidenceObjectKey`);