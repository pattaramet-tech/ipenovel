-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair - see migration 0018's header comment for the shared rationale.
-- Original enum, default, and nullability preserved exactly.
SET @ipenovel_0023_col_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'episodes' AND column_name = 'saleMode'
);
--> statement-breakpoint
SET @ipenovel_0023_col_sql = IF(
	@ipenovel_0023_col_exists = 0,
	"ALTER TABLE `episodes` ADD `saleMode` enum('chapter','package') DEFAULT 'chapter' NOT NULL",
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0023_col_stmt FROM @ipenovel_0023_col_sql;
--> statement-breakpoint
EXECUTE ipenovel_0023_col_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0023_col_stmt;
