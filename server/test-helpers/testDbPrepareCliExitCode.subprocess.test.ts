import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * DB-independent subprocess coverage proving the exact CLI exit-code
 * pattern scripts/test-db-prepare.ts now uses (top-level `await` +
 * `try`/`catch`, `process.exitCode = 1` on failure, never
 * `process.exit()`) genuinely produces a nonzero process exit status.
 *
 * Spawns small, standalone `.mjs` fixtures (server/test-helpers/__fixtures__/)
 * that mirror the real script's pattern rather than the real
 * TypeScript file itself - this keeps the test fully DB-independent (no
 * TEST_DATABASE_URL, no mysql2, no network) and avoids any tsx/ts-node
 * subprocess-invocation fragility, while still proving the pattern itself
 * via a real child process, not just a unit-level function call.
 */

const fixturesDir = path.join(__dirname, "__fixtures__");

function codeOnly(source: string): string {
  // Strips comments before matching - see testDbConnectionOptions.test.ts's
  // own codeOnly() for the same rationale: a fixture's own explanatory
  // comment (which legitimately needs to mention "process.exit()" in
  // prose) must never make a static-source assertion about the fixture's
  // actual CODE produce a false positive.
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function runFixture(fixtureFileName: string) {
  const fixturePath = path.join(fixturesDir, fixtureFileName);
  expect(fs.existsSync(fixturePath)).toBe(true);
  return spawnSync(process.execPath, [fixturePath], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env },
  });
}

describe("CLI top-level await + try/catch exit-code pattern (subprocess, DB-independent)", () => {
  it("a simulated close failure exits with a nonzero status and prints exactly one sanitized error line", () => {
    const result = runFixture("simulatedCliCloseFailure.mjs");

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toMatch(/\[fixture\] closeMysqlConnectionSafely: connection\.end\(\) failed: simulated failure/);
  });

  it("a simulated successful close exits with status 0", () => {
    const result = runFixture("simulatedCliCloseSuccess.mjs");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\[fixture\] succeeded/);
  });

  it("the failing fixture never calls process.exit() - it relies purely on process.exitCode plus natural process termination", () => {
    const fixtureSource = codeOnly(fs.readFileSync(path.join(fixturesDir, "simulatedCliCloseFailure.mjs"), "utf8"));
    expect(fixtureSource).not.toMatch(/process\.exit\(/);
    expect(fixtureSource).toMatch(/process\.exitCode\s*=\s*1/);
  });
});
