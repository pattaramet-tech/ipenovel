-- Enables point-only Daily Check-in rewards by making `dailyCheckins.couponId`
-- nullable.
--
-- Why this is required: a point reward mints no coupon at all, so a
-- point-only check-in has nothing to put in `couponId`. The column was
-- created NOT NULL back when a coupon was the only possible reward, which
-- structurally forbids a point-only claim.
--
-- What is deliberately NOT changed:
--   * The UNIQUE index `unique_daily_checkins_coupon` on `couponId` stays
--     exactly as it is. MySQL/TiDB permit an unlimited number of NULLs in a
--     UNIQUE index, so many point-only check-ins coexist happily while the
--     index keeps doing its real job - guaranteeing one coupon is never
--     attached to two different check-in rows.
--   * Existing rows are untouched. No backfill, no UPDATE, no DELETE.
--     Every legacy coupon check-in keeps its couponId value unchanged.
--   * The claim arbiter `unique_daily_checkin_user_date_campaign`
--     (userId, checkinDate, campaignKey) is untouched, which is what makes a
--     coupon already claimed earlier on the cutover date still block a second
--     (point) claim on that same Bangkok date.
--
-- drizzle-kit additionally proposed two MODIFY COLUMN statements against
-- `dailyCheckinRewardRules` (isActive / sortOrder). Those were deliberately
-- removed: they are semantic no-ops caused purely by snapshot serialization
-- drift - the 0030 snapshot stored their defaults as the strings "true"/"0"
-- while the current drizzle-kit serializes them as native true/0. The live
-- migrated database already has `isActive tinyint(1) NOT NULL DEFAULT 1` and
-- `sortOrder int(11) NOT NULL DEFAULT 0`, exactly matching schema.ts, so
-- emitting those ALTERs would put unrelated (and on TiDB,
-- Reorg-Data-triggering) DDL into this migration for no schema benefit. The
-- regenerated 0031 snapshot normalizes the serialization so this drift stops
-- reappearing on the next generate.
--
-- Guarded so a re-run - or a run against a database where the column is
-- already nullable - is a true no-op rather than a redundant MODIFY COLUMN.
-- That matters on TiDB, where any column-type change is executed as a full
-- Reorg-Data operation over every row (the failure mode that aborted a real
-- deployment with errno 8025 - see
-- docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md).
SET @ipenovel_0031_couponid_nullable = (
	SELECT IS_NULLABLE FROM information_schema.columns
	WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND column_name = 'couponId'
);
--> statement-breakpoint
SET @ipenovel_0031_sql = IF(
	@ipenovel_0031_couponid_nullable = 'YES',
	'DO 0',
	'ALTER TABLE `dailyCheckins` MODIFY COLUMN `couponId` int NULL'
);
--> statement-breakpoint
PREPARE ipenovel_0031_stmt FROM @ipenovel_0031_sql;
--> statement-breakpoint
EXECUTE ipenovel_0031_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0031_stmt;
