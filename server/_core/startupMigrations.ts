// Enforces database migrations from inside the server executable itself,
// before any network port is opened.
//
// Why this exists: a production incident shipped an artifact that contained
// scripts/migrate.mjs, a correct `start` script, and migrations through
// 0029 - but the hosting platform started the app by invoking
// `node dist/index.js` directly, bypassing package.json entirely. No
// migration ever ran, production stayed at migration 0023, and the new
// application code immediately queried a `dailyCheckins` table that did not
// exist. Relying on package.json alone is therefore not sufficient: the
// built executable has to enforce this itself.
//
// This module deliberately does NOT reimplement any migration logic. It
// locates and executes the existing scripts/migrate.mjs - the single
// migration implementation, which also performs the post-migration
// read-only schema verification - and treats every failure mode as fatal.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeErrorSummary, redactSensitiveText } from "../../scripts/lib/safeErrorSummary.mjs";

/** Thrown for every fatal startup-migration condition. Its message is always already sanitized. */
export class StartupMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupMigrationError";
  }
}

/**
 * True when startup migrations must run for this NODE_ENV.
 *
 * Deliberately an allowlist of skip values rather than a check for
 * "production": the incident happened precisely because the platform ran
 * the built executable directly, where NODE_ENV may be absent entirely.
 * Anything that is not explicitly a local development or test run -
 * including undefined - migrates.
 */
export function shouldRunStartupMigrations(nodeEnv: string | undefined): boolean {
  // Takes the value explicitly (rather than defaulting to
  // process.env.NODE_ENV) so that passing `undefined` unambiguously means
  // "NODE_ENV is not set" - the exact production case - instead of silently
  // falling back to the ambient environment.
  const normalized = (nodeEnv ?? "").trim().toLowerCase();
  return normalized !== "development" && normalized !== "test";
}

/**
 * Candidate locations for scripts/migrate.mjs, in priority order, derived
 * from both this module's own location and the process working directory
 * so the same code works whether it runs as TypeScript source under tsx
 * (server/_core/startupMigrations.ts) or bundled into dist/index.js - and
 * regardless of which directory the platform happens to start the process
 * from.
 */
export function migrationScriptCandidates(moduleDir: string, cwd: string = process.cwd()): string[] {
  const relative = path.join("scripts", "migrate.mjs");
  return [
    // Bundled: dist/index.js -> <repo>/scripts/migrate.mjs
    path.resolve(moduleDir, "..", relative),
    // Source under tsx: server/_core/ -> <repo>/scripts/migrate.mjs
    path.resolve(moduleDir, "..", "..", relative),
    // Defensive: one level deeper, and alongside the module itself.
    path.resolve(moduleDir, "..", "..", "..", relative),
    path.resolve(moduleDir, relative),
    // Working-directory derived - the platform may start from the repo root
    // or from inside dist/.
    path.resolve(cwd, relative),
    path.resolve(cwd, "..", relative),
  ];
}

function currentModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Resolves the migration script, or throws a fatal error listing only relative candidate names (never absolute deployment paths). */
export function resolveMigrationScriptPath(candidates: string[]): string {
  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

  if (!found) {
    throw new StartupMigrationError(
      `Could not locate scripts/migrate.mjs (checked ${candidates.length} candidate location(s)). ` +
        "The deployed artifact is incomplete - refusing to start the server without running migrations."
    );
  }
  return found;
}

export interface RunStartupMigrationsOptions {
  /** Overrides script discovery. Test-only. */
  scriptPath?: string;
  /** Overrides candidate discovery. Test-only. */
  candidates?: string[];
  /** Environment forwarded to the child. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected spawn, for tests. Defaults to node:child_process spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Runs scripts/migrate.mjs to completion using the same Node binary as this
 * process, inheriting stdio so the migrator's own markers stay visible in
 * platform logs:
 *
 *   [migrate] Acquiring migration lock
 *   [migrate] Lock acquired
 *   [migrate] Done - schema is up to date
 *   [migrate] Migration failed
 *
 * Resolves only when the migration process exited 0 (which, per
 * scripts/migrate.mjs, also means post-migration schema verification
 * passed). Every other outcome - missing DATABASE_URL, script not found,
 * spawn failure, non-zero exit, termination by signal - throws a
 * StartupMigrationError so the caller can fail closed.
 *
 * The child environment is forwarded as-is; DATABASE_URL is never read,
 * logged, or included in any error raised here.
 */
export async function runStartupMigrations(options: RunStartupMigrationsOptions = {}): Promise<void> {
  const env = options.env ?? process.env;

  // Fail before spawning anything if there is no database to migrate -
  // the value itself is never read into a message.
  if (!env.DATABASE_URL || String(env.DATABASE_URL).trim() === "") {
    throw new StartupMigrationError(
      "DATABASE_URL is not set - refusing to start the server without a known database to migrate."
    );
  }

  const scriptPath =
    options.scriptPath ?? resolveMigrationScriptPath(options.candidates ?? migrationScriptCandidates(currentModuleDir()));

  const spawnFn = options.spawnFn ?? spawn;

  console.log("[startup] Running database migrations before opening any port...");

  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, [scriptPath], {
        // Inherit so [migrate] markers reach the platform's log stream
        // unbuffered and unmodified.
        stdio: "inherit",
        env,
      });
    } catch (error) {
      reject(
        new StartupMigrationError(`Failed to launch the migration process: ${safeErrorSummary(error)}`)
      );
      return;
    }

    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new StartupMigrationError(`Failed to launch the migration process: ${safeErrorSummary(error)}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (signal) {
        reject(
          new StartupMigrationError(
            `Migration process was terminated by signal ${redactSensitiveText(String(signal))} before completing.`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new StartupMigrationError(
            `Migration process exited with code ${code ?? "unknown"} - see the [migrate] output above. ` +
              "Refusing to start the server against an unmigrated or unverified schema."
          )
        );
        return;
      }
      resolve();
    });
  });

  console.log("[startup] Migrations and schema verification completed successfully.");
}

/**
 * The bootstrap entry point: migrates unless this is an explicit
 * development/test run. Any failure propagates to the caller, which must
 * fail closed (never listen, exit non-zero).
 */
export async function ensureDatabaseMigrated(options: RunStartupMigrationsOptions = {}): Promise<void> {
  if (!shouldRunStartupMigrations(process.env.NODE_ENV)) {
    console.log(
      `[startup] NODE_ENV=${process.env.NODE_ENV} - skipping automatic startup migrations (run "pnpm db:migrate" manually).`
    );
    return;
  }
  await runStartupMigrations(options);
}
