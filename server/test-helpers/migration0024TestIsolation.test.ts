import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * DB-independent static-source coverage for
 * server/migration-0024-episode-schema-repair.integration.test.ts's test
 * isolation strategy - added after three real Gate B runs and Gate C
 * proved non-deterministic (timeouts, duplicate columns, migration journal
 * mismatches), traced to a timed-out test's still-running database work
 * overlapping with the next test's setup. These checks verify the
 * structural fixes (explicit sequential execution, a file-scoped timeout,
 * a dedicated named lock, guaranteed connection closure, and a
 * non-swallowed cleanup path) are actually present in the file's source,
 * without ever connecting to a database.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const migrationTestFilePath = path.join(repoRoot, "server", "migration-0024-episode-schema-repair.integration.test.ts");

function codeOnly(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function readSource(): string {
  return codeOnly(fs.readFileSync(migrationTestFilePath, "utf8"));
}

/**
 * Extracts one numbered scenario's own body text - from its
 * `it("N. ...` call up to the next scenario's `it("` call (or end of
 * file, for the last scenario) - so checks below can inspect what a
 * SPECIFIC scenario does, not just whether a pattern appears anywhere in
 * the whole file. Source-text slicing, matching this file's existing
 * static-source-check style (no AST parsing).
 */
function extractScenario(source: string, scenarioNumber: number): string {
  const startMarker = `it("${scenarioNumber}. `;
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Could not find scenario ${scenarioNumber} (looked for ${JSON.stringify(startMarker)})`);
  }
  const nextStart = source.indexOf('\n  it("', start + startMarker.length);
  return nextStart === -1 ? source.slice(start) : source.slice(start, nextStart);
}

describe("migration-0024 integration test file - explicit sequential execution", () => {
  it("uses describe.sequential (), not a plain describe(), so ordering is explicit in code, not just inherited from global config", () => {
    const source = readSource();
    expect(source).toMatch(/describe\.sequential\(/);
  });
});

describe("migration-0024 integration test file - file-scoped timeout (not global)", () => {
  it("defines its own timeout constant, distinct from the project-wide testTimeout", () => {
    const source = readSource();
    expect(source).toMatch(/const\s+MIGRATION_0024_TEST_TIMEOUT_MS\s*=\s*180000/);
  });

  it("every one of the 10 scenarios uses the file-scoped timeout constant, not a bare hardcoded number", () => {
    const source = readSource();
    const itCount = (source.match(/\bit\(\s*"/g) || []).length;
    const timeoutUsageCount = (source.match(/MIGRATION_0024_TEST_TIMEOUT_MS\s*\)/g) || []).length;
    expect(itCount).toBe(10);
    // Each `it(...)` closes with `}, MIGRATION_0024_TEST_TIMEOUT_MS);` -
    // one usage per scenario.
    expect(timeoutUsageCount).toBe(10);
  });

  it("never raises vitest.integration.config.ts's project-wide testTimeout/hookTimeout", () => {
    const configSource = codeOnly(fs.readFileSync(path.join(repoRoot, "vitest.integration.config.ts"), "utf8"));
    expect(configSource).toMatch(/testTimeout:\s*20000/);
    expect(configSource).toMatch(/hookTimeout:\s*20000/);
  });
});

describe("migration-0024 integration test file - dedicated named lock", () => {
  it("acquires a dedicated named lock (GET_LOCK) in beforeAll", () => {
    const source = readSource();
    const beforeAllIndex = source.indexOf("beforeAll(");
    const getLockIndex = source.indexOf("GET_LOCK(");
    expect(beforeAllIndex).toBeGreaterThan(-1);
    expect(getLockIndex).toBeGreaterThan(beforeAllIndex);
  });

  it("releases the lock in afterAll, checking RELEASE_LOCK's actual result rather than assuming success", () => {
    const source = readSource();
    const afterAllIndex = source.indexOf("afterAll(");
    const releaseLockIndex = source.indexOf("RELEASE_LOCK(");
    expect(afterAllIndex).toBeGreaterThan(-1);
    expect(releaseLockIndex).toBeGreaterThan(afterAllIndex);
    expect(source).toMatch(/released\s*!==\s*1/);
  });

  it("guarantees the lock connection is closed via closeMysqlConnectionSafely, even if release fails", () => {
    const source = readSource();
    const afterAllIndex = source.indexOf("afterAll(");
    const afterAllBlock = source.slice(afterAllIndex);
    expect(afterAllBlock).toMatch(/finally\s*\{[\s\S]*?closeMysqlConnectionSafely\(lockConnection\)/);
  });

  it("throws (does not silently continue) if the lock cannot be acquired within its timeout", () => {
    const source = readSource();
    const beforeAllIndex = source.indexOf("beforeAll(");
    const beforeAllBlock = source.slice(beforeAllIndex, source.indexOf("afterAll("));
    expect(beforeAllBlock).toMatch(/if\s*\(acquired\s*!==\s*1\)\s*\{[\s\S]*?throw new Error/);
  });
});

describe("migration-0024 integration test file - guaranteed connection closure", () => {
  it("imports closeMysqlConnectionSafely and never closes a connection via a bare .end()", () => {
    const source = readSource();
    expect(source).toMatch(/import\s*\{\s*closeMysqlConnectionSafely\s*\}\s*from\s*"\.\/test-helpers\/closeMysqlConnectionSafely"/);
    expect(source).not.toMatch(/(?<!close\w*Safely\()\bconn\.end\(\)/);
    expect(source).not.toMatch(/emergencyConn\.end\(\)/);
  });

  it("cleanupTestConnection always closes the connection through closeMysqlConnectionSafely in a finally block", () => {
    const source = readSource();
    const fnStart = source.indexOf("async function cleanupTestConnection");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 400);
    expect(fnBody).toMatch(/finally\s*\{[\s\S]*?closeMysqlConnectionSafely\(conn\)/);
  });

  it("the emergency-retry connection is also closed via closeMysqlConnectionSafely, not a bare .end()", () => {
    const source = readSource();
    expect(source).toMatch(/closeConnection:\s*\(emergencyConn\)\s*=>\s*closeMysqlConnectionSafely\(emergencyConn\)/);
  });
});

describe("migration-0024 integration test file - no swallowed cleanup errors", () => {
  it("restoreToFullyMigrated delegates to restoreToFullyMigratedWithRetry (which never silently swallows a cleanup failure)", () => {
    const source = readSource();
    const fnStart = source.indexOf("async function restoreToFullyMigrated");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toMatch(/restoreToFullyMigratedWithRetry/);
  });

  it("the two baseline helpers every scenario ultimately relies on (runFullChainAndVerify, verifyFullyMigratedBaseline) still exist", () => {
    const source = readSource();
    expect(source).toMatch(/async function runFullChainAndVerify/);
    expect(source).toMatch(/async function verifyFullyMigratedBaseline/);
  });

  it("the shared cleanup path every scenario's finally block goes through (cleanupTestConnection -> restoreToFullyMigrated) restores AND verifies the fully-migrated baseline via runFullChainAndVerify as its primary attempt", () => {
    const source = readSource();
    const cleanupFnStart = source.indexOf("async function cleanupTestConnection");
    expect(cleanupFnStart).toBeGreaterThan(-1);
    const cleanupFnBody = source.slice(cleanupFnStart, cleanupFnStart + 400);
    expect(cleanupFnBody).toMatch(/restoreToFullyMigrated\(conn\)/);

    const restoreFnStart = source.indexOf("async function restoreToFullyMigrated(");
    expect(restoreFnStart).toBeGreaterThan(-1);
    const restoreFnBody = source.slice(restoreFnStart, restoreFnStart + 600);
    expect(restoreFnBody).toMatch(/restoreToFullyMigratedWithRetry\(\s*\(\)\s*=>\s*runFullChainAndVerify\(conn\)/);
  });

  it("emergency recovery (emergencyResetAndRestore) resets to empty and then explicitly re-verifies the fully-migrated baseline, not just re-running the chain", () => {
    const source = readSource();
    const fnStart = source.indexOf("async function emergencyResetAndRestore");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 400);
    expect(fnBody).toMatch(/resetToEmptySchema\(conn,/);
    expect(fnBody).toMatch(/runFullChain\(conn\)/);
    expect(fnBody).toMatch(/verifyFullyMigratedBaseline\(conn\)/);
  });
});

/**
 * The 10 scenarios deliberately do NOT all establish their starting state
 * the same way - scenario 1 starts from nothing, scenarios 2-7 each start
 * from a precise historical migration cutoff (the whole point of testing
 * migration 0024/0025/0028's handling of legacy schemas), and only
 * scenarios 8-10 genuinely need to start from the already-fully-migrated
 * baseline (idempotency, final-schema-shape, and journal-resume checks all
 * only make sense from that state). A single repo-wide occurrence count of
 * runFullChainAndVerify(conn) can't distinguish "the file was refactored to
 * use resetToCutoff for legacy-state scenarios" (safe, intentional - see
 * resetToCutoff's own docstring) from "a scenario silently stopped
 * verifying its baseline at all" (a real regression) - these checks inspect
 * each numbered scenario's own body instead.
 */
describe("migration-0024 integration test file - per-scenario starting-state strategy", () => {
  it("scenario 1 establishes its deliberately EMPTY starting state via resetToEmptySchema, not runFullChainAndVerify", () => {
    const source = readSource();
    const scenario = extractScenario(source, 1);
    expect(scenario).toMatch(/resetToEmptySchema\(conn,/);
    expect(scenario).not.toMatch(/runFullChainAndVerify\(conn\)/);
  });

  it("scenarios 2-7 each establish their own precise historical/cutoff starting state via resetToCutoff, not runFullChainAndVerify", () => {
    const source = readSource();
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const scenario = extractScenario(source, n);
      expect(scenario).toMatch(/resetToCutoff\(conn,/);
      expect(scenario).not.toMatch(/runFullChainAndVerify\(conn\)/);
    }
  });

  it("scenarios 8-10 each genuinely start from the fully-migrated baseline via runFullChainAndVerify(conn), since that is what each of them is actually testing", () => {
    const source = readSource();
    for (const n of [8, 9, 10]) {
      const scenario = extractScenario(source, n);
      expect(scenario).toMatch(/\brunFullChainAndVerify\(conn\)/);
    }
  });
});

describe("migration-0024 integration test file - deterministic synthetic journal assertions (scenario 10)", () => {
  it("never asserts a global MAX(created_at) equals a synthetic timestamp", () => {
    const source = readSource();
    // The old, rejected assertion pattern.
    expect(source).not.toMatch(/finalMaxRows\[0\]\.latest/);
  });

  it("verifies the successful and failed synthetic rows directly by exact created_at equality, not by comparing against a table-wide MAX()", () => {
    const source = readSource();
    expect(source).toMatch(/WHERE created_at = \?[\s\S]*?\[when1\]/);
    expect(source).toMatch(/WHERE created_at = \?[\s\S]*?\[when2\]/);
  });

  it("still computes synthetic timestamps strictly above both the repository journal max and the live database max", () => {
    const source = readSource();
    expect(source).toMatch(/repositoryJournalMax\s*=\s*Math\.max/);
    expect(source).toMatch(/liveDatabaseMax\s*=\s*Number/);
    expect(source).toMatch(/Math\.max\(repositoryJournalMax,\s*liveDatabaseMax\)\s*\+\s*1000/);
  });

  it("cleanup deletes only the exact synthetic timestamps (an IN list of when1/when2), never a range", () => {
    const source = readSource();
    expect(source).toMatch(/DELETE FROM.*__drizzle_migrations.*WHERE created_at IN \(\$\{when1\}, \$\{when2\}\)/);
  });
});
