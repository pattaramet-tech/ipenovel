import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

/**
 * DB-independent static coverage for migration 0030 - the forward-only
 * repair for the confirmed production incident where `dailyCheckins` does
 * not exist even though `__drizzle_migrations` already records history
 * past 0027. See docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md's follow-up section
 * and server/migration-0030-repair-missing-daily-checkins.integration.test.ts
 * for the real-database coverage this file cannot provide on its own.
 *
 * These are pure file/config assertions, mirroring
 * server/migration-deployment-safety.test.ts's own "no DB required" style
 * - no TEST_DATABASE_URL, no connection, no vitest project restriction.
 */

describe("Migration 0030 journal and file (no DB required - static checks)", () => {
  it("journal has a new entry for migration 0030, with idx 30 and a timestamp strictly newer than 0029", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry0029 = journal.entries.find((e: any) => e.tag === "0029_add_dynamic_daily_checkin_reward_schema");
    const entry0030 = journal.entries.find((e: any) => e.tag === "0030_repair_missing_daily_checkins");

    expect(entry0029).toBeDefined();
    expect(entry0030).toBeDefined();
    expect(entry0030.idx).toBe(30);
    expect(entry0030.version).toBe(entry0029.version);
    expect(entry0030.breakpoints).toBe(true);
    expect(entry0030.when).toBeGreaterThan(entry0029.when);
  });

  it("migration 0030 sits at idx 30 with nothing inserted out of order around it", () => {
    // Originally asserted 0030 was the final entry. Migration 0031
    // (dailyCheckins.couponId -> nullable, for the 1-point Daily Check-in
    // reward) was added deliberately afterwards, so the invariant worth
    // protecting is 0030's own position and ordering - not that it stays
    // last forever.
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const index0030 = journal.entries.findIndex((e: any) => e.tag === "0030_repair_missing_daily_checkins");
    expect(index0030).toBeGreaterThanOrEqual(0);
    expect(journal.entries[index0030].idx).toBe(30);
    // Array position matches idx: no entry was spliced in ahead of it.
    expect(index0030).toBe(30);
    // Every entry is strictly ordered by idx and timestamp.
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(journal.entries[i].idx).toBe(journal.entries[i - 1].idx + 1);
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it("no earlier journal entry's when/idx/tag was modified by this change", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry0029 = journal.entries.find((e: any) => e.tag === "0029_add_dynamic_daily_checkin_reward_schema");
    expect(entry0029.idx).toBe(29);
    expect(entry0029.when).toBe(1784601000000);
  });

  it("the migration file for 0030 exists and matches the journal tag", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: any) => e.tag === "0030_repair_missing_daily_checkins");
    const migrationPath = path.join(repoRoot, "drizzle", `${entry.tag}.sql`);
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it("a matching snapshot file exists, chained to 0029's snapshot id", () => {
    const snapshot0029 = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/0029_snapshot.json"), "utf8"));
    const snapshot0030Path = path.join(repoRoot, "drizzle/meta/0030_snapshot.json");
    expect(fs.existsSync(snapshot0030Path)).toBe(true);

    const snapshot0030 = JSON.parse(fs.readFileSync(snapshot0030Path, "utf8"));
    expect(snapshot0030.prevId).toBe(snapshot0029.id);
    expect(snapshot0030.id).not.toBe(snapshot0029.id);
    // schema.ts itself is unchanged by this repair migration (dailyCheckins
    // was already declared there since 0027) - the table/view content must
    // be identical to 0029's snapshot, only the id/prevId chain link moves
    // forward. Matches this repo's own established precedent: 0028 (also a
    // hand-written repair migration with no schema.ts diff) duplicated
    // 0027's snapshot content verbatim the same way.
    const strip = (s: any) => ({ ...s, id: "X", prevId: "X" });
    expect(JSON.stringify(strip(snapshot0030))).toBe(JSON.stringify(strip(snapshot0029)));
  });

  it("migration 0030 recreates dailyCheckins via CREATE TABLE IF NOT EXISTS, not a bare CREATE TABLE", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0030_repair_missing_daily_checkins.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `dailyCheckins`/);
    expect(sql).not.toMatch(/CREATE TABLE `dailyCheckins` \(/);
  });

  it("migration 0030 preserves the exact column set, enum values, and unique constraints declared in drizzle/schema.ts", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0030_repair_missing_daily_checkins.sql"), "utf8");
    for (const column of [
      "`id`",
      "`userId`",
      "`checkinDate`",
      "`campaignKey`",
      "`couponId`",
      "`status`",
      "`issuedAt`",
      "`usedAt`",
      "`createdAt`",
      "`updatedAt`",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/enum\('issued','used','void'\)/);
    expect(sql).toMatch(/CONSTRAINT `unique_daily_checkin_user_date_campaign` UNIQUE\(`userId`,`checkinDate`,`campaignKey`\)/);
    expect(sql).toMatch(/CONSTRAINT `unique_daily_checkins_coupon` UNIQUE\(`couponId`\)/);
  });

  it("migration 0030 never drops, truncates, renames, or rewrites anything", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0030_repair_missing_daily_checkins.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    // "ON UPDATE CURRENT_TIMESTAMP" is a column attribute (already present
    // on `updatedAt` in every other table in this schema), not a
    // destructive UPDATE statement - only a standalone UPDATE statement
    // (not preceded by "ON ") would indicate a rewrite of existing rows.
    expect(sql).not.toMatch(/(?<!ON )\bUPDATE\b/i);
  });

  it("migration 0030's userId index is guarded by an information_schema check, not run unconditionally", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0030_repair_missing_daily_checkins.sql"), "utf8");
    expect(sql).toMatch(/information_schema\.statistics/);
    expect(sql).toMatch(/index_name = 'dailyCheckins_userId_idx'/);
    expect(sql).toMatch(/PREPARE ipenovel_0030_idx_stmt/);
    expect(sql).toMatch(/DEALLOCATE PREPARE ipenovel_0030_idx_stmt/);
    expect(sql).not.toMatch(/^CREATE INDEX `dailyCheckins_userId_idx`/m);
  });

  it("migration 0030's coupons.maxDiscountAmount ALTER is guarded by an information_schema check, not run unconditionally", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0030_repair_missing_daily_checkins.sql"), "utf8");
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/column_name = 'maxDiscountAmount'/);
    expect(sql).toMatch(/PREPARE ipenovel_0030_alter_stmt/);
    expect(sql).toMatch(/DEALLOCATE PREPARE ipenovel_0030_alter_stmt/);
    expect(sql).not.toMatch(/^ALTER TABLE `coupons` ADD `maxDiscountAmount`/m);
  });

  it("schema.ts still declares dailyCheckins with the exact status enum and coupons.maxDiscountAmount - unchanged by this migration", () => {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/export const dailyCheckins = mysqlTable/);
    expect(schema).toMatch(/status:\s*mysqlEnum\("status",\s*\[.*"issued".*"used".*"void".*\]\)/);
    expect(schema).toMatch(/maxDiscountAmount:\s*decimal\("maxDiscountAmount"/);
  });
});
