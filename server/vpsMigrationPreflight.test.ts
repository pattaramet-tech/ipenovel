import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeDatabaseUrl,
  checkRequiredEnvVars,
  checkOptionalGroups,
  checkMigrationJournalConsistency,
} from "../scripts/vps-migration/preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflightPath = path.join(repoRoot, "scripts", "vps-migration", "preflight.mjs");

describe("describeDatabaseUrl", () => {
  it("never returns the password, even though it parses it internally", () => {
    const result = describeDatabaseUrl("mysql://myuser:supersecretpw@db.internal:3306/ipenovel");
    expect(JSON.stringify(result)).not.toMatch(/supersecretpw/);
  });

  it("reports host/port/database/username-present/password-present without the raw credential values", () => {
    const result = describeDatabaseUrl("mysql://myuser:supersecretpw@db.internal:3306/ipenovel");
    expect(result).toEqual({
      present: true,
      parses: true,
      protocol: "mysql",
      host: "db.internal",
      port: "3306",
      database: "ipenovel",
      hasUsername: true,
      hasPassword: true,
    });
  });

  it("reports present:false when DATABASE_URL is unset/empty", () => {
    expect(describeDatabaseUrl(undefined)).toEqual({ present: false });
    expect(describeDatabaseUrl("")).toEqual({ present: false });
  });

  it("reports parses:false (not a crash) for a garbage value, and the garbage never leaks into the result", () => {
    const result = describeDatabaseUrl("not-a-url-at-all");
    expect(result).toEqual({ present: true, parses: false });
  });

  it("reports default port as '(default)' when the URL omits it", () => {
    const result = describeDatabaseUrl("mysql://user:pw@db.internal/ipenovel");
    expect(result.port).toBe("(default)");
  });
});

describe("checkRequiredEnvVars", () => {
  it("reports only the NAMES of missing required variables, never any value", () => {
    const result = checkRequiredEnvVars({ DATABASE_URL: "mysql://x", JWT_SECRET: "shh-secret-value" });
    expect(result.missing).toEqual(["VITE_APP_ID", "OAUTH_SERVER_URL"]);
    expect(result.present).toEqual(["DATABASE_URL", "JWT_SECRET"]);
    expect(JSON.stringify(result)).not.toMatch(/shh-secret-value/);
  });

  it("reports every required variable present when all four are set", () => {
    const result = checkRequiredEnvVars({
      DATABASE_URL: "x",
      JWT_SECRET: "x",
      VITE_APP_ID: "x",
      OAUTH_SERVER_URL: "x",
    });
    expect(result.missing).toEqual([]);
  });

  it("treats an empty string the same as unset (missing)", () => {
    const result = checkRequiredEnvVars({ DATABASE_URL: "", JWT_SECRET: "x", VITE_APP_ID: "x", OAUTH_SERVER_URL: "x" });
    expect(result.missing).toEqual(["DATABASE_URL"]);
  });
});

describe("checkOptionalGroups", () => {
  it("reports a group as configured only when every variable in it is set", () => {
    const groups = checkOptionalGroups({
      R2_ACCOUNT_ID: "x",
      R2_ACCESS_KEY_ID: "x",
      R2_SECRET_ACCESS_KEY: "x",
      R2_BUCKET_NAME: "x",
      R2_PUBLIC_BASE_URL: "x",
      R2_ENDPOINT: "x",
    });
    const r2Public = groups.find((g) => g.group === "R2 (public bucket)");
    expect(r2Public?.configured).toBe(true);
    expect(r2Public?.partiallyConfigured).toBe(false);
  });

  it("reports a group as partially configured (and lists the missing names only) when some but not all vars are set", () => {
    const groups = checkOptionalGroups({ R2_ACCOUNT_ID: "x", R2_ACCESS_KEY_ID: "x" });
    const r2Public = groups.find((g) => g.group === "R2 (public bucket)");
    expect(r2Public?.configured).toBe(false);
    expect(r2Public?.partiallyConfigured).toBe(true);
    expect(r2Public?.missing).toEqual(["R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL", "R2_ENDPOINT"]);
  });

  it("reports a group as not configured when none of its vars are set", () => {
    const groups = checkOptionalGroups({});
    for (const g of groups) {
      expect(g.configured).toBe(false);
      expect(g.partiallyConfigured).toBe(false);
    }
  });

  it("never echoes any variable's value in the report shape - only names/booleans", () => {
    const groups = checkOptionalGroups({ R2_SECRET_ACCESS_KEY: "top-secret-r2-key-value" });
    expect(JSON.stringify(groups)).not.toMatch(/top-secret-r2-key-value/);
  });
});

describe("checkMigrationJournalConsistency", () => {
  it("reports consistent:true when every .sql file has a matching journal tag and vice versa", () => {
    const result = checkMigrationJournalConsistency(
      ["0000_needy_anthem.sql", "0001_steep_romulus.sql"],
      [{ tag: "0000_needy_anthem" }, { tag: "0001_steep_romulus" }]
    );
    expect(result.consistent).toBe(true);
    expect(result.filesNotInJournal).toEqual([]);
    expect(result.journalTagsWithNoFile).toEqual([]);
  });

  it("flags a .sql file on disk that the journal never references (the real 0003_admin_seed.sql/0023_gifted_juggernaut.sql class of discrepancy)", () => {
    const result = checkMigrationJournalConsistency(
      ["0000_needy_anthem.sql", "0003_admin_seed.sql"],
      [{ tag: "0000_needy_anthem" }, { tag: "0003_flippant_moondragon" }]
    );
    expect(result.consistent).toBe(false);
    expect(result.filesNotInJournal).toEqual(["0003_admin_seed"]);
    expect(result.journalTagsWithNoFile).toEqual(["0003_flippant_moondragon"]);
  });

  it("ignores non-.sql files (e.g. meta/, relations.ts, schema.ts siblings in the same directory listing)", () => {
    const result = checkMigrationJournalConsistency(
      ["0000_needy_anthem.sql", "meta", "schema.ts", "relations.ts"],
      [{ tag: "0000_needy_anthem" }]
    );
    expect(result.consistent).toBe(true);
    expect(result.sqlFileCount).toBe(1);
  });
});

describe("preflight.mjs CLI", () => {
  it("exits 1 and does nothing else when --ack-read-only is not passed", () => {
    const result = spawnSync(process.execPath, [preflightPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--ack-read-only/);
    // Confirms it bailed out before doing any of its real work (no report
    // section headers printed).
    expect(result.stdout).not.toMatch(/Required environment variables/);
  });

  it("runs its checks and exits with a status reflecting whether required env vars are present when --ack-read-only IS passed", () => {
    const result = spawnSync(process.execPath, [preflightPath, "--ack-read-only"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "", JWT_SECRET: "", VITE_APP_ID: "", OAUTH_SERVER_URL: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/MISSING/);
  });

  it("never prints a password even when DATABASE_URL (with a fake, obviously-not-real credential) is passed via env", () => {
    const result = spawnSync(process.execPath, [preflightPath, "--ack-read-only"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "mysql://testuser:should-never-be-printed@localhost:3306/ipenovel_test",
        JWT_SECRET: "x",
        VITE_APP_ID: "x",
        OAUTH_SERVER_URL: "x",
      },
    });
    expect(result.stdout).not.toMatch(/should-never-be-printed/);
    expect(result.stdout).toMatch(/database: ipenovel_test/);
  });

  it("reports the real repo's known/classified orphan files (0023_gifted_juggernaut, 0003_admin_seed, LOCAL_ADMIN_BOOTSTRAP) as expected, not as a new/unexpected discrepancy - and never prints any file's contents", () => {
    const result = spawnSync(process.execPath, [preflightPath, "--ack-read-only"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "x", JWT_SECRET: "x", VITE_APP_ID: "x", OAUTH_SERVER_URL: "x" },
    });
    expect(result.stdout).toMatch(/known\/classified orphan/);
    expect(result.stdout).not.toMatch(/UNEXPECTED/);
    // Never leaks the seed file's committed credential material into a
    // report - only file/tag names ever appear.
    expect(result.stdout).not.toMatch(/bcrypt|passwordHash|\$2a\$/i);
  });
});
