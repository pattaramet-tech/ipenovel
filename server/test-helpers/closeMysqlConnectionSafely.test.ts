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
 * closeMysqlConnectionSafely.ts's own header comment for why the remote
 * "end" event is diagnostic-only rather than mandatory - three real Gate A
 * runs against TiDB proved requiring it made every close report as a
 * timeout, since end() resolved but "end" never arrived within 5000ms.
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

describe("closeMysqlConnectionSafely - the remote 'end' event is diagnostic-only, never mandatory", () => {
  it("case 1: end() resolves and local finalization (destroy()) succeeds - the normal, successful close path", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });

    await expect(closeMysqlConnectionSafely(conn)).resolves.toBeUndefined();

    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("case 2: the remote 'end' event never fires at all - the close still succeeds (this is the exact TiDB scenario three real Gate A runs failed on)", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });
    // Deliberately never emit 'end' - simulates TiDB's observed behavior of
    // not reliably sending/delivering the remote FIN.

    await expect(closeMysqlConnectionSafely(conn, { timeoutMs: 50 })).resolves.toBeUndefined();

    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("case 3: the remote 'end' event fires before end() resolves - ordering never matters, the close still succeeds via local finalization", async () => {
    const conn = makeConnection({
      end: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    });
    queueMicrotask(() => conn.emit("end")); // fires almost immediately, well before end()'s 10ms delay

    await expect(closeMysqlConnectionSafely(conn, { timeoutMs: 200 })).resolves.toBeUndefined();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("local finalization (destroy()) is called only AFTER end() resolves, never before or concurrently", async () => {
    const callOrder: string[] = [];
    const conn = makeConnection({
      end: () => {
        callOrder.push("end-called");
        return Promise.resolve().then(() => {
          callOrder.push("end-resolved");
        });
      },
      destroy: () => {
        callOrder.push("destroy-called");
      },
    });

    await closeMysqlConnectionSafely(conn);

    expect(callOrder).toEqual(["end-called", "end-resolved", "destroy-called"]);
  });
});

describe("closeMysqlConnectionSafely - real failure paths", () => {
  it("case 4: end() hangs (never settles) - the timeout fires, destroy() is called, and the timeout is reported honestly as a failure", async () => {
    const conn = makeConnection({ end: () => neverSettles<void>() });

    const failure = await closeMysqlConnectionSafely(conn, { timeoutMs: 20 }).then(
      () => null,
      (e) => e
    );

    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/did not settle within 20ms/);
    expect((failure as Error).message).toMatch(/forcibly destroyed after timing out/);
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

  it("case 6: local finalization (destroy()) throws after end() resolves normally - reported as a plain finalization failure, never 'forced'/'timed out' language", async () => {
    const finalizeError = new Error("destroy blew up");
    const conn = makeConnection({
      end: () => Promise.resolve(),
      destroy: () => {
        throw finalizeError;
      },
    });

    const failure = await closeMysqlConnectionSafely(conn).then(
      () => null,
      (e) => e
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/local transport finalization failed/);
    expect((failure as Error).message).toMatch(/destroy blew up/);
    expect((failure as Error).message).not.toMatch(/forcibly destroyed/);
    expect((failure as Error).message).not.toMatch(/forced/);
    expect((failure as Error).message).not.toMatch(/timed out/);
  });

  it("a destroy() failure during the real timeout-recovery path is preserved in the thrown error", async () => {
    const destroyError = new Error("destroy blew up during timeout recovery");
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
    expect((failure as Error).message).toMatch(/destroy blew up during timeout recovery/);
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
});

describe("closeMysqlConnectionSafely - listener and timer cleanup", () => {
  it("case 8: the temporary 'end' listener is removed after a successful close", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });

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

  it("case 11: the internal timeout is cleared on every path (success, rejection, timeout)", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const successConn = makeConnection({ end: () => Promise.resolve() });
    await closeMysqlConnectionSafely(successConn, { timeoutMs: 5000 });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockClear();
    const rejectConn = makeConnection({ end: () => Promise.reject(new Error("boom")) });
    await closeMysqlConnectionSafely(rejectConn, { timeoutMs: 5000 }).catch(() => {});
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockClear();
    const timeoutConn = makeConnection({ end: () => neverSettles<void>() });
    await closeMysqlConnectionSafely(timeoutConn, { timeoutMs: 20 }).catch(() => {});
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
});

describe("closeMysqlConnectionSafely - never process.exit(), never private driver internals", () => {
  it("case 13: never calls process.exit() regardless of outcome (success, rejection, or timeout)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit was called - this must never happen");
    }) as any);

    const successConn = makeConnection({ end: () => Promise.resolve() });
    await closeMysqlConnectionSafely(successConn);

    const rejectConn = makeConnection({ end: () => Promise.reject(new Error("boom")) });
    await closeMysqlConnectionSafely(rejectConn).catch(() => {});

    const timeoutConn = makeConnection({ end: () => neverSettles<void>() });
    await closeMysqlConnectionSafely(timeoutConn, { timeoutMs: 20 }).catch(() => {});

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("case 14/15: never accesses any property beyond end/destroy/once/removeListener - no private handle, driver, or raw socket access", async () => {
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

    // Never emits 'end' at all - proves success does not require it, using
    // the same strict, access-guarded connection that would fail loudly if
    // anything reached into `.stream`, `.connection`, `._closing`, or any
    // other private/underscore-prefixed property.
    await expect(closeMysqlConnectionSafely(strictConnection, { timeoutMs: 50 })).resolves.toBeUndefined();
  });
});

describe("closeMysqlConnectionSafely - onDiagnostic markers", () => {
  it("invokes onDiagnostic with the four fixed markers, in order, on a normal successful close", async () => {
    const conn = makeConnection({ end: () => Promise.resolve() });
    const markers: string[] = [];

    await closeMysqlConnectionSafely(conn, { onDiagnostic: (marker) => markers.push(marker) });

    expect(markers).toEqual([
      "connection end started",
      "connection end completed",
      "local transport finalization started",
      "local transport finalization completed",
    ]);
  });

  it("never invokes onDiagnostic with error text, even when the close ultimately fails", async () => {
    const conn = makeConnection({ end: () => Promise.reject(new Error("mysql://root:hunter2@10.0.0.5:3306/db")) });
    const markers: string[] = [];

    await closeMysqlConnectionSafely(conn, { onDiagnostic: (marker) => markers.push(marker) }).catch(() => {});

    for (const marker of markers) {
      expect(marker).not.toMatch(/hunter2/);
      expect(marker).not.toMatch(/mysql:\/\//);
    }
  });
});

describe("closeMysqlConnectionSafely - error sanitization", () => {
  it("sensitive values embedded directly inside error.message are redacted, not echoed raw", async () => {
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

  it("a non-Error thrown value's toString() result is redacted too, never echoed via an unrestricted String(error)", async () => {
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
