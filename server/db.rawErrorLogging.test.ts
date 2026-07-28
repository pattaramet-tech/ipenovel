import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Forces getDb()'s drizzle(...) call to throw, so its catch block's logging
// can be exercised directly without a real database connection attempt.
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => {
    throw new Error(
      "connect ECONNREFUSED mysql://dbuser:hunter2@db.internal.example:3306/prod password=hunter2 token=abcdef1234567890"
    );
  },
}));

describe("server/db.ts - raw database error logging", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = "mysql://testuser:testpass@localhost:3306/testdb";
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.restoreAllMocks();
  });

  it("getDb() sanitizes a connection failure before logging - never the raw error, connection string, or credentials", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dbModule = await import("./db");

    const result = await dbModule.getDb();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls[0]);
    // Credentials and the connection string must never survive; a bare,
    // non-sensitive diagnostic code like ECONNREFUSED is fine to keep (see
    // safeErrorSummary's own docstring - it deliberately preserves codes
    // like this for actionable debugging).
    expect(loggedText).not.toContain("hunter2");
    expect(loggedText).not.toContain("mysql://");
    expect(loggedText).not.toContain("dbuser");
  });

  it("upsertUser() sanitizes a query failure before logging - never the raw error, connection string, credentials, SQL, or bound parameters", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbModule = await import("./db");

    const rawDriverError = new Error(
      "Failed query: insert into `users` (`openId`, `email`) values (?, ?)\n" +
        "params: user-123,user@example.invalid\n" +
        "connection mysql://dbuser:hunter2@db.internal.example:3306/prod password=hunter2 token=abcdef1234567890"
    );
    dbModule.__setDbForTests({
      insert: () => ({
        values: () => ({
          onDuplicateKeyUpdate: () => {
            throw rawDriverError;
          },
        }),
      }),
    } as any);

    try {
      await expect(dbModule.upsertUser({ openId: "user-123" })).rejects.toBe(rawDriverError);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedText = JSON.stringify(errorSpy.mock.calls[0]);
      expect(loggedText).not.toContain("hunter2");
      expect(loggedText).not.toContain("mysql://");
      expect(loggedText).not.toContain("params:");
      expect(loggedText).not.toContain("insert into");
    } finally {
      dbModule.__setDbForTests(null);
    }
  });
});
