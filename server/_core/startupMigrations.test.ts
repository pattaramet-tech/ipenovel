import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  StartupMigrationError,
  shouldRunStartupMigrations,
  migrationScriptCandidates,
  resolveMigrationScriptPath,
  runStartupMigrations,
} from "./startupMigrations";

/**
 * DB-independent coverage for the startup migration enforcement that makes
 * a direct `node dist/index.js` start safe (the hosting platform bypassed
 * package.json during the incident, so migrations never ran and production
 * stayed at migration 0023).
 *
 * Covers Test 3 (a migration failure must block the server) and Test 4 (a
 * missing migration script must fail closed) at the unit level, with an
 * injected spawn so no real child process, database, or network is used.
 * See startupFailClosed.subprocess.test.ts for the real built-executable
 * version of the same guarantees.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

/** A fake child process that reports the given outcome on next tick. */
function fakeSpawn(outcome: { code?: number | null; signal?: string | null; launchError?: Error }) {
  return ((..._args: any[]) => {
    const child = new EventEmitter() as any;
    process.nextTick(() => {
      if (outcome.launchError) {
        child.emit("error", outcome.launchError);
        return;
      }
      child.emit("close", outcome.code ?? 0, outcome.signal ?? null);
    });
    return child;
  }) as any;
}

const VALID_ENV = { DATABASE_URL: "mysql://user:pass@127.0.0.1:3306/disposable_test" };

describe("shouldRunStartupMigrations - NODE_ENV gating", () => {
  it("skips only for explicit development and test", () => {
    expect(shouldRunStartupMigrations("development")).toBe(false);
    expect(shouldRunStartupMigrations("test")).toBe(false);
    expect(shouldRunStartupMigrations("DEVELOPMENT")).toBe(false);
    expect(shouldRunStartupMigrations("  test  ")).toBe(false);
  });

  it("runs for production, undefined, empty and any other value", () => {
    // undefined is the critical case: the platform ran `node dist/index.js`
    // directly, where NODE_ENV may not be set at all.
    expect(shouldRunStartupMigrations(undefined)).toBe(true);
    expect(shouldRunStartupMigrations("")).toBe(true);
    expect(shouldRunStartupMigrations("production")).toBe(true);
    expect(shouldRunStartupMigrations("staging")).toBe(true);
    expect(shouldRunStartupMigrations("preview")).toBe(true);
  });
});

describe("migration script discovery", () => {
  it("offers candidates for both bundled (dist/) and source (server/_core/) layouts", () => {
    const fromDist = migrationScriptCandidates(path.join(repoRoot, "dist"), repoRoot);
    const fromSource = migrationScriptCandidates(path.join(repoRoot, "server", "_core"), repoRoot);
    const real = path.join(repoRoot, "scripts", "migrate.mjs");

    expect(fromDist).toContain(real);
    expect(fromSource).toContain(real);
  });

  it("derives candidates from the working directory as well as the module location", () => {
    const candidates = migrationScriptCandidates("/nowhere/at/all", repoRoot);
    expect(candidates).toContain(path.join(repoRoot, "scripts", "migrate.mjs"));
  });

  it("resolves the real scripts/migrate.mjs in this repository", () => {
    const resolved = resolveMigrationScriptPath(migrationScriptCandidates(path.join(repoRoot, "dist"), repoRoot));
    expect(fs.existsSync(resolved)).toBe(true);
    expect(resolved.replace(/\\/g, "/")).toMatch(/scripts\/migrate\.mjs$/);
  });

  it("Test 4: throws a sanitized StartupMigrationError when the script cannot be found anywhere", () => {
    expect(() => resolveMigrationScriptPath(["/does/not/exist/migrate.mjs", "/also/missing/migrate.mjs"])).toThrow(
      StartupMigrationError
    );
    try {
      resolveMigrationScriptPath(["/does/not/exist/migrate.mjs"]);
    } catch (error: any) {
      expect(error.message).toContain("Could not locate scripts/migrate.mjs");
      expect(error.message).toContain("refusing to start");
    }
  });
});

describe("runStartupMigrations - every failure mode is fatal", () => {
  it("rejects when DATABASE_URL is missing, without spawning anything", async () => {
    let spawned = false;
    const spawnFn = ((..._a: any[]) => {
      spawned = true;
      return new EventEmitter() as any;
    }) as any;

    await expect(
      runStartupMigrations({ env: {}, scriptPath: "/tmp/whatever.mjs", spawnFn })
    ).rejects.toThrow(StartupMigrationError);
    expect(spawned).toBe(false);
  });

  it("rejects when DATABASE_URL is present but blank", async () => {
    await expect(
      runStartupMigrations({ env: { DATABASE_URL: "   " }, scriptPath: "/tmp/x.mjs", spawnFn: fakeSpawn({ code: 0 }) })
    ).rejects.toThrow(StartupMigrationError);
  });

  it("Test 3: rejects on a non-zero migration exit code", async () => {
    await expect(
      runStartupMigrations({ env: VALID_ENV, scriptPath: "/tmp/x.mjs", spawnFn: fakeSpawn({ code: 1 }) })
    ).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when the migration process is killed by a signal", async () => {
    await expect(
      runStartupMigrations({ env: VALID_ENV, scriptPath: "/tmp/x.mjs", spawnFn: fakeSpawn({ code: null, signal: "SIGKILL" }) })
    ).rejects.toThrow(/terminated by signal SIGKILL/);
  });

  it("rejects when the child process cannot be launched at all", async () => {
    await expect(
      runStartupMigrations({
        env: VALID_ENV,
        scriptPath: "/tmp/x.mjs",
        spawnFn: fakeSpawn({ launchError: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
      })
    ).rejects.toThrow(/Failed to launch the migration process/);
  });

  it("resolves only when the migration process exits 0", async () => {
    await expect(
      runStartupMigrations({ env: VALID_ENV, scriptPath: "/tmp/x.mjs", spawnFn: fakeSpawn({ code: 0 }) })
    ).resolves.toBeUndefined();
  });

  it("never includes the DATABASE_URL value in any thrown error", async () => {
    const secretEnv = { DATABASE_URL: "mysql://produser:SuperSecret123@db.internal.example.com:3306/ipenovel" };
    try {
      await runStartupMigrations({ env: secretEnv, scriptPath: "/tmp/x.mjs", spawnFn: fakeSpawn({ code: 1 }) });
      throw new Error("should have rejected");
    } catch (error: any) {
      expect(error.message).not.toContain("SuperSecret123");
      expect(error.message).not.toContain("produser");
      expect(error.message).not.toContain("db.internal.example.com");
    }
  });
});

describe("the built server bootstrap wires migrations before listen()", () => {
  /** Comments are stripped so these assertions describe real code, never prose that merely quotes the old pattern. */
  function codeOnly(source: string): string {
    return source
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  const indexSource = codeOnly(fs.readFileSync(path.join(repoRoot, "server", "_core", "index.ts"), "utf8"));

  it("awaits ensureDatabaseMigrated before constructing express or listening", () => {
    const migrateIndex = indexSource.indexOf("await ensureDatabaseMigrated()");
    const expressIndex = indexSource.indexOf("const app = express()");
    // The real HTTP listener, anchored on the line it logs. isPortAvailable's
    // throwaway probe socket uses textually identical `server.listen(port,`,
    // but is only ever reached from findAvailablePort - i.e. after
    // migrations - so the announcement is the unambiguous marker.
    const listenIndex = indexSource.lastIndexOf("server.listen(port,");
    const runningLogIndex = indexSource.indexOf("Server running on");

    expect(migrateIndex).toBeGreaterThan(-1);
    expect(expressIndex).toBeGreaterThan(migrateIndex);
    expect(listenIndex).toBeGreaterThan(migrateIndex);
    expect(runningLogIndex).toBeGreaterThan(migrateIndex);
  });

  it("fails closed with a non-zero exit code and never logs the raw error object", () => {
    expect(indexSource).not.toContain("startServer().catch(console.error)");
    expect(indexSource).toMatch(/process\.exitCode\s*=\s*1/);
    expect(indexSource).toContain("safeErrorSummary(error)");
  });

  it("does not reimplement drizzle migration logic in the server bootstrap", () => {
    expect(indexSource).not.toContain("drizzle-orm/mysql2/migrator");
    expect(indexSource).not.toContain("migrationsFolder");
  });
});

describe("package.json no longer double-runs migrations", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  it("start only launches the built executable (which migrates itself)", () => {
    expect(pkg.scripts.start).toBe("NODE_ENV=production node dist/index.js");
    expect(pkg.scripts.start).not.toContain("scripts/migrate.mjs");
  });

  it("keeps the manual db:migrate command pointing at the single migration implementation", () => {
    expect(pkg.scripts["db:migrate"]).toBe("node scripts/migrate.mjs");
  });
});
