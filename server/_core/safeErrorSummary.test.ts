import { describe, it, expect } from "vitest";
import { safeErrorSummary, sanitizeErrorMessage, redactSensitiveText } from "../../scripts/lib/safeErrorSummary.mjs";

/**
 * Unit coverage for the shared error sanitizer used by both the production
 * migration runner (scripts/migrate.mjs) and the global tRPC error
 * formatter. No database, no network - pure string handling.
 *
 * The concrete leak this exists to prevent: drizzle-orm wraps a failed
 * statement in an error whose message embeds the SQL and the real bound
 * parameter values.
 */

/** A faithful reproduction of drizzle's wrapper error shape. */
function drizzleStyleError(): Error & { cause?: unknown } {
  const driverError: any = new Error("Table 'ipenovel.dailyCheckins' doesn't exist");
  driverError.code = "ER_NO_SUCH_TABLE";
  driverError.errno = 1146;
  driverError.sqlState = "42S02";

  const wrapper: any = new Error(
    "Failed query: select `id`, `userId` from `dailyCheckins` where `userId` = ? limit ?\nparams: 2160001,1"
  );
  wrapper.cause = driverError;
  return wrapper;
}

describe("sanitizeErrorMessage - SQL and bound parameters", () => {
  it("drops everything from 'params:' onward", () => {
    const result = sanitizeErrorMessage("Something broke\nparams: 2160001,1");
    expect(result ?? "").not.toContain("2160001");
    expect(result ?? "").not.toContain("params:");
  });

  it("drops drizzle's 'Failed query' preamble and the SQL after it", () => {
    const result = sanitizeErrorMessage(
      "Failed query: select `id` from `dailyCheckins` where `userId` = ?\nparams: 7"
    );
    expect(result).toBeNull();
  });

  it("never returns text containing 'Failed query' even when preceded by other text", () => {
    const result = sanitizeErrorMessage("Migration aborted. Failed query: select * from coupons");
    expect(result ?? "").not.toMatch(/failed\s+query/i);
    expect(result ?? "").not.toContain("select");
  });

  it("strips bare SQL statements that appear without a drizzle preamble", () => {
    for (const sql of [
      "boom SELECT * FROM payments",
      "boom insert into coupons values (1)",
      "boom delete from dailyCheckins where id = 3",
      "boom alter table coupons add maxDiscountAmount",
      "boom create table dailyCheckins (id int)",
      "boom drop table coupons",
    ]) {
      const result = sanitizeErrorMessage(sql) ?? "";
      expect(result.toLowerCase()).not.toMatch(/select|insert|delete|alter table|create table|drop table/);
    }
  });

  it("returns null for input that is entirely unsafe", () => {
    expect(sanitizeErrorMessage("params: 1,2,3")).toBeNull();
    expect(sanitizeErrorMessage("")).toBeNull();
    expect(sanitizeErrorMessage(undefined)).toBeNull();
  });

  it("caps message length", () => {
    const result = sanitizeErrorMessage("x".repeat(5000)) ?? "";
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe("redactSensitiveText - credentials and connection details", () => {
  it("redacts a full DATABASE_URL style connection string", () => {
    const result = redactSensitiveText("connect failed for mysql://produser:SuperSecret123@db.internal.example.com:3306/ipenovel");
    expect(result).not.toContain("SuperSecret123");
    expect(result).not.toContain("produser");
    expect(result).not.toContain("db.internal.example.com");
    expect(result).toContain("[redacted-connection-string]");
  });

  it("redacts MySQL user@host pairs, IPs and hostnames", () => {
    expect(redactSensitiveText("Access denied for user 'root'@'10.0.0.5'")).not.toContain("10.0.0.5");
    expect(redactSensitiveText("connect ECONNREFUSED 127.0.0.1:3306")).not.toContain("127.0.0.1");
    expect(redactSensitiveText("getaddrinfo ENOTFOUND prod-cluster.example.com")).not.toContain("prod-cluster.example.com");
  });

  it("redacts credential-shaped key=value fragments", () => {
    expect(redactSensitiveText("password=hunter2")).not.toContain("hunter2");
    expect(redactSensitiveText("api_key: abcd1234")).not.toContain("abcd1234");
  });
});

describe("safeErrorSummary - drizzle wrapper with a database cause", () => {
  const summary = safeErrorSummary(drizzleStyleError());

  it("never leaks SQL text or bound parameters", () => {
    expect(summary).not.toMatch(/failed\s+query/i);
    expect(summary).not.toContain("params:");
    expect(summary).not.toContain("2160001");
    expect(summary.toLowerCase()).not.toContain("select");
  });

  it("preserves the driver diagnostic fields from the cause", () => {
    expect(summary).toContain("code=ER_NO_SUCH_TABLE");
    expect(summary).toContain("errno=1146");
    expect(summary).toContain("sqlState=42S02");
  });

  it("preserves the useful underlying database message", () => {
    expect(summary).toContain("doesn't exist");
  });
});

describe("safeErrorSummary - cause traversal safety", () => {
  it("survives a cyclic cause chain without hanging", () => {
    const a: any = new Error("outer");
    const b: any = new Error("inner");
    a.cause = b;
    b.cause = a;
    expect(() => safeErrorSummary(a)).not.toThrow();
    expect(safeErrorSummary(a)).toContain("outer");
  });

  it("stops at a bounded depth on a long chain", () => {
    let deepest: any = new Error("level-0");
    deepest.code = "DEEPEST_CODE";
    for (let i = 1; i <= 40; i++) {
      const next: any = new Error(`level-${i}`);
      next.cause = deepest;
      deepest = next;
    }
    const result = safeErrorSummary(deepest);
    // The chain is truncated well before the innermost link.
    expect(result).not.toContain("DEEPEST_CODE");
    expect(result).toContain("level-40");
  });

  it("handles null, undefined and non-Error thrown values", () => {
    expect(safeErrorSummary(null)).toBe("unknown error");
    expect(safeErrorSummary(undefined)).toBe("unknown error");
    expect(safeErrorSummary("plain string failure")).toContain("plain string failure");
  });
});

describe("safeErrorSummary - preserves recognisable operational failures", () => {
  const cases: Array<[string, any]> = [
    ["ER_NO_SUCH_TABLE", { code: "ER_NO_SUCH_TABLE", errno: 1146, message: "Table 'x' doesn't exist" }],
    ["ER_BAD_FIELD_ERROR", { code: "ER_BAD_FIELD_ERROR", errno: 1054, message: "Unknown column 'maxDiscountAmount'" }],
    ["ER_ACCESS_DENIED_ERROR", { code: "ER_ACCESS_DENIED_ERROR", errno: 1045, message: "Access denied" }],
    ["ECONNREFUSED", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }],
    ["ETIMEDOUT", { code: "ETIMEDOUT", message: "connection timeout" }],
  ];

  for (const [code, error] of cases) {
    it(`keeps ${code} identifiable`, () => {
      expect(safeErrorSummary(error)).toContain(`code=${code}`);
    });
  }
});
