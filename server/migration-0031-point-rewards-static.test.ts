import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * DB-independent safety coverage for migration 0031, which makes
 * `dailyCheckins.couponId` nullable so a point-only check-in (which mints no
 * coupon) can exist at all.
 *
 * The live behavior - fresh 0000->0031, upgrade 0030->0031, rerun
 * idempotency, multiple NULL couponId rows - is proven against a real
 * database in server/migration-0031-point-rewards.integration.test.ts. This
 * file guards the things that must be true of the FILES regardless of any
 * database: that 0031 changes only what it claims to, and that no earlier
 * migration was touched to get there.
 */

const repoRoot = path.resolve(__dirname, "..");
const MIGRATION_TAG = "0031_enable_daily_checkin_point_rewards";

/** The commit this feature branch was cut from (PR #7's merge commit). */
const BASE_SHA = "17b4eddc4231521c6c43c722cef3625b334b94b4";

function gitBlob(ref: string, repoRelativePath: string): Buffer {
  return execFileSync("git", ["show", `${ref}:${repoRelativePath}`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Byte-for-byte comparison via git's object store rather than the working
 * tree - this repo runs with core.autocrlf=true, so a working-tree read
 * yields CRLF on Windows and LF in CI for the same committed content.
 */
function isUnchangedSinceBase(repoRelativePath: string): boolean {
  return gitBlob(BASE_SHA, repoRelativePath).equals(gitBlob("HEAD", repoRelativePath));
}

const migrationSql = fs.readFileSync(path.join(repoRoot, "drizzle", `${MIGRATION_TAG}.sql`), "utf8");

/**
 * The migration with `-- ...` comment lines removed.
 *
 * "This migration must not DELETE anything" is a claim about the SQL that
 * will actually execute, not about the prose explaining it - and that prose
 * legitimately names the things it is explaining why it does NOT do. Every
 * negative assertion below runs against this stripped form so a comment can
 * never make the test lie in either direction.
 */
const executableSql = migrationSql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));

describe("migration 0031 - journal integrity", () => {
  it("is registered as idx 31 with the expected tag", () => {
    const entry = journal.entries.find((e: any) => e.idx === 31);
    expect(entry).toBeDefined();
    expect(entry.tag).toBe(MIGRATION_TAG);
  });

  it("is the last entry and its timestamp is strictly after migration 0030's", () => {
    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe(MIGRATION_TAG);
    expect(journal.entries).toHaveLength(32);

    const migration0030 = journal.entries.find((e: any) => e.idx === 30);
    expect(migration0030.when).toBe(1784602000000);
    expect(last.when).toBeGreaterThan(migration0030.when);
  });

  it("has a drizzle-generated (not hand-invented) millisecond timestamp", () => {
    const last = journal.entries[journal.entries.length - 1];
    // A hand-written placeholder would be a suspiciously round number.
    expect(Number.isInteger(last.when)).toBe(true);
    expect(String(last.when)).toHaveLength(13);
    expect(last.when % 1000).not.toBe(0);
  });

  it("has a matching snapshot file", () => {
    expect(fs.existsSync(path.join(repoRoot, "drizzle/meta/0031_snapshot.json"))).toBe(true);
  });
});

describe("migration 0031 - changes only dailyCheckins.couponId", () => {
  it("contains the guarded couponId nullability change", () => {
    expect(migrationSql).toMatch(/ALTER TABLE `dailyCheckins` MODIFY COLUMN `couponId` int NULL/);
  });

  it("does not touch any table other than dailyCheckins", () => {
    const alteredTables = [...executableSql.matchAll(/ALTER TABLE `([^`]+)`/g)].map((m) => m[1]);
    expect([...new Set(alteredTables)]).toEqual(["dailyCheckins"]);
  });

  it("does not carry drizzle's unrelated dailyCheckinRewardRules statements", () => {
    // drizzle-kit proposed isActive/sortOrder MODIFY COLUMNs caused purely by
    // snapshot serialization drift ("true" vs true). They are semantic
    // no-ops and were deliberately excluded - re-adding them would put
    // unrelated, Reorg-Data-triggering DDL into this migration.
    expect(executableSql).not.toMatch(/dailyCheckinRewardRules/);
  });

  it("contains no destructive statement", () => {
    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b/i);
    expect(executableSql).not.toMatch(/\bRENAME\b/i);
    // No backfill of existing rows.
    expect(executableSql).not.toMatch(/\bUPDATE\b/i);
  });

  it("never drops or recreates the coupon unique index", () => {
    // Multiple NULLs are allowed in a MySQL/TiDB unique index, so the index
    // can and must stay exactly as it is.
    expect(executableSql).not.toMatch(/unique_daily_checkins_coupon/);
  });
});

describe("migration 0031 - idempotency guard", () => {
  it("reads IS_NULLABLE from information_schema before altering", () => {
    expect(migrationSql).toMatch(
      /SELECT IS_NULLABLE FROM information_schema\.columns[\s\S]*table_name = 'dailyCheckins' AND column_name = 'couponId'/
    );
  });

  it("executes DO 0 when the column is already nullable", () => {
    const match = migrationSql.match(
      /SET @ipenovel_0031_sql = IF\(\s*@ipenovel_0031_couponid_nullable = 'YES',\s*('[^']*'),\s*('[^']*')\s*\)/
    );
    expect(match).not.toBeNull();
    expect(match![1].replace(/'/g, "")).toBe("DO 0");
    expect(match![2]).toMatch(/ALTER TABLE `dailyCheckins` MODIFY COLUMN `couponId` int NULL/);
  });

  it("uses the repository's SET / PREPARE / EXECUTE / DEALLOCATE pattern with uniquely named handles", () => {
    expect(migrationSql).toMatch(/PREPARE ipenovel_0031_stmt FROM @ipenovel_0031_sql;/);
    expect(migrationSql).toMatch(/EXECUTE ipenovel_0031_stmt;/);
    expect(migrationSql).toMatch(/DEALLOCATE PREPARE ipenovel_0031_stmt;/);
  });
});

describe("migration 0031 - earlier migrations remain untouched", () => {
  const MUST_BE_UNCHANGED = [
    "0021_skinny_slayback",
    "0024_widen_episode_content_mediumtext",
    "0025_add_reading_progress_toc_columns",
    "0026_add_homepage_performance_indexes",
    "0027_add_daily_checkin_and_coupon_cap",
    "0028_repair_episode_reader_schema",
    "0029_add_dynamic_daily_checkin_reward_schema",
    "0030_repair_missing_daily_checkins",
  ];

  for (const tag of MUST_BE_UNCHANGED) {
    it(`${tag}.sql is byte-identical to the branch point`, () => {
      expect(isUnchangedSinceBase(`drizzle/${tag}.sql`)).toBe(true);
    });
  }

  it("migration 0030's snapshot is byte-identical to the branch point", () => {
    expect(isUnchangedSinceBase("drizzle/meta/0030_snapshot.json")).toBe(true);
  });

  it("no migration 0032 exists", () => {
    expect(journal.entries.find((e: any) => e.idx === 32)).toBeUndefined();
    expect(fs.readdirSync(path.join(repoRoot, "drizzle")).filter((f) => /^0032/.test(f))).toHaveLength(0);
  });

  it("every 0000-0030 journal entry kept its original timestamp", () => {
    const baseJournal = JSON.parse(gitBlob(BASE_SHA, "drizzle/meta/_journal.json").toString("utf8"));
    for (const baseEntry of baseJournal.entries) {
      const current = journal.entries.find((e: any) => e.idx === baseEntry.idx);
      expect(current, `journal entry idx ${baseEntry.idx} disappeared`).toBeDefined();
      expect(current.when, `journal entry idx ${baseEntry.idx} changed timestamp`).toBe(baseEntry.when);
      expect(current.tag).toBe(baseEntry.tag);
    }
  });
});

describe("schema.ts - couponId is nullable", () => {
  it("declares dailyCheckins.couponId without .notNull()", () => {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    const dailyCheckinsBlock = schema.slice(
      schema.indexOf('export const dailyCheckins = mysqlTable('),
      schema.indexOf("export type DailyCheckin ")
    );
    expect(dailyCheckinsBlock).toMatch(/couponId: int\("couponId"\),/);
    expect(dailyCheckinsBlock).not.toMatch(/couponId: int\("couponId"\)\.notNull\(\)/);
  });

  it("keeps the unique coupon index declared", () => {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/uniqueIndex\("unique_daily_checkins_coupon"\)/);
  });
});
