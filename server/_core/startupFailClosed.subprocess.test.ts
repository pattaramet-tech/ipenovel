import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests 3 and 4 against the REAL built executable - the artifact the
 * hosting platform actually runs.
 *
 * These spawn `node dist/index.js` exactly the way the platform did during
 * the incident (bypassing package.json entirely) and assert it refuses to
 * open a port when migrations cannot succeed.
 *
 * Database safety: DATABASE_URL is always overridden here - either blank or
 * pointed at 127.0.0.1:1, a port nothing listens on. dotenv does not
 * override an environment variable that is already present, so the
 * repository's own .env can never be picked up by these runs. No real
 * database is ever contacted.
 *
 * Skipped (not failed) when dist/index.js has not been built, so the unit
 * project stays runnable without a prior `pnpm build`.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const hasBuild = fs.existsSync(distEntry);

/** An address on localhost with nothing listening - connection is refused immediately. */
const UNREACHABLE_DB_URL = "mysql://disposable:disposable@127.0.0.1:1/ipenovel_disposable_test";

function runBuiltServer(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [distEntry], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      // Never inherit a real database from the ambient environment or .env.
      DATABASE_URL: "",
      NODE_ENV: "production",
      PORT: "0",
      ...env,
    },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe.skipIf(!hasBuild)("Test 3/4 - the built executable fails closed (real subprocess)", () => {
  it("Test 4: refuses to start when no database is configured, exiting non-zero", () => {
    const result = runBuiltServer({ DATABASE_URL: "" });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).not.toContain("Server running");
    expect(result.output).toContain("[startup] FATAL");
  }, 130000);

  it("Test 3: a failing migration blocks startup - no port opened, non-zero exit, nothing leaked", () => {
    const result = runBuiltServer({ DATABASE_URL: UNREACHABLE_DB_URL });

    // The server must never have listened.
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).not.toContain("Server running");

    // The migration step must have been reached and reported failure.
    expect(result.output).toMatch(/\[migrate\]|\[startup\]/);

    // Nothing sensitive may appear in the output.
    expect(result.output).not.toContain("disposable:disposable");
    expect(result.output).not.toContain(UNREACHABLE_DB_URL);
    expect(result.output).not.toMatch(/failed\s+query/i);
    expect(result.output).not.toContain("params:");
  }, 130000);

  it("the migration step runs before any 'Server running' line can be printed", () => {
    const result = runBuiltServer({ DATABASE_URL: UNREACHABLE_DB_URL });
    const startupIndex = result.output.indexOf("[startup] Running database migrations");
    const serverIndex = result.output.indexOf("Server running");

    expect(startupIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBe(-1);
  }, 130000);
});

describe.skipIf(!hasBuild)("the built executable contains the bootstrap enforcement", () => {
  it("bundles the startup migration runner and the sanitizer", () => {
    const bundle = fs.readFileSync(distEntry, "utf8");
    expect(bundle).toContain("Running database migrations before opening any port");
    expect(bundle).toContain("[redacted-connection-string]");
  });
});
