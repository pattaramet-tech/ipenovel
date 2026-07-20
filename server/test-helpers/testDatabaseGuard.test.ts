import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  checkTestDatabaseUrl,
  assertSafeTestDatabaseUrl,
  isAllowedTestDatabaseName,
  looksLikeProductionDatabase,
  parseDatabaseUrl,
  redactDatabaseUrl,
} from "./testDatabaseGuard";

const repoRoot = path.resolve(__dirname, "..", "..");

function codeOnly(source: string): string {
  // Strips comments before a source-level check, so prose that merely
  // *mentions* "process.env.DATABASE_URL" (explaining that it is
  // deliberately not used) doesn't false-positive against the check.
  // Normalizes CRLF to LF first - a trailing \r before the split-on-"\n"
  // line boundary otherwise defeats the `//...$` per-line regex below
  // (`.` and `$` both exclude \r), silently leaving CRLF-terminated
  // comment lines unstripped.
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Pure logic, no DB connection anywhere in this file - every one of these
 * runs for real, unconditionally, in every environment. This is the core
 * proof that "integration tests can never accidentally target production"
 * (PART B) - the guard functions themselves are fully verified here even
 * though this sandbox has no live database to test the connection itself.
 */

describe("parseDatabaseUrl", () => {
  it("extracts host, port, and database name (never username/password)", () => {
    const parsed = parseDatabaseUrl("mysql://produser:SuperSecret123@db.internal.example.com:3306/ipenovel_test");
    expect(parsed).toEqual({ host: "db.internal.example.com", port: "3306", databaseName: "ipenovel_test" });
  });

  it("defaults port to 3306 when omitted", () => {
    const parsed = parseDatabaseUrl("mysql://user:pass@localhost/ipenovel_test");
    expect(parsed?.port).toBe("3306");
  });

  it("returns null for an unparseable string", () => {
    expect(parseDatabaseUrl("not-a-url")).toBeNull();
    expect(parseDatabaseUrl("")).toBeNull();
  });
});

describe("isAllowedTestDatabaseName", () => {
  it("accepts only the exact literal 'ipenovel_test'", () => {
    expect(isAllowedTestDatabaseName("ipenovel_test")).toBe(true);
  });

  it("rejects any other test-like name, however plausible it looks", () => {
    expect(isAllowedTestDatabaseName("test_ipenovel")).toBe(false);
    expect(isAllowedTestDatabaseName("ipenovel-test-db")).toBe(false);
    expect(isAllowedTestDatabaseName("TEST")).toBe(false);
    expect(isAllowedTestDatabaseName("ipenovel_ci")).toBe(false);
    expect(isAllowedTestDatabaseName("ci_ipenovel")).toBe(false);
    expect(isAllowedTestDatabaseName("ipenovel_Test")).toBe(false);
    expect(isAllowedTestDatabaseName("ipenovel_test_prod_mirror")).toBe(false);
  });

  it("rejects names where 'test' is only a substring of another word", () => {
    expect(isAllowedTestDatabaseName("attestation_db")).toBe(false);
    expect(isAllowedTestDatabaseName("latest_ipenovel")).toBe(false);
  });

  it("rejects plain production-shaped names entirely", () => {
    expect(isAllowedTestDatabaseName("ipenovel")).toBe(false);
    expect(isAllowedTestDatabaseName("ipenovel_production")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedTestDatabaseName("")).toBe(false);
  });
});

describe("looksLikeProductionDatabase", () => {
  it("flags a database name containing prod/production/live/master", () => {
    expect(looksLikeProductionDatabase({ host: "h", port: "3306", databaseName: "ipenovel_prod" })).toBe(true);
    expect(looksLikeProductionDatabase({ host: "h", port: "3306", databaseName: "ipenovel_production" })).toBe(true);
    expect(looksLikeProductionDatabase({ host: "h", port: "3306", databaseName: "ipenovel_live" })).toBe(true);
  });

  it("does NOT flag a production-sounding host when the database name is safe (managed-hosting infra hostnames)", () => {
    // TiDB Cloud's real gateway hostname shape - "prod" here describes
    // TiDB Cloud's own AWS region/infrastructure, not the selected
    // application database. This was a real false-positive this project
    // hit in production use.
    expect(
      looksLikeProductionDatabase({
        host: "gateway01.ap-southeast-1.prod.aws.tidbcloud.com",
        port: "4000",
        databaseName: "ipenovel_test",
      })
    ).toBe(false);
    expect(
      looksLikeProductionDatabase({ host: "prod-db.internal.example.com", port: "3306", databaseName: "ipenovel_test" })
    ).toBe(false);
  });

  it("does not flag an ordinary test database", () => {
    expect(looksLikeProductionDatabase({ host: "localhost", port: "3306", databaseName: "ipenovel_test" })).toBe(false);
  });
});

describe("checkTestDatabaseUrl / assertSafeTestDatabaseUrl - the actual PART B gate", () => {
  it("rejects a missing/empty URL with a clear reason (never a silent pass)", () => {
    expect(checkTestDatabaseUrl(undefined).safe).toBe(false);
    expect(checkTestDatabaseUrl(null).safe).toBe(false);
    expect(checkTestDatabaseUrl("").safe).toBe(false);
    expect(checkTestDatabaseUrl("   ").safe).toBe(false);
  });

  it("rejects a production-NAMED database even if it would otherwise parse fine", () => {
    const result = checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_prod");
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/production/i);
  });

  it("rejects a URL whose database name has no test/ci marker", () => {
    const result = checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel");
    expect(result.safe).toBe(false);
  });

  it("accepts a URL whose database name is clearly a test database", () => {
    const result = checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_test");
    expect(result.safe).toBe(true);
    expect(result.parsed?.databaseName).toBe("ipenovel_test");
  });

  it("accepts the real TiDB Cloud gateway hostname with database name ipenovel_test (regression: was previously rejected solely for the host containing 'prod')", () => {
    const result = checkTestDatabaseUrl(
      "mysql://app:pw@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/ipenovel_test"
    );
    expect(result.safe).toBe(true);
    expect(result.parsed?.host).toBe("gateway01.ap-southeast-1.prod.aws.tidbcloud.com");
    expect(result.parsed?.databaseName).toBe("ipenovel_test");
  });

  it("rejects a database named ipenovel_prod", () => {
    expect(checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_prod").safe).toBe(false);
  });

  it("rejects a database literally named 'production'", () => {
    expect(checkTestDatabaseUrl("mysql://app:pw@localhost:3306/production").safe).toBe(false);
  });

  it("rejects a database named ipenovel_test_backup (superset of the exact name is still not the exact name)", () => {
    const result = checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_test_backup");
    expect(result.safe).toBe(false);
    expect(result.parsed?.databaseName).toBe("ipenovel_test_backup");
  });

  it.each([
    "ipenovel",
    "ipenovel_prod",
    "ipenovel_production",
    "ipenovel_live",
    "ipenovel_master",
    "ipenovel_test_backup",
    "ipenovel_test2",
    "ipenoveltest",
    "IPENOVEL_TEST",
    "test",
    "ci",
    "",
  ])("rejects any database name other than the exact literal 'ipenovel_test': %s", (databaseName) => {
    const url = `mysql://app:pw@localhost:3306/${databaseName}`;
    expect(checkTestDatabaseUrl(url).safe).toBe(false);
  });

  it("missing TEST_DATABASE_URL fails closed (undefined, null, empty, whitespace-only)", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = checkTestDatabaseUrl(value);
      expect(result.safe).toBe(false);
      expect(result.parsed).toBeNull();
    }
  });

  it("assertSafeTestDatabaseUrl throws (never silently continues) for anything unsafe", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow();
    expect(() => assertSafeTestDatabaseUrl("mysql://app:pw@localhost/ipenovel")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("mysql://app:pw@localhost/ipenovel_production")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("mysql://app:pw@localhost/ipenovel_test_backup")).toThrow();
  });

  it("assertSafeTestDatabaseUrl's thrown message never contains the raw connection string or credentials", () => {
    const url = "mysql://produser:SuperSecretPassword@prod-db.example.com:3306/ipenovel";
    try {
      assertSafeTestDatabaseUrl(url);
      throw new Error("expected assertSafeTestDatabaseUrl to throw");
    } catch (error: any) {
      expect(error.message).not.toContain("SuperSecretPassword");
      expect(error.message).not.toContain("produser");
      expect(error.message).not.toContain(url);
    }
  });

  it("assertSafeTestDatabaseUrl returns the parsed URL when safe", () => {
    const parsed = assertSafeTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_test");
    expect(parsed.databaseName).toBe("ipenovel_test");
  });
});

describe("DATABASE_URL is never read or modified by test setup (static source checks)", () => {
  const filesThatMustNeverTouchDatabaseUrl = [
    "server/test-helpers/testDatabaseGuard.ts",
    "server/test-helpers/testDb.ts",
    "server/test-helpers/liveTestDatabaseCheck.ts",
    "server/test-helpers/resetTestDatabase.ts",
    "server/test-helpers/testDbConnectionOptions.ts",
    "vitest.integration.globalsetup.ts",
    "scripts/migrate-test-db.ts",
    "scripts/test-db-prepare.ts",
    "scripts/test-ci.ts",
    "server/migration-0027-idempotency.integration.test.ts",
    "server/migration-0024-episode-schema-repair.integration.test.ts",
    "server/test-helpers/migrateTestDbWithLogging.ts",
  ];

  it.each(filesThatMustNeverTouchDatabaseUrl)("%s never reads or writes process.env.DATABASE_URL", (relativePath) => {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    expect(codeOnly(source)).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it("checkTestDatabaseUrl/assertSafeTestDatabaseUrl never read process.env directly - they only inspect the URL argument passed to them", () => {
    // Regression for the specific failure mode this task guards against:
    // a guard function that reaches into process.env itself (rather than
    // taking the connection string as an explicit argument) is one
    // refactor away from silently falling back to DATABASE_URL.
    const source = codeOnly(fs.readFileSync(path.join(repoRoot, "server/test-helpers/testDatabaseGuard.ts"), "utf8"));
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("a safe URL still requires the independent live SELECT DATABASE() check", () => {
  it("checkTestDatabaseUrl/assertSafeTestDatabaseUrl are synchronous and never open a database connection themselves", () => {
    // Proves these functions cannot, by construction, satisfy "the
    // database was verified" on their own - assertSafeTestDatabaseUrl
    // returns synchronously (no Promise, no I/O), so a caller that stops
    // after this check alone has not actually connected to anything yet.
    // See server/test-helpers/liveTestDatabaseCheck.test.ts for the
    // matching proof that the live query independently rejects a mismatch
    // even when this URL-string check alone would have passed.
    const result = checkTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_test");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.safe).toBe(true);

    const parsed = assertSafeTestDatabaseUrl("mysql://app:pw@localhost:3306/ipenovel_test");
    expect(parsed).not.toBeInstanceOf(Promise);
  });

  it("vitest.integration.globalsetup.ts calls the live check (ensureVerifiedTestDb) in addition to the URL-string check, not instead of it", () => {
    const source = fs.readFileSync(path.join(repoRoot, "vitest.integration.globalsetup.ts"), "utf8");
    expect(source).toMatch(/assertSafeTestDatabaseUrl/);
    expect(source).toMatch(/ensureVerifiedTestDb/);
  });
});

describe("redactDatabaseUrl - safe for logging", () => {
  it("never includes username or password", () => {
    const redacted = redactDatabaseUrl("mysql://produser:SuperSecretPassword123@db.example.com:3306/ipenovel_test");
    expect(redacted).not.toContain("produser");
    expect(redacted).not.toContain("SuperSecretPassword123");
    expect(redacted).toBe("db.example.com:3306/ipenovel_test");
  });

  it("handles a missing URL without throwing", () => {
    expect(redactDatabaseUrl(undefined)).toBe("(not set)");
    expect(redactDatabaseUrl(null)).toBe("(not set)");
  });

  it("handles an unparseable URL without echoing it back", () => {
    expect(redactDatabaseUrl("not-a-url-at-all")).not.toContain("not-a-url-at-all");
  });
});
