import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * DB-independent static coverage for the Production incident where
 * migration 0024's unconditional
 *
 *   ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext;
 *
 * attempted to downgrade an already-LONGTEXT `episodes.content` column
 * back to MEDIUMTEXT. LONGTEXT is a wider, storage-compatible supertype
 * of MEDIUMTEXT - the downgrade was not just unnecessary, it made TiDB
 * run a full Reorg-Data operation (copying and re-validating every row),
 * which aborted with errno 8025 ("Entry too large", max entry 6291456
 * bytes, attempted 6388937 bytes) on a row well within MEDIUMTEXT's own
 * 16MiB limit but over the reorg's internal working-set ceiling. See the
 * confirmed Production diagnosis this branch was cut to fix.
 *
 * This file proves the guard's shape and safety statically; the real
 * skip/widen behavior against a live database is proven in
 * server/migration-0024-content-downgrade.integration.test.ts.
 */

const repoRoot = path.resolve(__dirname, "..");
const BASE_SHA = "364586eef9ffa77a8b68f32ae28489c381e93277";

function readMigration(tag: string): string {
  return fs.readFileSync(path.join(repoRoot, "drizzle", `${tag}.sql`), "utf8");
}

/** The exact bytes of a tracked path as stored in git at `ref`. Immune to a Windows CRLF checkout's smudged working-tree bytes - see migration-legacy-pending-chain-static.test.ts for the same pattern and the CRLF bug it was built to avoid. */
function gitBlob(ref: string, repoRelativePath: string): Buffer {
  try {
    return execFileSync("git", ["show", `${ref}:${repoRelativePath}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch (error: any) {
    throw new Error(
      `Unable to read "${repoRelativePath}" at git ref "${ref}". The base commit ${BASE_SHA} must be present locally. ` +
        `git error: ${error?.shortMessage ?? error?.message ?? "unknown"}`
    );
  }
}

function isByteIdenticalToBase(repoRelativePath: string): boolean {
  return gitBlob(BASE_SHA, repoRelativePath).equals(gitBlob("HEAD", repoRelativePath));
}

const migration0024 = readMigration("0024_widen_episode_content_mediumtext");

describe("migration 0024 - no unconditional LONGTEXT-downgrading MODIFY COLUMN remains", () => {
  it("contains no unconditional 'ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext' statement", () => {
    expect(migration0024).not.toMatch(/^ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext;?\s*$/m);
  });

  it("the MODIFY COLUMN statement only appears inside a guarded, dynamically-executed SQL string literal", () => {
    const occurrences = [...migration0024.matchAll(/ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext/g)];
    expect(occurrences).toHaveLength(1);
    const index = occurrences[0].index!;
    // Immediately preceded by a quote character - i.e. it's a string
    // literal value being assigned to the guard's SQL variable, not a
    // bare top-level statement.
    const precedingChar = migration0024[index - 1];
    expect(precedingChar === "'" || precedingChar === '"').toBe(true);
  });
});

describe("migration 0024 - the content-type guard reads DATA_TYPE and treats mediumtext/longtext as already correct", () => {
  it("reads LOWER(DATA_TYPE) for episodes.content from information_schema.columns", () => {
    expect(migration0024).toMatch(
      /SELECT LOWER\(DATA_TYPE\) FROM information_schema\.columns\s*\n\s*WHERE table_schema = DATABASE\(\) AND table_name = 'episodes' AND column_name = 'content'/
    );
  });

  it("the guard's IF condition treats exactly 'mediumtext' and 'longtext' as already-correct (no-op)", () => {
    const match = migration0024.match(/@ipenovel_0024_content_type IN \(('[^)]+')\)/);
    expect(match).not.toBeNull();
    const inList = match![1];
    expect(inList).toContain("'mediumtext'");
    expect(inList).toContain("'longtext'");
    // Exactly these two - not "tinytext"/"text"/"longblob" also treated as already-correct.
    expect(inList.split(",").map((s) => s.trim())).toHaveLength(2);
  });

  it("the true branch (mediumtext/longtext already present) is a guarded no-op (DO 0), never a DROP/ALTER", () => {
    const ifMatch = migration0024.match(
      /SET @ipenovel_0024_content_sql = IF\(\s*@ipenovel_0024_content_type IN \([^)]+\),\s*('[^']*'|"[^"]*"),\s*('[^']*'|"[^"]*")\s*\)/
    );
    expect(ifMatch).not.toBeNull();
    const [, truePart, falsePart] = ifMatch!;
    expect(truePart.replace(/['"]/g, "")).toBe("DO 0");
    // The false branch (anything else - TEXT/TINYTEXT) is the widening ALTER.
    expect(falsePart).toMatch(/ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext/);
  });

  it("uses the SET / PREPARE / EXECUTE / DEALLOCATE PREPARE pattern, with a uniquely named variable and statement", () => {
    expect(migration0024).toMatch(/SET @ipenovel_0024_content_type = \(/);
    expect(migration0024).toMatch(/SET @ipenovel_0024_content_sql = IF\(/);
    expect(migration0024).toMatch(/PREPARE ipenovel_0024_content_stmt FROM @ipenovel_0024_content_sql;/);
    expect(migration0024).toMatch(/EXECUTE ipenovel_0024_content_stmt;/);
    expect(migration0024).toMatch(/DEALLOCATE PREPARE ipenovel_0024_content_stmt;/);
    // Distinct from this file's own reused @ipenovel_0024_exists/@ipenovel_0024_sql/ipenovel_0024_stmt
    // names used by every earlier guard in this same migration - not a
    // naming collision, a deliberately different name for this guard.
    const reusedStmtCount = (migration0024.match(/\bipenovel_0024_stmt\b/g) || []).length;
    const newStmtCount = (migration0024.match(/\bipenovel_0024_content_stmt\b/g) || []).length;
    expect(reusedStmtCount).toBeGreaterThan(0);
    expect(newStmtCount).toBe(3); // PREPARE, EXECUTE, DEALLOCATE PREPARE
  });

  it("the comment explains LONGTEXT is wider, the downgrade triggers Reorg-Data, and existing LONGTEXT must be preserved", () => {
    expect(migration0024).toMatch(/LONGTEXT is a wider/i);
    expect(migration0024).toMatch(/Reorg-Data/i);
    expect(migration0024).toMatch(/preserved/i);
  });
});

describe("migration 0024 - safety invariants unchanged", () => {
  it("the migration's own journal timestamp is unchanged", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: any) => e.tag === "0024_widen_episode_content_mediumtext");
    expect(entry).toBeDefined();
    expect(entry.when).toBe(1783511891807);
  });

  it("drizzle/meta/_journal.json is byte-identical to the branch point (no entry, timestamp, or ordering changed)", () => {
    expect(isByteIdenticalToBase("drizzle/meta/_journal.json")).toBe(true);
  });

  it("drizzle/meta/0030_snapshot.json is byte-identical to the branch point", () => {
    expect(isByteIdenticalToBase("drizzle/meta/0030_snapshot.json")).toBe(true);
  });

  it("migration 0027 is byte-identical to the branch point (untouched)", () => {
    expect(isByteIdenticalToBase("drizzle/0027_add_daily_checkin_and_coupon_cap.sql")).toBe(true);
  });

  it("the 0024 fix itself added no migration - the only entry past 0030 is the known, unrelated 0031", () => {
    // This assertion's job is "repairing migration 0024 did not require a new
    // migration", not "no migration may ever be added again". Migration 0031
    // (dailyCheckins.couponId -> nullable, for the 1-point Daily Check-in
    // reward) is a separate, later, intentional change, so it is named
    // explicitly here rather than silently allowed.
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.find((e: any) => e.idx === 31)?.tag).toBe("0031_enable_daily_checkin_point_rewards");
    expect(journal.entries.find((e: any) => e.idx === 32)).toBeUndefined();

    const strayFiles = fs
      .readdirSync(path.join(repoRoot, "drizzle"))
      .filter((f) => /^003[12]/.test(f) && f !== "0031_enable_daily_checkin_point_rewards.sql");
    expect(strayFiles).toHaveLength(0);
  });

  it("migration 0030 is still recorded at idx 30, immediately before 0031", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry0030 = journal.entries.find((e: any) => e.idx === 30);
    expect(entry0030.tag).toBe("0030_repair_missing_daily_checkins");

    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe("0031_enable_daily_checkin_point_rewards");
    expect(last.idx).toBe(31);
    expect(journal.entries).toHaveLength(32);
  });

  it("no destructive statement (DROP/TRUNCATE/RENAME/DELETE) was introduced anywhere in migration 0024", () => {
    expect(migration0024).not.toMatch(/\bDROP\b/i);
    expect(migration0024).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration0024).not.toMatch(/\bRENAME\b/i);
    expect(migration0024).not.toMatch(/\bDELETE\b/i);
  });
});
