import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * IPE-001 P1-A: "Run the backfill through a TypeScript-aware loader."
 *
 * scripts/backfill-slip-claims.mjs is a .mjs file that dynamically imports
 * real application TypeScript modules (drizzle/schema.ts, server/services/
 * slipIdentifierService.ts, server/ocr-slip-verification-v2.ts) using
 * extensionless imports and this project's tsconfig `@shared/*`/`@/*` path
 * aliases. Plain `node` has no built-in understanding of either, so
 * `node scripts/backfill-slip-claims.mjs` fails with ERR_MODULE_NOT_FOUND
 * the moment DATABASE_URL is actually configured - i.e. on every real
 * operational invocation. `tsx` (the project's existing loader for
 * scripts/migrate-media-to-r2.ts and friends) resolves both correctly.
 *
 * These tests spawn the REAL script as a subprocess - not a mock, not a
 * source-string assertion - proving the canonical `tsx` invocation reaches
 * the DATABASE_URL safety guard rather than a module-resolution error, and
 * proving (as a negative control) that plain `node` does NOT.
 *
 * Database safety:
 *   - Tests 1/2 never set DATABASE_URL at all - execution never reaches the
 *     dynamic imports (the guard fires first), so this is true for BOTH
 *     loaders and proves nothing about which loader is correct by itself -
 *     it only proves neither loader crashes before reaching that guard.
 *   - Test 3 (the discriminating one) sets DATABASE_URL to a syntactically
 *     valid but disposable value so node reaches PAST its own guard - far
 *     enough to attempt the dynamic imports - but never far enough to open
 *     a real connection: ERR_MODULE_NOT_FOUND throws before any network I/O.
 *   - Test 4 uses UNREACHABLE_DB_URL (a local port nothing listens on) so
 *     tsx, having correctly resolved every import, reaches a real connection
 *     ATTEMPT that fails immediately - proving the whole dependency graph
 *     loads, without ever performing a dry-run or live backfill (both
 *     require an actual successful connection, which this deliberately
 *     never allows).
 *   - No test passes --live. No test's DATABASE_URL ever points at a real,
 *     reachable database.
 */

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "backfill-slip-claims.mjs");
// Invoked directly (node + tsx's own CLI entry) rather than via `npx tsx`:
// `npx` is a .cmd shim on Windows that spawnSync cannot exec without a
// shell, which is an environment quirk unrelated to what this test proves.
// Resolve the package through Node rather than assuming every isolated Git
// worktree has its own node_modules/tsx copy; normal module resolution may
// legitimately find the dependency in the parent project installation.
const require = createRequire(import.meta.url);
const tsxPackageJson = require.resolve("tsx/package.json");
const tsxCli = path.join(path.dirname(tsxPackageJson), "dist", "cli.mjs");

function runWithTsx(args: string[], env: Record<string, string>) {
  return run(process.execPath, [tsxCli, scriptPath, ...args], env);
}

function runWithNode(args: string[], env: Record<string, string>) {
  return run(process.execPath, [scriptPath, ...args], env);
}

/**
 * An address on localhost with nothing listening - connection is refused
 * immediately. Syntactically valid (passes the empty-string/production-
 * looking guards) but never reachable, so a loader that resolves every
 * import still cannot proceed past a genuine connection attempt.
 */
const UNREACHABLE_DB_URL = "mysql://disposable:disposable@127.0.0.1:1/ipenovel_disposable_test";

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      // Never inherit a real database from the ambient environment or .env.
      DATABASE_URL: "",
      ...env,
    },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("backfill-slip-claims.mjs must be run through a TypeScript-aware loader (real subprocess)", () => {
  it("1. tsx with no DATABASE_URL reaches the safety guard cleanly (no backfill executes)", () => {
    const result = runWithTsx(["--dry-run"], { DATABASE_URL: "" });

    expect(result.output).toContain("DATABASE_URL is not set");
    expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.status).not.toBe(0);
  }, 35000);

  it("2. plain node with no DATABASE_URL ALSO reaches the guard cleanly - the two loaders only diverge once imports are attempted", () => {
    const result = runWithNode(["--dry-run"], { DATABASE_URL: "" });

    expect(result.output).toContain("DATABASE_URL is not set");
    expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.status).not.toBe(0);
  }, 35000);

  it("3. plain node, once past the guard, fails at the TypeScript import itself - never reaches a connection attempt", () => {
    const result = runWithNode(["--dry-run"], {
      DATABASE_URL: UNREACHABLE_DB_URL,
    });

    // The hardened catch prints error.message ("Cannot find module ...")
    // rather than error.code - both name the same node ESM resolver failure.
    expect(result.output).toMatch(/Cannot find module/);
    expect(result.output).toMatch(/Failed to load a TypeScript application module/);
    // Node's hardened catch (added alongside this test) names the fix.
    expect(result.output).toMatch(/must be run through tsx/);
    expect(result.output).toMatch(/pnpm backfill:slip-claims/);
    // Proves it never got far enough to touch a database: no connection
    // error, no mysql2 error code, of any kind.
    expect(result.output).not.toMatch(/ECONNREFUSED|ER_ACCESS_DENIED|ETIMEDOUT/);
    expect(result.status).not.toBe(0);
  }, 35000);

  it("4. tsx, given the same DATABASE_URL, resolves the ENTIRE dependency graph and reaches a real connection attempt - proving the loader, not the destination, was the fix", () => {
    const result = runWithTsx(["--dry-run"], {
      DATABASE_URL: UNREACHABLE_DB_URL,
    });

    // The import graph resolved completely - no module-not-found, no alias
    // failure - so execution reached mysql2's own connection attempt.
    expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.output).not.toMatch(/Cannot find package|Cannot find module/);
    expect(result.output).toMatch(/ECONNREFUSED|ETIMEDOUT|ECONNRESET/);
    // Never actually connected, so never actually ran a backfill (dry-run
    // still requires a working connection to query anything).
    expect(result.output).not.toMatch(/\[backfill\] (Scanned|Would insert|Inserted)/);
    expect(result.status).not.toBe(0);
  }, 35000);
});
