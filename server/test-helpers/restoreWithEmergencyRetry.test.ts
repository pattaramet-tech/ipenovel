import { describe, it, expect, vi, afterEach } from "vitest";
import { restoreToFullyMigratedWithRetry } from "./restoreWithEmergencyRetry";

/**
 * DB-independent coverage for restoreToFullyMigratedWithRetry()'s
 * control-flow contract - every dependency (connect/queryLiveDatabaseName/
 * runCleanup/closeConnection) is a fake, so this proves the retry/throw
 * semantics without ever touching a real database. See
 * server/migration-0024-episode-schema-repair.integration.test.ts for the
 * real (TEST_DATABASE_URL-gated) integration usage this helper backs.
 */

const EXPECTED = "ipenovel_test";

type FakeConn = { id: string };

function fakeConn(id = "emergency-conn"): FakeConn {
  return { id };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("restoreToFullyMigratedWithRetry", () => {
  it("case 1: primary cleanup succeeds - resolves without ever calling connect", async () => {
    const connect = vi.fn();
    const primaryCleanup = vi.fn().mockResolvedValue(undefined);

    await expect(
      restoreToFullyMigratedWithRetry(primaryCleanup, {
        connect,
        queryLiveDatabaseName: vi.fn(),
        runCleanup: vi.fn(),
        closeConnection: vi.fn(),
        expectedDatabaseName: EXPECTED,
      })
    ).resolves.toBeUndefined();

    expect(connect).not.toHaveBeenCalled();
  });

  it("case 3: no emergency connection can be created - throws, never resolves, and preserves the primary error", async () => {
    const primaryCleanup = vi.fn().mockRejectedValue(new Error("primary boom"));
    const connect = vi.fn().mockResolvedValue(null);
    const closeConnection = vi.fn();

    await expect(
      restoreToFullyMigratedWithRetry(primaryCleanup, {
        connect,
        queryLiveDatabaseName: vi.fn(),
        runCleanup: vi.fn(),
        closeConnection,
        expectedDatabaseName: EXPECTED,
      })
    ).rejects.toThrow(/primary boom/);

    expect(closeConnection).not.toHaveBeenCalled(); // nothing to close - no connection was ever opened
  });

  it("case 4: live database-name check fails - throws immediately (not an AggregateError), never runs cleanup, and closes the connection", async () => {
    const primaryCleanup = vi.fn().mockRejectedValue(new Error("primary boom"));
    const conn = fakeConn();
    const connect = vi.fn().mockResolvedValue(conn);
    const runCleanup = vi.fn();
    const closeConnection = vi.fn().mockResolvedValue(undefined);

    const failure = await restoreToFullyMigratedWithRetry(primaryCleanup, {
      connect,
      queryLiveDatabaseName: vi.fn().mockResolvedValue("some_other_database"),
      runCleanup,
      closeConnection,
      expectedDatabaseName: EXPECTED,
    }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/some_other_database/);
    expect((failure as Error).message).toMatch(/primary boom/); // primary failure preserved
    expect(runCleanup).not.toHaveBeenCalled(); // guard failure must block the destructive retry
    expect(closeConnection).toHaveBeenCalledWith(conn);
  });

  it("case 5: emergency cleanup itself fails - closes the connection, then throws an AggregateError containing both failures", async () => {
    const primaryError = new Error("primary boom");
    const emergencyError = new Error("emergency boom");
    const primaryCleanup = vi.fn().mockRejectedValue(primaryError);
    const conn = fakeConn();
    const connect = vi.fn().mockResolvedValue(conn);
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const runCleanup = vi.fn().mockRejectedValue(emergencyError);

    const failure = await restoreToFullyMigratedWithRetry(primaryCleanup, {
      connect,
      queryLiveDatabaseName: vi.fn().mockResolvedValue(EXPECTED),
      runCleanup,
      closeConnection,
      expectedDatabaseName: EXPECTED,
    }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0].message).toMatch(/primary boom/);
    expect(aggregate.errors[1].message).toMatch(/emergency boom/);
    expect(closeConnection).toHaveBeenCalledWith(conn);
  });

  it("case 6: emergency cleanup succeeds - resolves normally and closes the connection", async () => {
    const primaryCleanup = vi.fn().mockRejectedValue(new Error("primary boom"));
    const conn = fakeConn();
    const connect = vi.fn().mockResolvedValue(conn);
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const runCleanup = vi.fn().mockResolvedValue(undefined);

    await expect(
      restoreToFullyMigratedWithRetry(primaryCleanup, {
        connect,
        queryLiveDatabaseName: vi.fn().mockResolvedValue(EXPECTED),
        runCleanup,
        closeConnection,
        expectedDatabaseName: EXPECTED,
      })
    ).resolves.toBeUndefined();

    expect(runCleanup).toHaveBeenCalledWith(conn);
    expect(closeConnection).toHaveBeenCalledWith(conn);
  });

  it("never logs a connection string, password, or raw connection configuration", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const primaryError: any = new Error("connect failed");
    primaryError.code = "ER_ACCESS_DENIED_ERROR";
    primaryError.errno = 1045;
    primaryError.sqlState = "28000";
    // Simulate a driver error object that (like real mysql2 errors can)
    // carries connection config as extra fields - the sanitizer must never
    // surface these even if present on the error object.
    primaryError.config = { user: "root", password: "hunter2", host: "db.internal" };

    const primaryCleanup = vi.fn().mockRejectedValue(primaryError);
    const connect = vi.fn().mockResolvedValue(null);

    await expect(
      restoreToFullyMigratedWithRetry(primaryCleanup, {
        connect,
        queryLiveDatabaseName: vi.fn(),
        runCleanup: vi.fn(),
        closeConnection: vi.fn(),
        expectedDatabaseName: EXPECTED,
      })
    ).rejects.toThrow();

    const allLoggedText = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(allLoggedText).not.toMatch(/hunter2/);
    expect(allLoggedText).not.toMatch(/mysql:\/\//);
    expect(allLoggedText).not.toMatch(/password/i);
  });
});
