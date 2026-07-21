import { describe, it, expect, vi, afterEach } from "vitest";
import { closeMysqlConnectionSafely, type MinimalMysqlConnection } from "./closeMysqlConnectionSafely";

/**
 * DB-independent coverage for closeMysqlConnectionSafely() - every
 * connection here is a fake object implementing only end()/destroy(),
 * never a real network or database connection, so this proves the
 * close/timeout/error-preservation contract in isolation. See
 * scripts/test-db-prepare.ts and scripts/migrate-test-db.ts for the real
 * (TEST_DATABASE_URL-gated) usage this helper backs.
 */

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("closeMysqlConnectionSafely", () => {
  it("case 1: graceful end resolves - resolves without throwing, and never calls destroy", async () => {
    const destroy = vi.fn();
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockResolvedValue(undefined),
      destroy,
    };

    await expect(closeMysqlConnectionSafely(connection)).resolves.toBeUndefined();

    expect(destroy).not.toHaveBeenCalled();
  });

  it("case 2: graceful end rejects - throws a sanitized Error (not an AggregateError), and never calls destroy", async () => {
    const destroy = vi.fn();
    const endError = new Error("connection reset by peer");
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockRejectedValue(endError),
      destroy,
    };

    const failure = await closeMysqlConnectionSafely(connection).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/connection reset by peer/);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("case 3: graceful end never settles - the bounded timeout fires and destroy() is called", async () => {
    const destroy = vi.fn();
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockImplementation(() => neverSettles<void>()),
      destroy,
    };

    const failure = await closeMysqlConnectionSafely(connection, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/forcibly destroyed/);
    expect((failure as Error).message).toMatch(/20ms/);
  });

  it("case 4: the internal timeout is cleared after a successful close", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    await closeMysqlConnectionSafely(connection, { timeoutMs: 5000 });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("case 5: a destroy() failure after a timeout is preserved in the thrown error", async () => {
    const destroyError = new Error("destroy blew up");
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockImplementation(() => neverSettles<void>()),
      destroy: vi.fn().mockImplementation(() => {
        throw destroyError;
      }),
    };

    const failure = await closeMysqlConnectionSafely(connection, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/);
    expect((failure as Error).message).toMatch(/destroy blew up/);
  });

  it("case 6: a primary operation failure plus a close failure preserves both errors in an AggregateError", async () => {
    const primaryError = new Error("primary boom");
    const endError = new Error("close boom");
    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockRejectedValue(endError),
      destroy: vi.fn(),
    };

    const failure = await closeMysqlConnectionSafely(connection, { primaryError }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0].message).toMatch(/primary boom/);
    expect(aggregate.errors[1].message).toMatch(/close boom/);
  });

  it("case 7: the sanitized error never contains connection details even if the underlying error object carries them", async () => {
    const endError: any = new Error("insecure transport");
    endError.code = "ER_ACCESS_DENIED_ERROR";
    endError.errno = 1045;
    // Simulate a driver error object that (like real mysql2 errors can)
    // carries connection config as extra fields - the sanitizer must never
    // surface these even if present on the error object.
    endError.config = { user: "root", password: "hunter2", host: "db.internal", uri: "mysql://root:hunter2@db.internal:3306/ipenovel_test" };

    const connection: MinimalMysqlConnection = {
      end: vi.fn().mockRejectedValue(endError),
      destroy: vi.fn(),
    };

    const failure = await closeMysqlConnectionSafely(connection).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/hunter2/);
    expect(message).not.toMatch(/db\.internal/);
    expect(message).not.toMatch(/mysql:\/\//);
    expect(message).not.toMatch(/password/i);
    expect(message).toMatch(/ER_ACCESS_DENIED_ERROR/);
  });
});
