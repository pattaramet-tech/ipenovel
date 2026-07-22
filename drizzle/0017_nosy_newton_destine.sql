-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair. Confirmed production diagnosis: production's recorded migration
-- history high-water mark is currently BEFORE this migration's own
-- timestamp, yet `payments.ocrConfidence`/`payments.ocrDecision` already
-- exist on production (added by an earlier, out-of-band process), while
-- their secondary indexes do not. Drizzle's migrator resumes purely by
-- comparing each journal entry's `when` against the single latest recorded
-- `created_at` (never by re-checking whether a migration's target objects
-- already exist) - so this migration WILL be attempted for real the next
-- time production resumes. A bare, unconditional `ADD COLUMN` would fail
-- immediately with a duplicate-column error and block every later pending
-- migration (0018 onward) from ever running, exactly matching the current
-- runner's observed failure. Every statement below is guarded to be safe
-- in any state: columns absent, columns present, indexes present, indexes
-- absent, or this migration re-run entirely. The original historical
-- column/index definitions are preserved exactly - only how safely they
-- are reached has changed. Migration 0021 remains responsible for
-- normalizing `ocrConfidence`/`ocrDecision`'s later, stricter definition -
-- not touched here.
SET @ipenovel_0017_col1_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'ocrConfidence'
);
--> statement-breakpoint
SET @ipenovel_0017_col1_sql = IF(
	@ipenovel_0017_col1_exists = 0,
	'ALTER TABLE `payments` ADD `ocrConfidence` int',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0017_col1_stmt FROM @ipenovel_0017_col1_sql;
--> statement-breakpoint
EXECUTE ipenovel_0017_col1_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0017_col1_stmt;
--> statement-breakpoint
SET @ipenovel_0017_col2_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'ocrDecision'
);
--> statement-breakpoint
SET @ipenovel_0017_col2_sql = IF(
	@ipenovel_0017_col2_exists = 0,
	"ALTER TABLE `payments` ADD `ocrDecision` enum('auto_approved','needs_review','rejected','ocr_disabled','shadow_auto_approved')",
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0017_col2_stmt FROM @ipenovel_0017_col2_sql;
--> statement-breakpoint
EXECUTE ipenovel_0017_col2_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0017_col2_stmt;
--> statement-breakpoint
SET @ipenovel_0017_idx1_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'payments' AND index_name = 'payments_ocrConfidence_idx'
);
--> statement-breakpoint
SET @ipenovel_0017_idx1_sql = IF(
	@ipenovel_0017_idx1_exists = 0,
	'CREATE INDEX `payments_ocrConfidence_idx` ON `payments` (`ocrConfidence`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0017_idx1_stmt FROM @ipenovel_0017_idx1_sql;
--> statement-breakpoint
EXECUTE ipenovel_0017_idx1_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0017_idx1_stmt;
--> statement-breakpoint
SET @ipenovel_0017_idx2_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'payments' AND index_name = 'payments_ocrDecision_idx'
);
--> statement-breakpoint
SET @ipenovel_0017_idx2_sql = IF(
	@ipenovel_0017_idx2_exists = 0,
	'CREATE INDEX `payments_ocrDecision_idx` ON `payments` (`ocrDecision`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0017_idx2_stmt FROM @ipenovel_0017_idx2_sql;
--> statement-breakpoint
EXECUTE ipenovel_0017_idx2_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0017_idx2_stmt;
