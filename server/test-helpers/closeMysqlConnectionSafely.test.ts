import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { closeMysqlConnectionSafely, type MinimalMysqlConnection } from "./closeMysqlConnectionSafely";

/**
 * DB-independent coverage for closeMysqlConnectionSafely() - every
 * connection here is a fake EventEmitter (real Node EventEmitter instances,
 * so `once`/`removeListener` behave exactly like a genuine mysql2/promise
 * connection's own EventEmitter surface), never a real network or database
 * connection. See scripts/test-db-prepare.ts and scripts/migrate-test-db.ts
 * for the real (TEST_DATABASE_URL-gated) usage this helper backs, and
 * closeMysqlConnectionSafely.ts's own header comment for the mysql2 3.22.5
 * source analysis this dual end()+'end'-event contract is based on.
 */

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

type FakeConnection = MinimalMysqlConnection & EventEmitter;

function makeConnection(options: { end: () => Promise<void>; destroy?: () => void }): FakeConnection {
  const emitter = new EventEmitter() as FakeConnection;
  emitter.end = options.end;
  emitter.destroy = vi.fn(options.destroy ?? (() => {}));
  return emitter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("closeMysqlConnectionSafely - dual end()+'end'-event contract", () => {
  it("case 1: end() resolves and the terminal 'end' event arrives shortly afterward - resolves successfully", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });
    // setImmediate (a macrotask) always fires after the already-pending
    // microtask that resolves end()'s promise - end() genuinely resolves first.
    setImmediate(() => conn.emit("end"));

    await expect(closeMysqlConnectionSafely(conn)).resolves.toBeUndefined();
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("case 2: the terminal 'end' event arrives before end() resolves - still resolves successfully once both complete", async () => {
    const conn = makeConnection({
      end: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    });
    queueMicrotask(() => conn.emit("end")); // fires almost immediately, well before end()'s 20ms delay

    await expect(closeMysqlConnectionSafely(conn, { timeoutMs: 200 })).resolves.toBeUndefined();
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("case 3: end() resolves but the terminal 'end' event never arrives - the timeout fires and destroy() is called", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() }); // never emits 'end'

    const failure = await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/forcibly destroyed/);
    expect((failure as Error).message).toMatch(/20ms/);
  });

  it("case 4: neither end() nor the terminal 'end' event ever completes - the timeout fires and destroy() is called", async () => {
    const conn = makeConnection({ end: () => neverSettles<void>() });

    const failure = await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/forcibly destroyed/);
  });

  it("case 5: end() rejects - throws a sanitized Error (not an AggregateError), and never calls destroy", async () => {
    const conn = makeConnection({ end: () => Promise.reject(new Error("connection reset by peer")) });

    const failure = await closeMysqlConnectionSafely(conn).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/connection reset by peer/);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("case 6: a destroy() failure after a timeout is preserved in the thrown error", async () => {
    const destroyError = new Error("destroy blew up");
    const conn = makeConnection({
      end: () => neverSettles<void>(),
      destroy: () => {
        throw destroyError;
      },
    });

    const failure = await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/);
    expect((failure as Error).message).toMatch(/destroy blew up/);
  });

  it("case 7: a primary operation failure plus a close failure preserves both errors in an AggregateError", async () => {
    const primaryError = new Error("primary boom");
    const conn = makeConnection({ end: () => Promise.reject(new Error("close boom")) });

    const failure = await closeMysqlConnectionSafely(conn, { primaryError }).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0].message).toMatch(/primary boom/);
    expect(aggregate.errors[1].message).toMatch(/close boom/);
  });

  it("case 8: the temporary 'end' listener is removed after a successful close", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });
    setImmediate(() => conn.emit("end"));

    await closeMysqlConnectionSafely(conn);

    expect(conn.listenerCount("end")).toBe(0);
  });

  it("case 9: the temporary 'end' listener is removed after end() rejects", async () => {
    const conn = makeConnection({ end: () => Promise.reject(new Error("boom")) });

    await closeMysqlConnectionSafely(conn).catch(() => {});

    expect(conn.listenerCount("end")).toBe(0);
  });

  it("case 10: the temporary 'end' listener is removed after a timeout", async () => {
    const conn = makeConnection({ end: () => neverSettles<void>() });

    await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).catch(() => {});

    expect(conn.listenerCount("end")).toBe(0);
  });

  it("case 11: the internal timeout is cleared after a successful close", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const conn = makeConnection({ end: () => Promise.resolve() });
    setImmediate(() => conn.emit("end"));

    await closeMysqlConnectionSafely(conn, { timeoutMs: 5000 });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("case 12: the internal timeout handle is never unref'd - it must remain able to keep the process alive until it fires or is cleared", async () => {
    const realSetTimeout = global.setTimeout;
    let unrefCallCount = 0;

    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
      const handle: any = realSetTimeout(fn, ms, ...args);
      const originalUnref = handle.unref?.bind(handle);
      if (originalUnref) {
        handle.unref = (...unrefArgs: any[]) => {
          unrefCallCount += 1;
          return originalUnref(...unrefArgs);
        };
      }
      return handle;
    }) as any);

    const conn = makeConnection({ end: () => neverSettles<void>() });
    await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).catch(() => {});

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unrefCallCount).toBe(0);

    setTimeoutSpy.mockRestore();
  });

  it("case 13: never calls process.exit() regardless of outcome (success, rejection, or timeout)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit was called - this must never happen");
    }) as any);

    const successConn = makeConnection({ end: () => Promise.resolve() });
    setImmediate(() => successConn.emit("end"));
    await closeMysqlConnectionSafely(successConn);

    const rejectConn = makeConnection({ end: () => Promise.reject(new Error("boom")) });
    await closeMysqlConnectionSafely(rejectConn).catch(() => {});

    const timeoutConn = makeConnection({ end: () => neverSettles<void>() });
    await closeMysqlConnectionSafely(timeoutConn, { timeoutMs: 20 }).catch(() => {});

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("case 14: never accesses any property beyond end/destroy/once/removeListener - no private handle or socket inspection", async () => {
    const emitter = new EventEmitter();
    const allowedProps = new Set(["end", "destroy", "once", "removeListener", "emit", "listenerCount"]);
    const strictConnection = new Proxy(
      {
        end: () => Promise.resolve(),
        destroy: vi.fn(),
        once: emitter.once.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
        emit: emitter.emit.bind(emitter),
        listenerCount: emitter.listenerCount.bind(emitter),
      },
      {
        get(target: any, prop, receiver) {
          if (typeof prop === "string" && !allowedProps.has(prop) && !(prop in Object.prototype)) {
            throw new Error(`closeMysqlConnectionSafely accessed an unexpected, non-public property: ${String(prop)}`);
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    ) as unknown as FakeConnection;

    setImmediate(() => strictConnection.emit("end"));

    await expect(closeMysqlConnectionSafely(strictConnection)).resolves.toBeUndefined();
  });
});

describe("closeMysqlConnectionSafely - error sanitization", () => {
  it("case 15: sensitive values embedded directly inside error.message are redacted, not echoed raw", async () => {
    const endError: any = new Error(
      "connect failed for mysql://root:hunter2@10.0.0.5:3306/ipenovel_test - " +
        "getaddrinfo ENOTFOUND db.internal - Access denied for user 'root'@'10.0.0.5' " +
        "(using password: YES) token=abc123SECRETTOKEN"
    );
    endError.code = "ER_ACCESS_DENIED_ERROR";
    endError.errno = 1045;

    const conn = makeConnection({ end: () => Promise.reject(endError) });

    const failure = await closeMysqlConnectionSafely(conn).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/hunter2/);
    expect(message).not.toMatch(/10\.0\.0\.5/);
    expect(message).not.toMatch(/db\.internal/);
    expect(message).not.toMatch(/mysql:\/\//);
    expect(message).not.toMatch(/'root'/);
    expect(message).not.toMatch(/abc123SECRETTOKEN/);
    // Safe fields are still preserved.
    expect(message).toMatch(/ER_ACCESS_DENIED_ERROR/);
    expect(message).toMatch(/1045/);
  });

  it("case 16: a non-Error thrown value's toString() result is redacted too, never echoed via an unrestricted String(error)", async () => {
    const sensitiveNonError = {
      toString() {
        return "mysql://root:hunter2@10.0.0.5:3306/ipenovel_test?token=abc123SECRETTOKEN";
      },
    };
    const conn = makeConnection({ end: () => Promise.reject(sensitiveNonError) });

    const failure = await closeMysqlConnectionSafely(conn).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/hunter2/);
    expect(message).not.toMatch(/10\.0\.0\.5/);
    expect(message).not.toMatch(/root/);
    expect(message).not.toMatch(/mysql:\/\//);
    expect(message).not.toMatch(/abc123SECRETTOKEN/);
  });
});
