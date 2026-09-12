import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeDatabaseUrl,
  checkRequiredEnvVars,
  checkOptionalGroups,
  checkWorkspaceAiQcProviderEnv,
  checkWorkspaceAiQcExecutionEnv,
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

describe("checkWorkspaceAiQcProviderEnv", () => {
  it("enables only on the exact literal true and requires URL/key/model together", () => {
    const disabled = checkWorkspaceAiQcProviderEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "TRUE",
      WORKSPACE_AI_QC_PROVIDER_API_KEY: "secret-value",
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.partiallyConfigured).toBe(true);
    expect(JSON.stringify(disabled)).not.toContain("secret-value");

    const enabled = checkWorkspaceAiQcProviderEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_API_URL: "https://ai.example/v1/chat/completions",
      WORKSPACE_AI_QC_PROVIDER_API_KEY: "secret-value",
      WORKSPACE_AI_QC_PROVIDER_MODEL: "qc-model",
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.configured).toBe(true);
    expect(enabled.missing).toEqual([]);
    expect(JSON.stringify(enabled)).not.toContain("secret-value");
  });

  it("reports only missing ENV names for an enabled partial configuration", () => {
    const result = checkWorkspaceAiQcProviderEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_API_URL: "https://ai.example/v1/chat/completions",
    });
    expect(result.configured).toBe(false);
    expect(result.missing).toEqual([
      "WORKSPACE_AI_QC_PROVIDER_API_KEY",
      "WORKSPACE_AI_QC_PROVIDER_MODEL",
    ]);
  });

  it("treats whitespace-only required values as missing and reports malformed non-secret fields by name", () => {
    const whitespace = checkWorkspaceAiQcProviderEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_API_URL: "   ",
      WORKSPACE_AI_QC_PROVIDER_API_KEY: "   ",
      WORKSPACE_AI_QC_PROVIDER_MODEL: "   ",
    });
    expect(whitespace.missing).toEqual([
      "WORKSPACE_AI_QC_PROVIDER_API_URL",
      "WORKSPACE_AI_QC_PROVIDER_API_KEY",
      "WORKSPACE_AI_QC_PROVIDER_MODEL",
    ]);

    const invalid = checkWorkspaceAiQcProviderEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_API_URL: "not-a-url",
      WORKSPACE_AI_QC_PROVIDER_API_KEY: "secret-value",
      WORKSPACE_AI_QC_PROVIDER_MODEL: "qc-model",
      WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS: "0",
    });
    expect(invalid.configured).toBe(false);
    expect(invalid.invalid).toEqual([
      "WORKSPACE_AI_QC_PROVIDER_API_URL",
      "WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS",
    ]);
    expect(JSON.stringify(invalid)).not.toContain("secret-value");
  });
});
describe("checkWorkspaceAiQcExecutionEnv", () => {
  it("stays disabled unless exact true and requires provider, reconcile URL, and exact scope when enabled", () => {
    expect(checkWorkspaceAiQcExecutionEnv({ WORKSPACE_AI_QC_EXECUTION_ENABLED: "TRUE" })).toEqual({ enabled: false, configured: true, missing: [], invalid: [] });
    const result = checkWorkspaceAiQcExecutionEnv({ WORKSPACE_AI_QC_EXECUTION_ENABLED: "true" });
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(false);
    expect(result.missing).toEqual(["WORKSPACE_AI_QC_PROVIDER_ENABLED", "WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE", "WORKSPACE_AI_QC_EXECUTION_SCOPE"]);
  });

  it("accepts one exact scope and rejects malformed scope or out-of-bound worker controls", () => {
    const requestKey = "a".repeat(64);
    const ready = checkWorkspaceAiQcExecutionEnv({
      WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE: "https://ai.example/requests/{providerRequestId}",
      WORKSPACE_AI_QC_EXECUTION_SCOPE: `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`,
      WORKSPACE_AI_QC_LEASE_SECONDS: "60",
      WORKSPACE_AI_QC_MAX_ATTEMPTS: "3",
    });
    expect(ready).toEqual({ enabled: true, configured: true, missing: [], invalid: [] });
    const invalid = checkWorkspaceAiQcExecutionEnv({
      WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE: "https://ai.example/requests/{providerRequestId}",
      WORKSPACE_AI_QC_EXECUTION_SCOPE: "workspaceId=7,jobId=11,snapshotId=13,requestKey=not-a-sha",
      WORKSPACE_AI_QC_LEASE_SECONDS: "301",
      WORKSPACE_AI_QC_MAX_ATTEMPTS: "11",
    });
    expect(invalid.configured).toBe(false);
    expect(invalid.invalid).toEqual(["WORKSPACE_AI_QC_EXECUTION_SCOPE", "WORKSPACE_AI_QC_LEASE_SECONDS", "WORKSPACE_AI_QC_MAX_ATTEMPTS"]);
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

  it("flags a .sql file on disk that the journal never references (the real 0023_gifted_juggernaut.sql class of discrepancy)", () => {
    const result = checkMigrationJournalConsistency(
      ["0000_needy_anthem.sql", "0099_some_orphan_file.sql"],
      [{ tag: "0000_needy_anthem" }, { tag: "0003_flippant_moondragon" }]
    );
    expect(result.consistent).toBe(false);
    expect(result.filesNotInJournal).toEqual(["0099_some_orphan_file"]);
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

  it("fails closed when AI QC is explicitly enabled with incomplete provider ENV and never prints the supplied secret", () => {
    const secret = "preflight-secret-must-not-print";
    const result = spawnSync(process.execPath, [preflightPath, "--ack-read-only"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "mysql://user:pw@localhost/ipenovel_test",
        JWT_SECRET: "x",
        VITE_APP_ID: "x",
        OAUTH_SERVER_URL: "https://oauth.example.test",
        WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
        WORKSPACE_AI_QC_PROVIDER_API_URL: "https://ai.example.test/v1/chat/completions",
        WORKSPACE_AI_QC_PROVIDER_API_KEY: secret,
        WORKSPACE_AI_QC_PROVIDER_MODEL: "",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("WORKSPACE_AI_QC_PROVIDER_MODEL");
    expect(result.stdout).not.toContain(secret);
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

  it("reports the real repo's one remaining known/classified orphan file (0023_gifted_juggernaut) as expected, not as a new/unexpected discrepancy - and never prints any file's contents (0003_admin_seed.sql/LOCAL_ADMIN_BOOTSTRAP.sql were deleted by security/remove-local-admin-password-login and no longer exist to appear as orphans at all)", () => {
    const result = spawnSync(process.execPath, [preflightPath, "--ack-read-only"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "x", JWT_SECRET: "x", VITE_APP_ID: "x", OAUTH_SERVER_URL: "x" },
    });
    expect(result.stdout).toMatch(/known\/classified orphan/);
    expect(result.stdout).not.toMatch(/UNEXPECTED/);
    // Never leaks a credential-shaped value into the report - only file/tag
    // names ever appear.
    expect(result.stdout).not.toMatch(/bcrypt|passwordHash|\$2a\$/i);
  });
});
