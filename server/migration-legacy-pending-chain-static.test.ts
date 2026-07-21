import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");

/**
 * The authoritative base commit this branch was cut from - the single
 * source of truth for "what these migration files looked like before this
 * repair." Kept as an exact SHA (not a symbolic ref like main, which can
 * move) so the baseline can never silently drift.
 */
const BASE_SHA = "6c895e952a74d839014d70586f8eb0e8a754af0f";

/**
 * The exact bytes of a tracked path as stored in git at `ref`, read
 * straight from git's object store via `git show <ref>:<path>`.
 *
 * Both sides of every "unchanged from base" comparison below are read this
 * way (base blob vs current committed blob) rather than by hashing the
 * working-tree file. That is deliberate: this repo runs with
 * core.autocrlf=true and no .gitattributes, so tracked files are stored
 * LF in git but smudged to CRLF on a Windows checkout. A raw working-tree
 * read therefore produces different bytes (and a different SHA-256) on
 * Windows than on an LF Linux/CI checkout - which is exactly why the
 * previous hardcoded SHA-256 baseline passed locally yet failed the release
 * gate for 0021, 0027, and _journal.json. Comparing git blob to git blob is
 * immune to that: both come from object storage in identical canonical
 * form, so the check means the same thing in every environment and matches
 * what GitHub's own base-vs-branch file comparison reports.
 */
function gitBlob(ref: string, repoRelativePath: string): Buffer {
  try {
    return execFileSync("git", ["show", `${ref}:${repoRelativePath}`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error: any) {
    throw new Error(
      `Unable to read "${repoRelativePath}" at git ref "${ref}". The base commit ${BASE_SHA} must be present ` +
        `locally for this baseline check (fetch it first if this fails in CI). ` +
        `git error: ${error?.shortMessage ?? error?.message ?? "unknown"}`
    );
  }
}

/**
 * True when a tracked path is byte-for-byte identical between the base
 * commit and the current branch tip (HEAD) - i.e. this branch's cumulative
 * changes did not alter that file at all.
 */
function isByteIdenticalToBase(repoRelativePath: string): boolean {
  return gitBlob(BASE_SHA, repoRelativePath).equals(gitBlob("HEAD", repoRelativePath));
}

/**
 * DB-independent static coverage for the legacy pending migration chain
 * repair. Production's recorded migration high-water mark is currently
 * before migration 0017's own timestamp, while its schema already has a
 * mix of complete/partial/missing objects from migrations 0017-0030 (see
 * the confirmed production diagnosis). The current migration runner
 * attempts 0017 for real and fails on its first unguarded ADD COLUMN
 * (duplicate column), which blocks every later pending migration from
 * ever running. This file proves - without a database connection - that
 * migrations 0017-0020, 0022, and 0023 are now uniformly idempotent, that
 * no unrelated file was touched, and that migrations 0021 and 0024-0030
 * are byte-identical to their pre-repair content.
 */

function readMigration(tag: string): string {
  return fs.readFileSync(path.join(repoRoot, "drizzle", `${tag}.sql`), "utf8");
}

const REPAIRED_MIGRATIONS = [
  "0017_nosy_newton_destine",
  "0018_strong_thanos",
  "0019_milky_tarot",
  "0020_tiny_crusher_hogan",
  "0022_rich_spectrum",
  "0023_add_episode_sale_mode",
] as const;

describe("legacy pending migration chain - all six repaired files use the established guard pattern", () => {
  it.each(REPAIRED_MIGRATIONS)("%s uses SET/IF/PREPARE/EXECUTE/DEALLOCATE PREPARE", (tag) => {
    const sql = readMigration(tag);
    expect(sql).toMatch(/\bSET @\w+ = \(/);
    expect(sql).toMatch(/\bIF\(/);
    expect(sql).toMatch(/\bPREPARE \w+ FROM @\w+/);
    expect(sql).toMatch(/\bEXECUTE \w+/);
    expect(sql).toMatch(/\bDEALLOCATE PREPARE \w+/);
  });

  it.each(REPAIRED_MIGRATIONS)("%s has an equal, nonzero count of PREPARE/EXECUTE/DEALLOCATE PREPARE (every guard is fully closed)", (tag) => {
    const sql = readMigration(tag);
    const prepareCount = (sql.match(/\bPREPARE \w+ FROM/g) || []).length;
    const executeCount = (sql.match(/\bEXECUTE \w+;/g) || []).length;
    const deallocateCount = (sql.match(/\bDEALLOCATE PREPARE \w+;/g) || []).length;
    expect(prepareCount).toBeGreaterThan(0);
    expect(executeCount).toBe(prepareCount);
    expect(deallocateCount).toBe(prepareCount);
  });
});

describe("migration 0017 - guarded payments.ocrConfidence/ocrDecision + both indexes", () => {
  it("no unguarded ADD COLUMN remains - both original ALTER TABLE ADD statements only appear inside quoted dynamic SQL", () => {
    const sql = readMigration("0017_nosy_newton_destine");
    expect(sql).not.toMatch(/^ALTER TABLE `payments` ADD `ocrConfidence`/m);
    expect(sql).not.toMatch(/^ALTER TABLE `payments` ADD `ocrDecision`/m);
    expect(sql).toContain("'ALTER TABLE `payments` ADD `ocrConfidence` int'");
    expect(sql).toContain("ALTER TABLE `payments` ADD `ocrDecision` enum('auto_approved','needs_review','rejected','ocr_disabled','shadow_auto_approved')");
  });

  it("no unguarded CREATE INDEX remains for either payments OCR index", () => {
    const sql = readMigration("0017_nosy_newton_destine");
    expect(sql).not.toMatch(/^CREATE INDEX `payments_ocrConfidence_idx`/m);
    expect(sql).not.toMatch(/^CREATE INDEX `payments_ocrDecision_idx`/m);
    expect(sql).toMatch(/information_schema\.columns[\s\S]*?column_name = 'ocrConfidence'/);
    expect(sql).toMatch(/information_schema\.columns[\s\S]*?column_name = 'ocrDecision'/);
    expect(sql).toMatch(/information_schema\.statistics[\s\S]*?index_name = 'payments_ocrConfidence_idx'/);
    expect(sql).toMatch(/information_schema\.statistics[\s\S]*?index_name = 'payments_ocrDecision_idx'/);
  });
});

describe("migrations 0018 and 0019 - CREATE TABLE IF NOT EXISTS, guarded secondary indexes, preserved constraints", () => {
  it("0018 creates both tables via CREATE TABLE IF NOT EXISTS, never a bare CREATE TABLE", () => {
    const sql = readMigration("0018_strong_thanos");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `sportsMatchVotes`/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `sportsMatches`/);
    expect(sql).not.toMatch(/CREATE TABLE `sportsMatchVotes` \(/);
    expect(sql).not.toMatch(/CREATE TABLE `sportsMatches` \(/);
  });

  it("0018 preserves both original unique constraints inline on their CREATE TABLE statements", () => {
    const sql = readMigration("0018_strong_thanos");
    expect(sql).toMatch(/CONSTRAINT `sportsMatchVotes_id` PRIMARY KEY\(`id`\)/);
    expect(sql).toMatch(/CONSTRAINT `unique_sports_match_user_vote` UNIQUE\(`matchId`,`userId`\)/);
    expect(sql).toMatch(/CONSTRAINT `sportsMatches_id` PRIMARY KEY\(`id`\)/);
  });

  it("0018 guards all seven original secondary indexes individually via information_schema.statistics", () => {
    const sql = readMigration("0018_strong_thanos");
    const expectedIndexes = [
      ["sportsMatchVotes", "sportsMatchVotes_matchId_idx"],
      ["sportsMatchVotes", "sportsMatchVotes_userId_idx"],
      ["sportsMatchVotes", "sportsMatchVotes_status_idx"],
      ["sportsMatches", "sportsMatches_status_idx"],
      ["sportsMatches", "sportsMatches_isActive_idx"],
      ["sportsMatches", "sportsMatches_voteDeadlineAt_idx"],
      ["sportsMatches", "sportsMatches_displayOrder_idx"],
    ];
    for (const [table, index] of expectedIndexes) {
      expect(sql).not.toMatch(new RegExp(`^CREATE INDEX \`${index}\``, "m"));
      expect(sql).toMatch(new RegExp(`table_name = '${table}' AND index_name = '${index}'`));
    }
  });

  it("0019 creates sportsMatchRewards via CREATE TABLE IF NOT EXISTS and preserves its primary key and both unique constraints", () => {
    const sql = readMigration("0019_milky_tarot");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `sportsMatchRewards`/);
    expect(sql).not.toMatch(/CREATE TABLE `sportsMatchRewards` \(/);
    expect(sql).toMatch(/CONSTRAINT `sportsMatchRewards_id` PRIMARY KEY\(`id`\)/);
    expect(sql).toMatch(/CONSTRAINT `unique_sports_match_rewards_vote` UNIQUE\(`voteId`\)/);
    expect(sql).toMatch(/CONSTRAINT `unique_sports_match_rewards_coupon` UNIQUE\(`couponId`\)/);
  });

  it("0019 guards all three original secondary indexes individually via information_schema.statistics", () => {
    const sql = readMigration("0019_milky_tarot");
    for (const index of ["sportsMatchRewards_matchId_idx", "sportsMatchRewards_userId_idx", "sportsMatchRewards_status_idx"]) {
      expect(sql).not.toMatch(new RegExp(`^CREATE INDEX \`${index}\``, "m"));
      expect(sql).toMatch(new RegExp(`index_name = '${index}'`));
    }
  });
});

describe("migration 0020 - guards the exact couponUsages unique constraint", () => {
  it("no unguarded ADD CONSTRAINT remains, guarded via information_schema.statistics on the exact constraint name", () => {
    const sql = readMigration("0020_tiny_crusher_hogan");
    expect(sql).not.toMatch(/^ALTER TABLE `couponUsages` ADD CONSTRAINT/m);
    expect(sql).toMatch(/information_schema\.statistics[\s\S]*?table_name = 'couponUsages' AND index_name = 'couponUsages_couponId_orderId_unique'/);
    expect(sql).toContain("ALTER TABLE `couponUsages` ADD CONSTRAINT `couponUsages_couponId_orderId_unique` UNIQUE(`couponId`,`orderId`)");
  });

  it("never drops, recreates, or renames the constraint - no DROP/RENAME anywhere in the file", () => {
    const sql = readMigration("0020_tiny_crusher_hogan");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });
});

describe("migration 0022 - walletTopups.status MODIFY kept unconditional, all 13 ADD COLUMNs individually guarded", () => {
  const EXPECTED_COLUMNS = [
    "slipSubmittedAt",
    "approvedAt",
    "approvedByAdminId",
    "rejectedAt",
    "extractedData",
    "ocrConfidence",
    "visionConfidence",
    "structuredConfidence",
    "finalConfidence",
    "duplicateStatus",
    "ocrDecision",
    "reviewReason",
    "approvalSource",
  ];

  it("the original MODIFY COLUMN statement for walletTopups.status is preserved unconditionally (safe to repeat by construction)", () => {
    const sql = readMigration("0022_rich_spectrum");
    expect(sql).toContain(
      "ALTER TABLE `walletTopups` MODIFY COLUMN `status` enum('pending','pending_review','approved','rejected','cancelled') NOT NULL DEFAULT 'pending'"
    );
  });

  it("all 13 original ADD COLUMN statements are present, each guarded, none unguarded", () => {
    const sql = readMigration("0022_rich_spectrum");
    for (const column of EXPECTED_COLUMNS) {
      expect(sql).not.toMatch(new RegExp(`^ALTER TABLE \`walletTopups\` ADD \`${column}\``, "m"));
      expect(sql).toMatch(new RegExp(`column_name = '${column}'`));
      expect(sql).toContain(`ALTER TABLE \`walletTopups\` ADD \`${column}\``);
    }
  });

  it("guards exactly 13 columns - no column added, none dropped", () => {
    const sql = readMigration("0022_rich_spectrum");
    const guardCount = (sql.match(/table_name = 'walletTopups' AND column_name = '/g) || []).length;
    expect(guardCount).toBe(13);
  });
});

describe("migration 0023 - guards episodes.saleMode", () => {
  it("no unguarded ADD COLUMN remains, original enum/default/nullability preserved exactly", () => {
    const sql = readMigration("0023_add_episode_sale_mode");
    expect(sql).not.toMatch(/^ALTER TABLE `episodes` ADD `saleMode`/m);
    expect(sql).toMatch(/information_schema\.columns[\s\S]*?table_name = 'episodes' AND column_name = 'saleMode'/);
    expect(sql).toContain("ALTER TABLE `episodes` ADD `saleMode` enum('chapter','package') DEFAULT 'chapter' NOT NULL");
  });
});

describe("no destructive statement anywhere in the six repaired migrations", () => {
  it.each(REPAIRED_MIGRATIONS)("%s contains no DROP, TRUNCATE, RENAME, DELETE, or UPDATE (MODIFY COLUMN is not UPDATE)", (tag) => {
    const sql = readMigration(tag);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    // "ON UPDATE CURRENT_TIMESTAMP" (present in 0018/0019's preserved
    // `updatedAt` column definitions) is a column attribute, not a
    // destructive UPDATE statement. "MODIFY COLUMN" (0022's preserved
    // walletTopups.status statement) is likewise a distinct keyword, not a
    // standalone UPDATE - only a bare UPDATE statement (preceded by
    // neither "ON " nor "MODIFY C") would indicate a rewrite of existing
    // rows.
    expect(sql).not.toMatch(/(?<!ON )(?<!MODIFY C)\bUPDATE\b/i);
  });
});

describe("journal and timestamps are untouched by this repair", () => {
  it("drizzle/meta/_journal.json is byte-identical to the base commit (no journal entry or timestamp changed)", () => {
    expect(isByteIdenticalToBase("drizzle/meta/_journal.json")).toBe(true);
  });

  it("no new migration file (0031) was created, and no journal entry beyond 0030 exists", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.find((e: any) => e.idx === 31)).toBeUndefined();
    expect(fs.existsSync(path.join(repoRoot, "drizzle/0031_repair_missing_daily_checkins.sql"))).toBe(false);
    const migrationFiles = fs.readdirSync(path.join(repoRoot, "drizzle")).filter((f) => /^0031/.test(f));
    expect(migrationFiles).toHaveLength(0);
  });
});

describe("migrations 0021 and 0024-0030 are byte-identical to their pre-repair content (untouched by this task)", () => {
  // Verified by comparing each file's git blob at the base commit against
  // its git blob at HEAD (see gitBlob/isByteIdenticalToBase) - a stable,
  // line-ending-independent baseline derived from the authoritative base
  // commit itself, rather than a hardcoded SHA-256 that silently goes stale
  // whenever it is regenerated on a checkout with different line endings.
  const UNTOUCHED_MIGRATIONS = [
    "0021_skinny_slayback",
    "0024_widen_episode_content_mediumtext",
    "0025_add_reading_progress_toc_columns",
    "0026_add_homepage_performance_indexes",
    "0027_add_daily_checkin_and_coupon_cap",
    "0028_repair_episode_reader_schema",
    "0029_add_dynamic_daily_checkin_reward_schema",
    "0030_repair_missing_daily_checkins",
  ];

  for (const tag of UNTOUCHED_MIGRATIONS) {
    it(`${tag}.sql is byte-identical to the base commit`, () => {
      expect(isByteIdenticalToBase(`drizzle/${tag}.sql`)).toBe(true);
    });
  }
});
