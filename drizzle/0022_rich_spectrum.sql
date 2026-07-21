-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair - see migration 0018's header comment for the shared rationale.
--
-- The `walletTopups.status` MODIFY COLUMN statement below is left
-- unconditional/unguarded: MODIFY COLUMN always redefines the column to
-- the exact same fixed target shape regardless of the column's current
-- definition, so running it once, twice, or after a partial prior run is
-- equally safe - it is not the kind of "already exists" operation that can
-- fail on repeat the way ADD COLUMN can. Only the 13 ADD COLUMN statements
-- that follow are individually guarded, since those are the operations
-- that would throw a duplicate-column error on any column already added
-- by a prior partial run. Every original column type/default/nullability
-- is preserved exactly - only how safely each ADD COLUMN is reached has
-- changed. No existing data is dropped or modified.
ALTER TABLE `walletTopups` MODIFY COLUMN `status` enum('pending','pending_review','approved','rejected','cancelled') NOT NULL DEFAULT 'pending';
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'slipSubmittedAt'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `slipSubmittedAt` timestamp", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'approvedAt'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `approvedAt` timestamp", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'approvedByAdminId'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `approvedByAdminId` int", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'rejectedAt'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `rejectedAt` timestamp", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'extractedData'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `extractedData` text", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'ocrConfidence'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `ocrConfidence` decimal(5,2)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'visionConfidence'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `visionConfidence` decimal(5,2)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'structuredConfidence'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `structuredConfidence` decimal(5,2)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'finalConfidence'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `finalConfidence` decimal(5,2)", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'duplicateStatus'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `duplicateStatus` text", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'ocrDecision'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `ocrDecision` enum('approved','needs_review','rejected')", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'reviewReason'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `reviewReason` text", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
--> statement-breakpoint
SET @ipenovel_0022_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'walletTopups' AND column_name = 'approvalSource'
);
--> statement-breakpoint
SET @ipenovel_0022_col_sql = IF(@ipenovel_0022_col_exists = 0, "ALTER TABLE `walletTopups` ADD `approvalSource` enum('manual','ocr_auto') DEFAULT 'manual'", 'DO 0');
--> statement-breakpoint
PREPARE ipenovel_0022_col_stmt FROM @ipenovel_0022_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0022_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0022_col_stmt;
