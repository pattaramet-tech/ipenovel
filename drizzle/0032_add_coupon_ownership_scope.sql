-- Adds explicit coupon ownership scope: `coupons.scope` ('global' | 'user')
-- and `coupons.ownerUserId` (nullable, indexed). Part of
-- fix/coupon-owner-enforcement - see server/db.ts createCoupon/updateCoupon
-- and orderService.validateAndApplyCoupon for how these are enforced.
--
-- `scope` defaults to 'global' so every pre-existing coupon (including
-- legacy sportsMatchRewards/dailyCheckins reward coupons, which have never
-- had a scope/owner column) keeps its exact current behavior with zero
-- backfill: no UPDATE, no DELETE, no data migration of any kind. Legacy
-- reward coupons stay fully protected because
-- server/db.ts's getRewardCouponOwnership() (join against
-- sportsMatchRewards/dailyCheckins) runs unconditionally regardless of the
-- `scope` column - this migration is purely additive schema, not a
-- replacement for that existing ownership path.
--
-- Guarded exactly like migrations 0027 and 0031 (information_schema check +
-- PREPARE/EXECUTE a no-op 'DO 0' when the column/index already exists) so a
-- re-run, or a run against a database left partially migrated by a prior
-- failed attempt, is a true no-op rather than an error.
SET @ipenovel_0032_scope_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'coupons' AND column_name = 'scope'
);
--> statement-breakpoint
SET @ipenovel_0032_scope_sql = IF(
	@ipenovel_0032_scope_exists = 0,
	'ALTER TABLE `coupons` ADD `scope` enum(''global'',''user'') NOT NULL DEFAULT ''global''',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0032_scope_stmt FROM @ipenovel_0032_scope_sql;
--> statement-breakpoint
EXECUTE ipenovel_0032_scope_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0032_scope_stmt;
--> statement-breakpoint
SET @ipenovel_0032_owner_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'coupons' AND column_name = 'ownerUserId'
);
--> statement-breakpoint
SET @ipenovel_0032_owner_sql = IF(
	@ipenovel_0032_owner_exists = 0,
	'ALTER TABLE `coupons` ADD `ownerUserId` int',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0032_owner_stmt FROM @ipenovel_0032_owner_sql;
--> statement-breakpoint
EXECUTE ipenovel_0032_owner_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0032_owner_stmt;
--> statement-breakpoint
SET @ipenovel_0032_idx_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE() AND table_name = 'coupons' AND index_name = 'coupons_ownerUserId_idx'
);
--> statement-breakpoint
SET @ipenovel_0032_idx_sql = IF(
	@ipenovel_0032_idx_exists = 0,
	'CREATE INDEX `coupons_ownerUserId_idx` ON `coupons` (`ownerUserId`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0032_idx_stmt FROM @ipenovel_0032_idx_sql;
--> statement-breakpoint
EXECUTE ipenovel_0032_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0032_idx_stmt;
