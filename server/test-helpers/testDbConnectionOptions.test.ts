import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildTestDbConnectionOptions,
  isLoopbackTestHost,
  isDockerInternalSingleLabelHost,
  parseTestDbTransportMode,
} from "./testDbConnectionOptions";
import { redactDatabaseUrl } from "./testDatabaseGuard";

const repoRoot = path.resolve(__dirname, "..", "..");

// A real TiDB Cloud Starter gateway hostname shape - the exact class of URL
// that a Manus integration run previously rejected with "Connections using
// insecure transport are prohibited" because no TLS options were set.
const TIDB_URL = "mysql://appuser:S3cr%40tPass@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_test";

// A Docker/Coolify-internal single-label service hostname shape - the exact
// class of host a Coolify-hosted MariaDB integration run connects to
// internally, whose self-signed certificate fails `rejectUnauthorized: true`.
const COOLIFY_HOST = "x2wf26a5hdp9hivvnqk1g9am";
const COOLIFY_URL = `mysql://root:pw@${COOLIFY_HOST}:3306/ipenovel_test`;

function codeOnly(source: string): string {
  // Normalizes CRLF to LF first - see the matching fix/comment in
  // testDatabaseGuard.test.ts's codeOnly() for why this is required, not
  // optional (a real regression this exact task hit).
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("buildTestDbConnectionOptions - TLS (default transport mode)", () => {
  it("enables TLS for a real TiDB Cloud connection string", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl).toBeDefined();
    expect(typeof options.ssl).toBe("object");
  });

  it("sets ssl.minVersion to exactly TLSv1.2", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl.minVersion).toBe("TLSv1.2");
  });

  it("sets ssl.rejectUnauthorized to exactly true", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl.rejectUnauthorized).toBe(true);
  });

  it("never sets ssl.rejectUnauthorized to false and never adds a ca override", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl.rejectUnauthorized).not.toBe(false);
    expect(options.ssl).not.toHaveProperty("ca");
  });
});

describe("buildTestDbConnectionOptions - parsing", () => {
  it("decodes percent-encoded username and password for the actual connection", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.user).toBe("appuser");
    expect(options.password).toBe("S3cr@tPass");
  });

  it("extracts host, numeric port, and the exact database name", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.host).toBe("gateway01.ap-southeast-1.prod.aws.tidbcloud.com");
    expect(options.port).toBe(4000);
    expect(typeof options.port).toBe("number");
    expect(options.database).toBe("ipenovel_test");
  });

  it("defaults to port 3306 (as a number) when the URL omits a port", () => {
    const options = buildTestDbConnectionOptions("mysql://user:pw@localhost/ipenovel_test", undefined);
    expect(options.port).toBe(3306);
    expect(typeof options.port).toBe("number");
  });
});

describe("buildTestDbConnectionOptions - decoded credentials are usable internally but never logged", () => {
  it("the factory itself contains no console/logging call anywhere in its source", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "server/test-helpers/testDbConnectionOptions.ts"), "utf8"));
    expect(source).not.toMatch(/console\./);
  });

  it("redactDatabaseUrl (this repo's one sanctioned way to log a connection string) never leaks the credentials this factory decodes", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    const redacted = redactDatabaseUrl(TIDB_URL);
    expect(redacted).not.toContain(options.user);
    expect(redacted).not.toContain(options.password);
    expect(redacted).not.toContain("appuser");
    expect(redacted).not.toContain("S3cr@tPass");
    expect(redacted).not.toContain("S3cr%40tPass");
    expect(redacted).toBe("gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_test");
  });
});

describe("buildTestDbConnectionOptions - fails closed", () => {
  it("throws for a malformed URL", () => {
    expect(() => buildTestDbConnectionOptions("not-a-url", undefined)).toThrow();
  });

  it("throws for a missing TEST_DATABASE_URL (undefined, null, empty)", () => {
    expect(() => buildTestDbConnectionOptions(undefined, undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions(null, undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions("", undefined)).toThrow();
  });

  it("throws for any database name other than the exact literal ipenovel_test", () => {
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel_prod", undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel", undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel_test_backup", undefined)).toThrow();
  });

  it("still enforces the exact-name gate even for a legitimate-looking TiDB Cloud host with the wrong database name", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://user:pw@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_prod", undefined)
    ).toThrow();
  });
});

describe("isLoopbackTestHost - loopback-only integration-test TLS exception (NOT an application runtime policy)", () => {
  it.each(["127.0.0.1", "localhost", "::1", "LOCALHOST", "[::1]"])(
    "%s is recognized as loopback",
    (host) => {
      expect(isLoopbackTestHost(host)).toBe(true);
    }
  );

  it.each([
    "127.0.0.1.example.com",
    "localhost.example.com",
    "%6c%6f%63%61%6c%68%6f%73%74",
    "0177.0.0.1",
    "2130706433",
    "example.com",
    "203.0.113.5",
    "gateway01.ap-southeast-1.prod.aws.tidbcloud.com",
    "",
  ])("%s is never recognized as loopback (lookalikes and remote hosts fail closed)", (host) => {
    expect(isLoopbackTestHost(host)).toBe(false);
  });

  it("fails closed (false) for null/undefined rather than throwing", () => {
    expect(isLoopbackTestHost(null)).toBe(false);
    expect(isLoopbackTestHost(undefined)).toBe(false);
  });
});

describe("buildTestDbConnectionOptions - loopback-only integration-test TLS exception", () => {
  it("omits ssl entirely for 127.0.0.1 + ipenovel_test", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@127.0.0.1:3308/ipenovel_test", undefined);
    expect(options.ssl).toBeUndefined();
  });

  it("omits ssl entirely for localhost + ipenovel_test", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@localhost:3308/ipenovel_test", undefined);
    expect(options.ssl).toBeUndefined();
  });

  it("omits ssl entirely for [::1] (IPv6 loopback) + ipenovel_test", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@[::1]:3308/ipenovel_test", undefined);
    expect(options.ssl).toBeUndefined();
  });

  it("never sets rejectUnauthorized: false or ssl: false as the mechanism - ssl is simply absent from the object", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@127.0.0.1:3308/ipenovel_test", undefined);
    expect(options).not.toHaveProperty("ssl");
    expect(Object.prototype.hasOwnProperty.call(options, "ssl")).toBe(false);
  });

  it("still requires TLS for a remote hostname even with the exact test database name", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl).toBeDefined();
    expect(options.ssl?.rejectUnauthorized).toBe(true);
  });

  it("still requires TLS for a remote IP address even with the exact test database name", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@203.0.113.5:3306/ipenovel_test", undefined);
    expect(options.ssl).toBeDefined();
    expect(options.ssl?.rejectUnauthorized).toBe(true);
  });

  it.each(["127.0.0.1.example.com", "localhost.example.com"])(
    "lookalike host %s still requires TLS, never bypasses it",
    (host) => {
      const options = buildTestDbConnectionOptions(`mysql://root:pw@${host}:3306/ipenovel_test`, undefined);
      expect(options.ssl).toBeDefined();
      expect(options.ssl?.rejectUnauthorized).toBe(true);
    }
  );

  it("a percent-encoded host lookalike still requires TLS, never bypasses it", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@%6c%6f%63%61%6c%68%6f%73%74:3306/ipenovel_test", undefined);
    expect(options.ssl).toBeDefined();
    expect(options.ssl?.rejectUnauthorized).toBe(true);
  });

  it("a loopback host with a database name that is not the exact test database name is rejected outright (throws), never silently downgraded to no-TLS", () => {
    expect(() => buildTestDbConnectionOptions("mysql://root:pw@127.0.0.1:3308/ipenovel_prod", undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions("mysql://root:pw@localhost:3308/production", undefined)).toThrow();
  });

  it("a malformed URL fails closed (throws) rather than defaulting to skipping TLS", () => {
    expect(() => buildTestDbConnectionOptions("not-a-url", undefined)).toThrow();
  });
});

describe("parseTestDbTransportMode", () => {
  it('returns "internal_plaintext" only for the exact literal', () => {
    expect(parseTestDbTransportMode("internal_plaintext")).toBe("internal_plaintext");
  });

  it("returns undefined for anything else - unset, empty, or a typo - never silently enabling the special mode", () => {
    expect(parseTestDbTransportMode(undefined)).toBeUndefined();
    expect(parseTestDbTransportMode(null)).toBeUndefined();
    expect(parseTestDbTransportMode("")).toBeUndefined();
    expect(parseTestDbTransportMode("INTERNAL_PLAINTEXT")).toBeUndefined();
    expect(parseTestDbTransportMode("internal-plaintext")).toBeUndefined();
    expect(parseTestDbTransportMode(" internal_plaintext")).toBeUndefined();
    expect(parseTestDbTransportMode("plaintext")).toBeUndefined();
  });
});

describe("isDockerInternalSingleLabelHost", () => {
  it("recognizes a Coolify/Docker-internal single-label service hostname", () => {
    expect(isDockerInternalSingleLabelHost(COOLIFY_HOST)).toBe(true);
    expect(isDockerInternalSingleLabelHost("app_mariadb_1")).toBe(true);
  });

  it("rejects a dotted domain (real external host or a lookalike subdomain)", () => {
    expect(isDockerInternalSingleLabelHost("example.com")).toBe(false);
    expect(isDockerInternalSingleLabelHost("localhost.example.com")).toBe(false);
    expect(isDockerInternalSingleLabelHost("gateway01.ap-southeast-1.prod.aws.tidbcloud.com")).toBe(false);
  });

  it("rejects a public IPv4 address", () => {
    expect(isDockerInternalSingleLabelHost("203.0.113.5")).toBe(false);
  });

  it("rejects an IPv6 address, bracketed or not", () => {
    expect(isDockerInternalSingleLabelHost("2001:db8::1")).toBe(false);
    expect(isDockerInternalSingleLabelHost("[2001:db8::1]")).toBe(false);
  });

  it("rejects localhost/127.0.0.1/::1 - those already have their own, separate loopback exception", () => {
    expect(isDockerInternalSingleLabelHost("localhost")).toBe(false);
    expect(isDockerInternalSingleLabelHost("LOCALHOST")).toBe(false);
    expect(isDockerInternalSingleLabelHost("127.0.0.1")).toBe(false);
    expect(isDockerInternalSingleLabelHost("::1")).toBe(false);
    expect(isDockerInternalSingleLabelHost("[::1]")).toBe(false);
  });

  it("fails closed (false) for empty/null/undefined rather than throwing", () => {
    expect(isDockerInternalSingleLabelHost("")).toBe(false);
    expect(isDockerInternalSingleLabelHost(null)).toBe(false);
    expect(isDockerInternalSingleLabelHost(undefined)).toBe(false);
  });
});

describe("buildTestDbConnectionOptions - TEST_DATABASE_TRANSPORT=internal_plaintext", () => {
  it("omits ssl entirely for a Coolify/Docker-internal single-label hostname when explicitly opted in", () => {
    const options = buildTestDbConnectionOptions(COOLIFY_URL, "internal_plaintext");
    expect(options.ssl).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(options, "ssl")).toBe(false);
  });

  it("the SAME Coolify hostname still requires strict TLS when transport mode is NOT opted in (default/undefined)", () => {
    const options = buildTestDbConnectionOptions(COOLIFY_URL, undefined);
    expect(options.ssl).toBeDefined();
    expect(options.ssl?.minVersion).toBe("TLSv1.2");
    expect(options.ssl?.rejectUnauthorized).toBe(true);
  });

  it("rejects (throws, fails closed) a dotted domain even when internal_plaintext is requested", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://root:pw@some.internal.docker:3306/ipenovel_test", "internal_plaintext")
    ).toThrow();
  });

  it("rejects (throws, fails closed) a public IPv4 address even when internal_plaintext is requested", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://root:pw@203.0.113.5:3306/ipenovel_test", "internal_plaintext")
    ).toThrow();
  });

  it("rejects (throws, fails closed) a public IPv6 address even when internal_plaintext is requested", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://root:pw@[2001:db8::1]:3306/ipenovel_test", "internal_plaintext")
    ).toThrow();
  });

  it("rejects (throws, fails closed) a localhost lookalike (dotted subdomain) even when internal_plaintext is requested", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://root:pw@localhost.example.com:3306/ipenovel_test", "internal_plaintext")
    ).toThrow();
  });

  it("rejects (throws) a wrong database name even when internal_plaintext is requested and the host would otherwise qualify - the exact-name gate (assertSafeTestDatabaseUrl) runs first, unconditionally, before transport mode is ever considered", () => {
    expect(() => buildTestDbConnectionOptions(`mysql://root:pw@${COOLIFY_HOST}:3306/ipenovel_prod`, "internal_plaintext")).toThrow();
    expect(() => buildTestDbConnectionOptions(`mysql://root:pw@${COOLIFY_HOST}:3306/ipenovel`, "internal_plaintext")).toThrow();
  });

  it("rejects (throws, fails closed) a non-3306 port even when the host and database name both qualify", () => {
    expect(() =>
      buildTestDbConnectionOptions(`mysql://root:pw@${COOLIFY_HOST}:3307/ipenovel_test`, "internal_plaintext")
    ).toThrow();
  });

  it("never sets rejectUnauthorized: false as the mechanism - ssl is simply absent from the object", () => {
    const options = buildTestDbConnectionOptions(COOLIFY_URL, "internal_plaintext");
    expect(options).not.toHaveProperty("ssl");
  });

  it("does not affect the pre-existing loopback exception - a loopback host with internal_plaintext requested still just uses the loopback path (never throws due to failing the Docker-hostname shape check)", () => {
    const options = buildTestDbConnectionOptions("mysql://root:pw@127.0.0.1:3306/ipenovel_test", "internal_plaintext");
    expect(options.ssl).toBeUndefined();
  });
});

describe("TiDB URL default behavior is unaffected by the new transport-mode parameter", () => {
  it("still enables strict TLS (rejectUnauthorized: true) for the TiDB URL with transportMode explicitly undefined", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL, undefined);
    expect(options.ssl?.rejectUnauthorized).toBe(true);
  });

  it("a TiDB-shaped remote host does not qualify for internal_plaintext even if it were requested (dotted domain)", () => {
    expect(() => buildTestDbConnectionOptions(TIDB_URL, "internal_plaintext")).toThrow();
  });
});

describe("no code disables TLS certificate verification, sets global TLS overrides, or reads TEST_DATABASE_TRANSPORT inside the factory itself (static source checks)", () => {
  const filesToCheck = [
    "server/test-helpers/testDbConnectionOptions.ts",
    "server/test-helpers/testDb.ts",
    "scripts/migrate-test-db.ts",
    "scripts/test-db-prepare.ts",
    "scripts/test-ci.ts",
    "server/migration-0024-content-downgrade.integration.test.ts",
    "server/migration-0024-episode-schema-repair.integration.test.ts",
    "server/migration-0026-idempotency.integration.test.ts",
    "server/migration-0027-idempotency.integration.test.ts",
    "server/migration-0029-dynamic-checkin-schema.integration.test.ts",
    "server/migration-0030-repair-missing-daily-checkins.integration.test.ts",
    "server/migration-0031-point-rewards.integration.test.ts",
    "server/migration-0032-coupon-ownership.integration.test.ts",
    "server/migration-legacy-pending-chain.integration.test.ts",
    "server/_core/startupMigrationBootstrap.integration.test.ts",
  ];

  it.each(filesToCheck)("%s never contains rejectUnauthorized: false", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).not.toMatch(/rejectUnauthorized\s*:\s*false/);
  });

  it.each(filesToCheck)("%s never sets NODE_TLS_REJECT_UNAUTHORIZED", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it("testDbConnectionOptions.ts itself never reads process.env - transport mode is only ever accepted as an explicit function argument", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "server/test-helpers/testDbConnectionOptions.ts"), "utf8"));
    expect(source).not.toMatch(/process\.env/);
  });

  it.each(filesToCheck.filter((f) => f !== "server/test-helpers/testDbConnectionOptions.ts"))(
    "%s reads process.env.TEST_DATABASE_TRANSPORT explicitly (via parseTestDbTransportMode) rather than the factory reading it implicitly",
    (relativePath) => {
      const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
      expect(source).toMatch(/parseTestDbTransportMode\(process\.env\.TEST_DATABASE_TRANSPORT\)/);
    }
  );
});

describe("scripts/migrate-test-db.ts uses a single mysql2 connection, never a pool, for DDL migrations", () => {
  it("calls mysql.createConnection, not mysql.createPool", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8"));
    expect(source).toMatch(/mysql\.createConnection\(/);
    expect(source).not.toMatch(/mysql\.createPool\(/);
  });

  it("closes the connection in a finally block via closeMysqlConnectionSafely", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8");
    const finallyIndex = source.indexOf("} finally {");
    // closeMysqlConnectionSafely() (server/test-helpers/closeMysqlConnectionSafely.ts)
    // replaced the previous bare `conn.end().catch(() => {})` - a close
    // failure must never be silently swallowed, see that module's own tests.
    const closeCallIndex = source.indexOf("closeMysqlConnectionSafely(connection");
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(closeCallIndex).toBeGreaterThan(finallyIndex);
    expect(source).not.toMatch(/\.end\(\)\.catch\(\(\)\s*=>\s*\{\}\)/);
  });

  it("contains no process.exit() call anywhere - an explicit process.exit(0) would hide a leaked handle instead of surfacing it", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8"));
    expect(source).not.toMatch(/process\.exit\(/);
    // The failure path still reports sanitized errors and sets exitCode
    // instead, letting Node terminate naturally once the event loop is
    // actually empty.
    expect(source).toMatch(/process\.exitCode\s*=\s*1/);
  });
});

describe("scripts/migrate-test-db.ts migration-connection diagnostics markers", () => {
  const source = () => codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8"));

  it.each([
    "migration connection created",
    "migration lock release started",
    "migration lock release completed",
    "migration connection close started",
    "migration connection close completed",
  ])('logs the fixed marker "%s"', (marker) => {
    expect(source()).toMatch(new RegExp(`logDiagnostic\\("${marker}"\\)`));
  });

  it("logs an active-resource snapshot after migration connection close", () => {
    expect(source()).toMatch(/logActiveResourceSnapshot\(logDiagnostic,\s*"after migration connection close"\)/);
  });

  it('only logs "migration lock release completed" inside the branch where RELEASE_LOCK reported real success (released === 1), never unconditionally', () => {
    const fullSource = source();
    const releaseQueryIndex = fullSource.indexOf("RELEASE_LOCK(?)");
    expect(releaseQueryIndex).toBeGreaterThan(-1);
    const releasedCheckIndex = fullSource.indexOf("released === 1", releaseQueryIndex);
    const completedLogIndex = fullSource.indexOf('logDiagnostic("migration lock release completed")', releaseQueryIndex);
    expect(releasedCheckIndex).toBeGreaterThan(releaseQueryIndex);
    expect(completedLogIndex).toBeGreaterThan(releasedCheckIndex);
  });

  it("warns (does not report success) when RELEASE_LOCK does not return exactly 1", () => {
    const fullSource = source();
    expect(fullSource).toMatch(/RELEASE_LOCK returned \$\{released\}/);
  });
});

describe("scripts/test-db-prepare.ts diagnostics never use private Node APIs", () => {
  it("contains no reference to process._getActiveHandles - only the shared testDbDiagnostics module (itself getActiveResourcesInfo()-only) is used", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8"));
    expect(source).not.toMatch(/_getActiveHandles/);
    expect(source).toMatch(/logActiveResourceSnapshot/);
  });

  it("contains no process.exit() call anywhere - only process.exitCode is set on failure", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8"));
    expect(source).not.toMatch(/process\.exit\(/);
    expect(source).toMatch(/process\.exitCode\s*=\s*1/);
  });
});

describe("scripts/test-db-prepare.ts uses top-level await + try/catch, not a .then().catch() promise chain", () => {
  it("uses a top-level `await main()` inside a try block", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8"));
    expect(source).toMatch(/try\s*\{[\s\S]*?await main\(\)/);
  });

  it("never chains main() with .then()/.catch() - the failure path is a plain catch block", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8"));
    expect(source).not.toMatch(/main\(\)\s*\.then\(/);
    expect(source).not.toMatch(/main\(\)\s*\.catch\(/);
  });

  it("passes onDiagnostic to closeMysqlConnectionSafely so the new close-sequence markers are wired through", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8"));
    expect(source).toMatch(/closeMysqlConnectionSafely\(connection,\s*\{\s*primaryError,\s*onDiagnostic:\s*logDiagnostic\s*\}\)/);
  });
});

describe("scripts/migrate-test-db.ts also wires onDiagnostic into closeMysqlConnectionSafely", () => {
  it("passes onDiagnostic to closeMysqlConnectionSafely", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8"));
    expect(source).toMatch(/closeMysqlConnectionSafely\(connection,\s*\{\s*primaryError,\s*onDiagnostic:\s*logDiagnostic\s*\}\)/);
  });
});

describe("server/test-helpers/closeMysqlConnectionSafely.ts no longer requires the remote 'end' event for success", () => {
  it("the module never gates its success path on the 'end' event - a bare `await Promise.race([connection.end()...` never appears combined with the event in a Promise.all", () => {
    const source = codeOnly(
      fs.readFileSync(path.join(repoRoot, "server/test-helpers/closeMysqlConnectionSafely.ts"), "utf8")
    );
    // The previous (rejected) design combined end() and the 'end' event via
    // Promise.all before racing the timeout - that combinator must not
    // reappear; local finalization (destroy()) is what determines success now.
    expect(source).not.toMatch(/Promise\.all\(\s*\[\s*connection\.end\(\)/);
  });

  it("destroy() is called unconditionally after end() resolves, as the normal (not forced) close path", () => {
    const source = codeOnly(
      fs.readFileSync(path.join(repoRoot, "server/test-helpers/closeMysqlConnectionSafely.ts"), "utf8")
    );
    expect(source).toMatch(/local transport finalization started/);
    expect(source).toMatch(/local transport finalization completed/);
  });

  it("never accesses connection.stream, connection.connection, or any underscore-prefixed property", () => {
    const source = codeOnly(
      fs.readFileSync(path.join(repoRoot, "server/test-helpers/closeMysqlConnectionSafely.ts"), "utf8")
    );
    expect(source).not.toMatch(/connection\.stream/);
    expect(source).not.toMatch(/connection\.connection/);
    expect(source).not.toMatch(/\._closing/);
    expect(source).not.toMatch(/_getActiveHandles/);
    expect(source).not.toMatch(/_getActiveRequests/);
  });
});

describe("scripts/test-db-prepare.ts and scripts/migrate-test-db.ts diagnostics come from the shared, directly-tested testDbDiagnostics module", () => {
  // The diagnostics failure-path contract itself (bare `catch {}`, fixed
  // non-interpolated message, no error/error.message/String(error) of any
  // kind) moved into server/test-helpers/testDbDiagnostics.ts's own
  // logActiveResourceSnapshot() - see testDbDiagnostics.test.ts for the
  // full, function-level coverage of that contract. These checks just
  // confirm both scripts actually import and use the shared module rather
  // than reimplementing their own (and possibly diverging) version of it.
  const filesToCheck = ["scripts/test-db-prepare.ts", "scripts/migrate-test-db.ts"];

  it.each(filesToCheck)("%s imports logActiveResourceSnapshot/createDiagnosticLogger from the shared testDbDiagnostics module", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).toMatch(/from\s+["'].*testDbDiagnostics["']/);
    expect(source).toMatch(/createDiagnosticLogger/);
    expect(source).toMatch(/logActiveResourceSnapshot/);
  });

  it.each(filesToCheck)("%s never defines its own local logActiveResources-style function", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).not.toMatch(/function\s+logActiveResources/);
  });
});
