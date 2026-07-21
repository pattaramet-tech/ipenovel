-- Rewritten to be idempotent as part of the legacy pending migration chain
-- repair - see migration 0018's header comment for the shared rationale.
-- Guarded via information_schema.statistics (a UNIQUE constraint added by
-- ADD CONSTRAINT ... UNIQUE(...) creates a unique index of the same name,
-- so this is the same check already used for guarded unique indexes
-- elsewhere in this chain, e.g. migration 0029's
-- dailyCheckinCampaigns_campaignKey_unique). Never deletes, recreates,
-- renames, or rewrites an existing constraint - if it is already present,
-- this migration is a no-op.
SET @ipenovel_0020_constraint_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'couponUsages' AND index_name = 'couponUsages_couponId_orderId_unique'
);
--> statement-breakpoint
SET @ipenovel_0020_constraint_sql = IF(
	@ipenovel_0020_constraint_exists = 0,
	"ALTER TABLE `couponUsages` ADD CONSTRAINT `couponUsages_couponId_orderId_unique` UNIQUE(`couponId`,`orderId`)",
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0020_constraint_stmt FROM @ipenovel_0020_constraint_sql;
--> statement-breakpoint
EXECUTE ipenovel_0020_constraint_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0020_constraint_stmt;
