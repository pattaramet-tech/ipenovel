#!/usr/bin/env node
// `pnpm test:gate:b` - Gate B: prepares the disposable test database, then
// runs ONLY the migration-0024 integration test file. Each step is spawned
// as its own directly-executed child process (never a shell pipeline,
// never piped through `tee`), so this script's own exit code is always the
// real exit code of whichever step failed - never masked by an
// intermediate shell/pipe stage. See docs/TEST_INFRASTRUCTURE.md's
// `set -o pipefail` note for the exact failure class (a real Gate A run
// printed an error but the surrounding pipeline still reported Exit Code
// 0) this design avoids entirely by construction: there is no pipe here to
// mask anything in the first place.
//
// Never reads or forwards process.env.DATABASE_URL as a substitute for
// TEST_DATABASE_URL - both spawned steps read TEST_DATABASE_URL only
// (enforced by scripts/test-db-prepare.ts and
// vitest.integration.globalsetup.ts themselves), exactly like every other
// test-database command in this repo. This script does not read either
// variable itself; it only forwards the existing process environment
// unchanged to each child process.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_0024_TEST_FILE = "server/migration-0024-episode-schema-repair.integration.test.ts";

export interface GateBStep {
  label: string;
  command: string;
  args: string[];
}

/**
 * Exactly two steps, run in this order: prepare the disposable test
 * database, then run only the migration-0024 integration test file (never
 * the full integration suite - that is `pnpm test:integration`'s job).
 * Both are spawned via `pnpm` directly (no shell pipeline) so each step
 * always uses this repo's own, single source-of-truth script definitions
 * (package.json's `test:db:prepare`) rather than a second, potentially
 * drifting hardcoded invocation.
 */
export const GATE_B_STEPS: GateBStep[] = [
  { label: "pnpm test:db:prepare", command: "pnpm", args: ["run", "test:db:prepare"] },
  {
    label: "migration-0024 integration test",
    command: "pnpm",
    args: ["exec", "vitest", "run", "-c", "vitest.integration.config.ts", MIGRATION_0024_TEST_FILE],
  },
];

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawnSync>[2]
) => SpawnSyncReturns<Buffer | string>;

/**
 * Runs `steps` sequentially, each as its own directly-spawned child process
 * (never a shell pipe/tee) via `spawnFn` (defaults to Node's real
 * `spawnSync` - injectable so unit tests can prove this control flow with a
 * fake, without ever spawning a real process, running a real migration, or
 * touching a database).
 *
 * Stops at the FIRST nonzero exit code and returns it immediately - later
 * steps are never executed once an earlier one fails (a `pnpm
 * test:db:prepare` failure must never be followed by an attempt to run the
 * integration test file against an unprepared/partially-prepared
 * database). Returns 0 only if every step's own exit code was exactly 0. A
 * failed test run inside Vitest is never reinterpreted as success - the
 * child's own exit code is trusted and returned as-is.
 */
export function runGateBSteps(steps: GateBStep[] = GATE_B_STEPS, spawnFn: SpawnSyncFn = spawnSync as SpawnSyncFn): number {
  for (const step of steps) {
    console.log(`\n[test:gate:b] === ${step.label} ===`);
    // On win32, `shell: true` hands the whole command line to cmd.exe,
    // which does NOT treat `step.command` as a single pre-resolved
    // executable the way a shell-less spawn does - an unquoted path
    // containing a space (e.g. a full path to node.exe under
    // "C:\Program Files\...") would be misparsed as two separate tokens.
    // Quoting the command defensively here costs nothing for the common
    // case (a bare, space-free name like "pnpm") and makes this safe for
    // any future step whose command happens to be a full path.
    const commandForSpawn = process.platform === "win32" ? `"${step.command}"` : step.command;
    const result = spawnFn(commandForSpawn, step.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env },
      // Shell is used ONLY on win32, and ONLY to resolve a single
      // .cmd-shimmed executable (pnpm) - this is NOT a shell pipeline
      // (there is no `|`, no `tee`, no chained command here at all), so it
      // does not introduce the exit-code-masking risk a real pipe would;
      // the child's own exit code still reaches `result.status` unmodified.
      shell: process.platform === "win32",
    });

    if (result.error) {
      console.error(`[test:gate:b] Failed to run "${step.label}": ${result.error.message}`);
      return 1;
    }

    const status = result.status ?? 1;
    if (status !== 0) {
      console.error(
        `[test:gate:b] "${step.label}" failed with exit code ${status} - stopping here; later steps are never run after a failure.`
      );
      return status;
    }

    console.log(`[test:gate:b] "${step.label}" succeeded.`);
  }

  return 0;
}

/**
 * Test-only override, opt-in via environment variable - mirrors the same
 * pattern already used by IPENOVEL_TEST_DB_DIAGNOSTICS elsewhere in this
 * repo (server/test-helpers/testDbDiagnostics.ts): lets a DB-independent
 * subprocess test point this real CLI entrypoint at small, harmless
 * stand-in commands instead of the real `pnpm test:db:prepare`/vitest
 * steps, without ever touching a database. Unset (the default) on every
 * real invocation - the exported `GATE_B_STEPS` constant `runGateBSteps()`
 * itself defaults to is never affected by this; only the CLI entrypoint
 * below ever reads it.
 */
function resolveStepsForCli(): GateBStep[] {
  const override = process.env.IPENOVEL_GATE_B_STEPS_OVERRIDE;
  if (!override) return GATE_B_STEPS;
  return JSON.parse(override);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Setting exitCode (not calling process.exit()) lets Node exit naturally
  // once the event loop is actually empty - both spawned steps above are
  // synchronous (spawnSync), so nothing is left pending by the time this
  // runs regardless.
  process.exitCode = runGateBSteps(resolveStepsForCli());
}
