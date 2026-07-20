import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildTestDbConnectionOptions } from "./testDbConnectionOptions";
import { redactDatabaseUrl } from "./testDatabaseGuard";

const repoRoot = path.resolve(__dirname, "..", "..");

// A real TiDB Cloud Starter gateway hostname shape - the exact class of URL
// that a Manus integration run previously rejected with "Connections using
// insecure transport are prohibited" because no TLS options were set.
const TIDB_URL = "mysql://appuser:S3cr%40tPass@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_test";

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

describe("buildTestDbConnectionOptions - TLS", () => {
  it("enables TLS for a real TiDB Cloud connection string", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.ssl).toBeDefined();
    expect(typeof options.ssl).toBe("object");
  });

  it("sets ssl.minVersion to exactly TLSv1.2", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.ssl.minVersion).toBe("TLSv1.2");
  });

  it("sets ssl.rejectUnauthorized to exactly true", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.ssl.rejectUnauthorized).toBe(true);
  });

  it("never sets ssl.rejectUnauthorized to false and never adds a ca override", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.ssl.rejectUnauthorized).not.toBe(false);
    expect(options.ssl).not.toHaveProperty("ca");
  });
});

describe("buildTestDbConnectionOptions - parsing", () => {
  it("decodes percent-encoded username and password for the actual connection", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.user).toBe("appuser");
    expect(options.password).toBe("S3cr@tPass");
  });

  it("extracts host, numeric port, and the exact database name", () => {
    const options = buildTestDbConnectionOptions(TIDB_URL);
    expect(options.host).toBe("gateway01.ap-southeast-1.prod.aws.tidbcloud.com");
    expect(options.port).toBe(4000);
    expect(typeof options.port).toBe("number");
    expect(options.database).toBe("ipenovel_test");
  });

  it("defaults to port 3306 (as a number) when the URL omits a port", () => {
    const options = buildTestDbConnectionOptions("mysql://user:pw@localhost/ipenovel_test");
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
    const options = buildTestDbConnectionOptions(TIDB_URL);
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
    expect(() => buildTestDbConnectionOptions("not-a-url")).toThrow();
  });

  it("throws for a missing TEST_DATABASE_URL (undefined, null, empty)", () => {
    expect(() => buildTestDbConnectionOptions(undefined)).toThrow();
    expect(() => buildTestDbConnectionOptions(null)).toThrow();
    expect(() => buildTestDbConnectionOptions("")).toThrow();
  });

  it("throws for any database name other than the exact literal ipenovel_test", () => {
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel_prod")).toThrow();
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel")).toThrow();
    expect(() => buildTestDbConnectionOptions("mysql://user:pw@localhost:3306/ipenovel_test_backup")).toThrow();
  });

  it("still enforces the exact-name gate even for a legitimate-looking TiDB Cloud host with the wrong database name", () => {
    expect(() =>
      buildTestDbConnectionOptions("mysql://user:pw@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_prod")
    ).toThrow();
  });
});

describe("no code disables TLS certificate verification or sets global TLS overrides (static source checks)", () => {
  const filesToCheck = [
    "server/test-helpers/testDbConnectionOptions.ts",
    "server/test-helpers/testDb.ts",
    "scripts/migrate-test-db.ts",
    "scripts/test-db-prepare.ts",
    "scripts/test-ci.ts",
    "server/migration-0027-idempotency.integration.test.ts",
  ];

  it.each(filesToCheck)("%s never contains rejectUnauthorized: false", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).not.toMatch(/rejectUnauthorized\s*:\s*false/);
  });

  it.each(filesToCheck)("%s never sets NODE_TLS_REJECT_UNAUTHORIZED", (relativePath) => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    expect(source).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe("scripts/migrate-test-db.ts uses a single mysql2 connection, never a pool, for DDL migrations", () => {
  it("calls mysql.createConnection, not mysql.createPool", () => {
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8"));
    expect(source).toMatch(/mysql\.createConnection\(/);
    expect(source).not.toMatch(/mysql\.createPool\(/);
  });

  it("closes the connection in a finally block", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts/migrate-test-db.ts"), "utf8");
    const finallyIndex = source.indexOf("} finally {");
    const endCallIndex = source.indexOf("conn.end()");
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(endCallIndex).toBeGreaterThan(finallyIndex);
  });
});
