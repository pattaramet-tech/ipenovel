import { describe, it, expect } from "vitest";
import {
  checkTestDatabaseUrl,
  assertSafeTestDatabaseUrl,
  isAllowedTestDatabaseName,
  looksLikeProductionDatabase,
  parseDatabaseUrl,
  redactDatabaseUrl,
} from "./testDatabaseGuard";

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
  it("accepts names with a bounded 'test' segment", () => {
    expect(isAllowedTestDatabaseName("ipenovel_test")).toBe(true);
    expect(isAllowedTestDatabaseName("test_ipenovel")).toBe(true);
    expect(isAllowedTestDatabaseName("ipenovel-test-db")).toBe(true);
    expect(isAllowedTestDatabaseName("TEST")).toBe(true);
  });

  it("accepts names with a bounded 'ci' segment", () => {
    expect(isAllowedTestDatabaseName("ipenovel_ci")).toBe(true);
    expect(isAllowedTestDatabaseName("ci_ipenovel")).toBe(true);
  });

  it("rejects names where 'test'/'ci' is only a substring of another word", () => {
    expect(isAllowedTestDatabaseName("attestation_db")).toBe(false);
    expect(isAllowedTestDatabaseName("circuit_db")).toBe(false);
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

  it("flags a production-sounding host even if the database name looks like a test DB", () => {
    expect(
      looksLikeProductionDatabase({ host: "prod-db.internal.example.com", port: "3306", databaseName: "ipenovel_test" })
    ).toBe(true);
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

  it("rejects a production-looking URL even if it would otherwise parse fine", () => {
    const result = checkTestDatabaseUrl("mysql://app:pw@prod-mysql.railway.internal:3306/ipenovel");
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

  it("assertSafeTestDatabaseUrl throws (never silently continues) for anything unsafe", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow();
    expect(() => assertSafeTestDatabaseUrl("mysql://app:pw@localhost/ipenovel")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("mysql://app:pw@localhost/ipenovel_production")).toThrow();
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
