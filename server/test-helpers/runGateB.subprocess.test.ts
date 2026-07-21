import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * DB-independent subprocess coverage for the REAL scripts/run-gate-b.ts
 * CLI entrypoint (argv handling, process.exitCode propagation, never
 * process.exit()) - spawned via tsx exactly like `pnpm test:gate:b` does,
 * but with its two steps redirected (via the IPENOVEL_GATE_B_STEPS_OVERRIDE
 * test-only environment variable - see run-gate-b.ts's own
 * resolveStepsForCli()) to small, harmless `node -e` commands instead of
 * the real `pnpm test:db:prepare`/vitest steps. Never touches
 * TEST_DATABASE_URL/DATABASE_URL or a real database.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const gateBScript = path.join(repoRoot, "scripts", "run-gate-b.ts");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

function runGateBSubprocess(steps: Array<{ label: string; command: string; args: string[] }>) {
  return spawnSync(tsxBin, [gateBScript], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20000,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      IPENOVEL_GATE_B_STEPS_OVERRIDE: JSON.stringify(steps),
    },
  });
}

// Plain file-path arguments only (never inline `-e` code) - run-gate-b.ts
// spawns each step with `shell: true` on win32, and this test itself also
// spawns tsx with `shell: true` on win32; two nested shell layers do not
// reliably preserve quoted/parenthesized inline code (Node's own shell:true
// docs warn args are concatenated, not escaped) but a bare file path has no
// special characters for either shell layer to mangle.
const fixturesDir = path.join(__dirname, "__fixtures__");
const successFixture = path.join(fixturesDir, "simulatedCliCloseSuccess.mjs");
const failureFixture = path.join(fixturesDir, "simulatedCliCloseFailure.mjs");
const succeedStep = (label: string) => ({ label, command: process.execPath, args: [successFixture] });
const failStep = (label: string) => ({ label, command: process.execPath, args: [failureFixture] });

describe("scripts/run-gate-b.ts CLI entrypoint (real subprocess, DB-independent)", () => {
  it("a prepare-step failure exits nonzero and the second step never runs", () => {
    // A marker file-free way to prove "never runs": the second step would
    // itself fail loudly and distinctly if it ran, but since it also never
    // succeeds, we instead assert on stdout that only step 1 was announced.
    const result = runGateBSubprocess([failStep("prepare"), succeedStep("vitest")]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stdout).toMatch(/=== prepare ===/);
    expect(result.stdout).not.toMatch(/=== vitest ===/);
  }, 20000);

  it("a vitest-step failure (after prepare succeeds) exits nonzero", () => {
    const result = runGateBSubprocess([succeedStep("prepare"), failStep("vitest")]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stdout).toMatch(/=== prepare ===/);
    expect(result.stdout).toMatch(/=== vitest ===/);
  }, 20000);

  it("full success (both steps exit 0) exits zero", () => {
    const result = runGateBSubprocess([succeedStep("prepare"), succeedStep("vitest")]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/=== prepare ===/);
    expect(result.stdout).toMatch(/=== vitest ===/);
  }, 20000);

  it("never calls process.exit() - only process.exitCode is set", () => {
    const source = fs.readFileSync(gateBScript, "utf8");
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/process\.exit\(/);
    expect(codeOnly).toMatch(/process\.exitCode\s*=/);
  });
});
