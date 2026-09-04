-- IPE-026 / remaining IPE-021-D evidence foundation.
-- Additive and restart-safe: every table uses IF NOT EXISTS and every ALTER
-- is guarded through information_schema so a retry after partial DDL resumes.
CREATE TABLE IF NOT EXISTS `slipEvidenceUploads` (
  `id` int AUTO_INCREMENT NOT NULL,
  `objectIdentity` varchar(512) NOT NULL,
  `ownerUserId` int NOT NULL,
  `fileHash` varchar(64) NOT NULL,
  `objectSize` int unsigned NOT NULL,
  `mimeType` varchar(100) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `slipEvidenceUploads_id` PRIMARY KEY(`id`),
  CONSTRAINT `slipEvidenceUploads_objectIdentity_unique` UNIQUE(`objectIdentity`),
  KEY `slipEvidenceUploads_ownerUserId_idx` (`ownerUserId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `slipEvidenceBindings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `uploadId` int,
  `sourceType` enum('order_payment','wallet_topup') NOT NULL,
  `sourceId` int NOT NULL,
  `ownerUserId` int NOT NULL,
  `evidenceVersion` bigint unsigned NOT NULL,
  `evidenceClass` enum('modern_immutable','legacy_migrated_immutable') NOT NULL,
  `objectIdentity` varchar(512) NOT NULL,
  `fileHash` varchar(64) NOT NULL,
  `objectSize` int unsigned,
  `mimeType` varchar(100),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `slipEvidenceBindings_id` PRIMARY KEY(`id`),
  CONSTRAINT `slipEvidenceBindings_uploadId_unique` UNIQUE(`uploadId`),
  CONSTRAINT `slipEvidenceBindings_objectIdentity_unique` UNIQUE(`objectIdentity`),
  CONSTRAINT `slipEvidenceBindings_source_version_unique` UNIQUE(`sourceType`,`sourceId`,`evidenceVersion`),
  KEY `slipEvidenceBindings_ownerUserId_idx` (`ownerUserId`),
  CONSTRAINT `slipEvidenceBindings_uploadId_fk` FOREIGN KEY (`uploadId`)
    REFERENCES `slipEvidenceUploads`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
SET @ipe_0047_payments_evidence_version = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'evidenceVersion'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_evidence_version = 0,
  'ALTER TABLE `payments` ADD `evidenceVersion` bigint unsigned NOT NULL DEFAULT 0', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_payments_evidence_class = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceClass'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_evidence_class = 0,
  'ALTER TABLE `payments` ADD `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_payments_evidence_id = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceId'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_evidence_id = 0,
  'ALTER TABLE `payments` ADD `slipEvidenceId` int', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_payments_extracted_version = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'extractedEvidenceVersion'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_extracted_version = 0,
  'ALTER TABLE `payments` ADD `extractedEvidenceVersion` bigint unsigned', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_evidence_version = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'evidenceVersion'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_evidence_version = 0,
  'ALTER TABLE `walletTopups` ADD `evidenceVersion` bigint unsigned NOT NULL DEFAULT 0', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_evidence_class = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceClass'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_evidence_class = 0,
  'ALTER TABLE `walletTopups` ADD `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_evidence_id = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceId'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_evidence_id = 0,
  'ALTER TABLE `walletTopups` ADD `slipEvidenceId` int', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_extracted_version = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'extractedEvidenceVersion'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_extracted_version = 0,
  'ALTER TABLE `walletTopups` ADD `extractedEvidenceVersion` bigint unsigned', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_payments_evidence_idx = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'payments' AND index_name = 'payments_slipEvidenceId_unique'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_evidence_idx = 0,
  'ALTER TABLE `payments` ADD CONSTRAINT `payments_slipEvidenceId_unique` UNIQUE(`slipEvidenceId`)', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_evidence_idx = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND index_name = 'walletTopups_slipEvidenceId_unique'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_evidence_idx = 0,
  'ALTER TABLE `walletTopups` ADD CONSTRAINT `walletTopups_slipEvidenceId_unique` UNIQUE(`slipEvidenceId`)', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_payments_evidence_fk = (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'payments' AND constraint_name = 'payments_slipEvidenceId_fk'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_payments_evidence_fk = 0,
  'ALTER TABLE `payments` ADD CONSTRAINT `payments_slipEvidenceId_fk` FOREIGN KEY (`slipEvidenceId`) REFERENCES `slipEvidenceBindings`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
--> statement-breakpoint
SET @ipe_0047_wallet_evidence_fk = (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'walletTopups' AND constraint_name = 'walletTopups_slipEvidenceId_fk'
);
--> statement-breakpoint
SET @ipe_0047_sql = IF(@ipe_0047_wallet_evidence_fk = 0,
  'ALTER TABLE `walletTopups` ADD CONSTRAINT `walletTopups_slipEvidenceId_fk` FOREIGN KEY (`slipEvidenceId`) REFERENCES `slipEvidenceBindings`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0047_stmt FROM @ipe_0047_sql;
--> statement-breakpoint
EXECUTE ipe_0047_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0047_stmt;
