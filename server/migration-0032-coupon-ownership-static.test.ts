import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { findMissingSchemaObjects } from "../scripts/migrate.mjs";

/**
 * DB-independent safety coverage for migration 0032, which adds
 * `coupons.scope`, `coupons.ownerUserId`, and `coupons_ownerUserId_idx` for
 * fix/coupon-owner-enforcement.
 *
 * The live behavior - fresh 0000->0032, upgrade 0031->0032, rerun
 * idempotency, every partial-application state, existing-row preservation -
 * is proven against a real database in
 * server/migration-0032-coupon-ownership.integration.test.ts. This file
 * guards the things that must be true of the FILES regardless of any
 * database (mirrors server/migration-0031-point-rewards-static.test.ts's
 * structure), plus the boot-time schema verifier's coverage of these three
 * new objects (scripts/migrate.mjs's findMissingSchemaObjects - see
 * server/_core/migrateSchemaVerification.test.ts for its general
 * regression coverage; this file adds the specific "missing exactly one of
 * these three 0032 objects" isolation that file doesn't already have).
 */

const repoRoot = path.resolve(__dirname, "..");
const MIGRATION_TAG = "0032_add_coupon_ownership_scope";

/** origin/main's PR #9 merge commit - the point migrations 0000-0031 were
 *  already in their final, committed form and 0032 did not yet exist. */
const BASE_SHA = "021b744dcbd6ec2878a1f0513fe393a2020eea71";

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
 * The migration with `-- ...` comment lines removed - see
 * migration-0031-point-rewards-static.test.ts's identical helper for why:
 * "this migration must not DELETE anything" is a claim about the SQL that
 * will actually execute, not about prose that legitimately names the things
 * it explains why it does NOT do.
 */
const executableSql = migrationSql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));

describe("migration 0032 - journal integrity", () => {
  it("is registered as idx 32 with the expected tag", () => {
    const entry = journal.entries.find((e: any) => e.idx === 32);
    expect(entry).toBeDefined();
    expect(entry.tag).toBe(MIGRATION_TAG);
  });

  it("comes strictly after migration 0031's timestamp", () => {
    const entry = journal.entries.find((e: any) => e.idx === 32);
    const migration0031 = journal.entries.find((e: any) => e.idx === 31);
    expect(migration0031.tag).toBe("0031_enable_daily_checkin_point_rewards");
    expect(entry.when).toBeGreaterThan(migration0031.when);
  });

  it("has a drizzle-generated (not hand-invented) millisecond timestamp", () => {
    const entry = journal.entries.find((e: any) => e.idx === 32);
    // A hand-written placeholder would be a suspiciously round number.
    expect(Number.isInteger(entry.when)).toBe(true);
    expect(String(entry.when)).toHaveLength(13);
    expect(entry.when % 1000).not.toBe(0);
  });

  it("has a matching snapshot file", () => {
    expect(fs.existsSync(path.join(repoRoot, "drizzle/meta/0032_snapshot.json"))).toBe(true);
  });

  it("0032 is recorded at its own fixed position (idx 32) in the journal - no longer asserts it's the LAST entry, since later, unrelated migrations (0033 auth identities, 0034 account recovery) legitimately follow it; a stray, unversioned '0033_placeholder.sql' is still never allowed", () => {
    expect(journal.entries.find((e: any) => e.idx === 32)?.tag).toBe("0032_add_coupon_ownership_scope");
    expect(fs.existsSync(path.join(repoRoot, "drizzle", "0033_placeholder.sql"))).toBe(false);
  });
});

describe("migration 0032 - changes only coupons.scope / coupons.ownerUserId / coupons_ownerUserId_idx", () => {
  it("contains the guarded scope column addition", () => {
    // The ALTER TABLE statement is itself embedded as a quoted SQL string
    // literal inside the SET @var = IF(...) guard, so its own single quotes
    // are doubled per SQL string-literal escaping ('' inside '...') - this
    // is the literal, executable text, not a typo.
    expect(migrationSql).toMatch(
      /ALTER TABLE `coupons` ADD `scope` enum\(''global'',''user''\) NOT NULL DEFAULT ''global''/
    );
  });

  it("contains the guarded ownerUserId column addition", () => {
    expect(migrationSql).toMatch(/ALTER TABLE `coupons` ADD `ownerUserId` int/);
  });

  it("contains the guarded ownerUserId index creation", () => {
    expect(migrationSql).toMatch(/CREATE INDEX `coupons_ownerUserId_idx` ON `coupons` \(`ownerUserId`\)/);
  });

  it("does not touch any table other than coupons", () => {
    const alteredTables = [...executableSql.matchAll(/ALTER TABLE `([^`]+)`/g)].map((m) => m[1]);
    const indexedTables = [...executableSql.matchAll(/CREATE INDEX `[^`]+` ON `([^`]+)`/g)].map((m) => m[1]);
    expect([...new Set([...alteredTables, ...indexedTables])]).toEqual(["coupons"]);
  });

  it("contains no destructive statement (no UPDATE/DELETE/DROP/TRUNCATE/RENAME) - zero backfill of existing rows", () => {
    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b/i);
    expect(executableSql).not.toMatch(/\bRENAME\b/i);
    expect(executableSql).not.toMatch(/\bUPDATE\b/i);
  });

  it("existing rows receive scope='global' through the column DEFAULT, never a data migration statement", () => {
    // The DEFAULT is part of the ADD COLUMN statement itself (asserted
    // above) - there is no separate UPDATE anywhere in the file (asserted
    // immediately above too), so a pre-existing coupon row picks up
    // scope='global' purely from MySQL's own ADD-COLUMN-with-DEFAULT
    // semantics, not from any statement this migration issues.
    const updateCount = (executableSql.match(/\bUPDATE\b/gi) ?? []).length;
    expect(updateCount).toBe(0);
  });
});

describe("migration 0032 - idempotency guard", () => {
  it("reads information_schema before adding the scope column", () => {
    expect(migrationSql).toMatch(
      /SELECT COUNT\(\*\) FROM information_schema\.columns[\s\S]*table_name = 'coupons' AND column_name = 'scope'/
    );
  });

  it("reads information_schema before adding the ownerUserId column", () => {
    expect(migrationSql).toMatch(
      /SELECT COUNT\(\*\) FROM information_schema\.columns[\s\S]*table_name = 'coupons' AND column_name = 'ownerUserId'/
    );
  });

  it("reads information_schema before creating the ownerUserId index", () => {
    expect(migrationSql).toMatch(
      /SELECT COUNT\(\*\) FROM information_schema\.statistics[\s\S]*table_name = 'coupons' AND index_name = 'coupons_ownerUserId_idx'/
    );
  });

  it("executes DO 0 for scope when the column already exists", () => {
    const match = migrationSql.match(
      /SET @ipenovel_0032_scope_sql = IF\(\s*@ipenovel_0032_scope_exists = 0,\s*('[^']*(?:''[^']*)*'),\s*('[^']*')\s*\)/
    );
    expect(match).not.toBeNull();
    expect(match![2].replace(/'/g, "")).toBe("DO 0");
  });

  it("executes DO 0 for ownerUserId when the column already exists", () => {
    const match = migrationSql.match(
      /SET @ipenovel_0032_owner_sql = IF\(\s*@ipenovel_0032_owner_exists = 0,\s*('[^']*'),\s*('[^']*')\s*\)/
    );
    expect(match).not.toBeNull();
    expect(match![2].replace(/'/g, "")).toBe("DO 0");
  });

  it("executes DO 0 for the index when it already exists", () => {
    const match = migrationSql.match(
      /SET @ipenovel_0032_idx_sql = IF\(\s*@ipenovel_0032_idx_exists = 0,\s*('[^']*'),\s*('[^']*')\s*\)/
    );
    expect(match).not.toBeNull();
    expect(match![2].replace(/'/g, "")).toBe("DO 0");
  });

  it("uses the repository's SET / PREPARE / EXECUTE / DEALLOCATE pattern with uniquely named handles for all three guarded statements", () => {
    for (const handle of ["ipenovel_0032_scope_stmt", "ipenovel_0032_owner_stmt", "ipenovel_0032_idx_stmt"]) {
      expect(migrationSql).toMatch(new RegExp(`PREPARE ${handle} FROM @`));
      expect(migrationSql).toMatch(new RegExp(`EXECUTE ${handle};`));
      expect(migrationSql).toMatch(new RegExp(`DEALLOCATE PREPARE ${handle};`));
    }
  });
});

describe("migration 0032 - earlier migrations remain untouched", () => {
  const MUST_BE_UNCHANGED = [
    "0021_skinny_slayback",
    "0024_widen_episode_content_mediumtext",
    "0025_add_reading_progress_toc_columns",
    "0026_add_homepage_performance_indexes",
    "0027_add_daily_checkin_and_coupon_cap",
    "0028_repair_episode_reader_schema",
    "0029_add_dynamic_daily_checkin_reward_schema",
    "0030_repair_missing_daily_checkins",
    "0031_enable_daily_checkin_point_rewards",
  ];

  for (const tag of MUST_BE_UNCHANGED) {
    it(`${tag}.sql is byte-identical to origin/main's PR #9 merge commit`, () => {
      expect(isUnchangedSinceBase(`drizzle/${tag}.sql`)).toBe(true);
    });
  }

  it("migration 0031's snapshot is byte-identical to origin/main's PR #9 merge commit", () => {
    expect(isUnchangedSinceBase("drizzle/meta/0031_snapshot.json")).toBe(true);
  });

  it("every 0000-0031 journal entry kept its original idx/tag/timestamp, and 0032 itself is still present unmodified - no longer asserts the journal's TOTAL length, since later, unrelated migrations (0033, 0034, ...) legitimately grow it further", () => {
    const baseJournal = JSON.parse(gitBlob(BASE_SHA, "drizzle/meta/_journal.json").toString("utf8"));
    for (const baseEntry of baseJournal.entries) {
      const current = journal.entries.find((e: any) => e.idx === baseEntry.idx);
      expect(current, `journal entry idx ${baseEntry.idx} disappeared`).toBeDefined();
      expect(current.when, `journal entry idx ${baseEntry.idx} changed timestamp`).toBe(baseEntry.when);
      expect(current.tag).toBe(baseEntry.tag);
    }
    // The base journal (origin/main, pre-0032) had exactly 32 entries
    // (idx 0-31) - 0032 is the only entry THIS migration adds.
    expect(baseJournal.entries).toHaveLength(32);
    expect(journal.entries.find((e: any) => e.idx === 32)?.tag).toBe("0032_add_coupon_ownership_scope");
    expect(journal.entries.length).toBeGreaterThanOrEqual(33);
  });
});

describe("schema.ts - coupon ownership columns match the migration", () => {
  function couponsBlock(): string {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    return schema.slice(
      schema.indexOf("export const coupons = mysqlTable("),
      schema.indexOf("(table) => ({", schema.indexOf("export const coupons = mysqlTable("))
    );
  }

  it("declares scope as a non-null enum defaulting to 'global'", () => {
    expect(couponsBlock()).toMatch(/scope: mysqlEnum\("scope", \["global", "user"\]\)\.default\("global"\)\.notNull\(\)/);
  });

  it("declares ownerUserId as nullable (no .notNull())", () => {
    const block = couponsBlock();
    expect(block).toMatch(/ownerUserId: int\("ownerUserId"\),/);
    expect(block).not.toMatch(/ownerUserId: int\("ownerUserId"\)\.notNull\(\)/);
  });

  it("declares the coupons_ownerUserId_idx index", () => {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/index\("coupons_ownerUserId_idx"\)\.on\(table\.ownerUserId\)/);
  });
});

describe("boot-time schema verifier (scripts/migrate.mjs findMissingSchemaObjects) covers migration 0032's three objects individually", () => {
  /**
   * A minimal fake connection that lets each of coupons.scope,
   * coupons.ownerUserId, and coupons_ownerUserId_idx be independently
   * present or absent - server/_core/migrateSchemaVerification.test.ts's
   * own fakeConn toggles every REQUIRED_COLUMNS entry together via one
   * boolean, which cannot isolate "only scope is missing" from "only
   * ownerUserId is missing". This one keys off the actual (table, column)/
   * (table, index) pair in each query's bound params instead.
   */
  function fakeConnMissingOnly(missingColumns: string[], missingIndexes: string[]) {
    const query = async (sql: string, params: unknown[] = []): Promise<[any[]]> => {
      if (sql.includes("information_schema.tables")) {
        // Every REQUIRED_TABLES row present.
        const { REQUIRED_TABLES } = require("../scripts/migrate.mjs");
        return [REQUIRED_TABLES.map((t: string) => ({ name: t }))];
      }
      if (sql.includes("information_schema.columns") && sql.includes("is_nullable")) {
        if (sql.includes("column_type AS columnType")) {
          const { REQUIRED_COLUMN_SHAPES } = require("../scripts/migrate.mjs");
          const expected = REQUIRED_COLUMN_SHAPES.find(
            (entry: any) => entry.table === String(params[0]) && entry.column === String(params[1])
          );
          return [
            expected
              ? [{
                  columnType: expected.columnType,
                  nullable: expected.nullable,
                  defaultValue: expected.defaultValue,
                }]
              : [],
          ];
        }
        return [[{ nullable: "YES" }]];
      }
      if (sql.includes("information_schema.columns")) {
        const [, column] = params as [string, string];
        return [missingColumns.includes(column) ? [] : [{ name: column }]];
      }
      if (sql.includes("information_schema.statistics")) {
        const [tableName, indexName] = params as [string, string];
        if (missingIndexes.includes(String(indexName))) return [[]];
        const { REQUIRED_INDEXES } = require("../scripts/migrate.mjs");
        const expected = REQUIRED_INDEXES.find(
          (entry: any) => entry.table === tableName && entry.index === indexName
        );
        return [
          expected?.columns?.map((columnName: string, position: number) => ({
            name: indexName,
            columnName,
            sequence: position + 1,
          })) ?? [{ name: indexName, columnName: undefined, sequence: 1 }],
        ];
      }
      if (sql.includes("information_schema.key_column_usage")) {
        return [[{ name: params[1] }]];
      }
      throw new Error(`unexpected query in fake connection: ${sql}`);
    };
    return { query };
  }

  it("14. rejects (reports missing) when coupons.scope alone is absent", async () => {
    const { query } = fakeConnMissingOnly(["scope"], []);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toContain("column coupons.scope");
    expect(missing).not.toContain("column coupons.ownerUserId");
    expect(missing).not.toContain("index coupons.coupons_ownerUserId_idx");
  });

  it("15. rejects (reports missing) when coupons.ownerUserId alone is absent", async () => {
    const { query } = fakeConnMissingOnly(["ownerUserId"], []);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toContain("column coupons.ownerUserId");
    expect(missing).not.toContain("column coupons.scope");
    expect(missing).not.toContain("index coupons.coupons_ownerUserId_idx");
  });

  it("16. rejects (reports missing) when coupons_ownerUserId_idx alone is absent", async () => {
    const { query } = fakeConnMissingOnly([], ["coupons_ownerUserId_idx"]);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toContain("index coupons.coupons_ownerUserId_idx");
    expect(missing).not.toContain("column coupons.scope");
    expect(missing).not.toContain("column coupons.ownerUserId");
  });

  it("17. succeeds (reports nothing missing) once all three migration-0032 objects are present, alongside every other required object", async () => {
    const { query } = fakeConnMissingOnly([], []);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual([]);
  });
});
