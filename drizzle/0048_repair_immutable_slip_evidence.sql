-- IPE-026 deployment repair.
-- Migration 0047 may be recorded as applied after a partial DDL run.  Reconcile
-- the security-critical columns without rewriting existing data or history.
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceClass') = 0, 'ALTER TABLE `payments` ADD `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceId') = 0, 'ALTER TABLE `payments` ADD `slipEvidenceId` int', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'extractedEvidenceVersion') = 0, 'ALTER TABLE `payments` ADD `extractedEvidenceVersion` bigint unsigned', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceClass') = 0, 'ALTER TABLE `walletTopups` ADD `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceId') = 0, 'ALTER TABLE `walletTopups` ADD `slipEvidenceId` int', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'extractedEvidenceVersion') = 0, 'ALTER TABLE `walletTopups` ADD `extractedEvidenceVersion` bigint unsigned', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
--> statement-breakpoint
SET @ipe_0048_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'slipEvidenceBindings' AND column_name = 'uploadId') = 0, 'ALTER TABLE `slipEvidenceBindings` ADD `uploadId` int', 'DO 0');
--> statement-breakpoint
PREPARE ipe_0048_stmt FROM @ipe_0048_sql;
--> statement-breakpoint
EXECUTE ipe_0048_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0048_stmt;
