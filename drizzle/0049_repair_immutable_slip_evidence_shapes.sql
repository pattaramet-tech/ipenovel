-- IPE-026 deployment repair, stage 2.
-- 0048 restores absent columns. This migration also reconciles columns that
-- exist with a stale type, nullability, or default and therefore fail the
-- startup security contract.
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceClass' AND column_type = 'enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'')' AND is_nullable = 'NO' AND column_default = 'legacy_compatibility_required') = 1, 'DO 0', 'ALTER TABLE `payments` MODIFY COLUMN `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'slipEvidenceId' AND column_type = 'int' AND is_nullable = 'YES' AND column_default IS NULL) = 1, 'DO 0', 'ALTER TABLE `payments` MODIFY COLUMN `slipEvidenceId` int NULL DEFAULT NULL');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'extractedEvidenceVersion' AND column_type = 'bigint unsigned' AND is_nullable = 'YES' AND column_default IS NULL) = 1, 'DO 0', 'ALTER TABLE `payments` MODIFY COLUMN `extractedEvidenceVersion` bigint unsigned NULL DEFAULT NULL');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceClass' AND column_type = 'enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'')' AND is_nullable = 'NO' AND column_default = 'legacy_compatibility_required') = 1, 'DO 0', 'ALTER TABLE `walletTopups` MODIFY COLUMN `slipEvidenceClass` enum(''modern_immutable'',''legacy_migrated_immutable'',''legacy_compatibility_required'') NOT NULL DEFAULT ''legacy_compatibility_required''');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipEvidenceId' AND column_type = 'int' AND is_nullable = 'YES' AND column_default IS NULL) = 1, 'DO 0', 'ALTER TABLE `walletTopups` MODIFY COLUMN `slipEvidenceId` int NULL DEFAULT NULL');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'extractedEvidenceVersion' AND column_type = 'bigint unsigned' AND is_nullable = 'YES' AND column_default IS NULL) = 1, 'DO 0', 'ALTER TABLE `walletTopups` MODIFY COLUMN `extractedEvidenceVersion` bigint unsigned NULL DEFAULT NULL');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
--> statement-breakpoint
SET @ipe_0049_sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'slipEvidenceBindings' AND column_name = 'uploadId' AND column_type = 'int' AND is_nullable = 'YES' AND column_default IS NULL) = 1, 'DO 0', 'ALTER TABLE `slipEvidenceBindings` MODIFY COLUMN `uploadId` int NULL DEFAULT NULL');
--> statement-breakpoint
PREPARE ipe_0049_stmt FROM @ipe_0049_sql;
--> statement-breakpoint
EXECUTE ipe_0049_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe_0049_stmt;
