/**
 * R40R57 controlled runtime composition - unit contract.
 *
 * These tests pin the kill-switch ordering (disabled runtime NEVER touches
 * loadDatabase), the snapshot discipline, the in-process busy guard and
 * fail-closed dependency validation with deferred-backed fakes - the
 * real-database half lives in s6ControlledRuntime.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { createControlledNotificationRuntime } from "./controlledRuntime";
import { readNotificationRuntimeFlags } from "./runtimeGate";

const ENABLED = readNotificationRuntimeFlags({
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_DELIVERY_ENABLED: "true",
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("R40R57 controlled runtime kill switches", () => {
  it("master OFF -> tick is disabled and loadDatabase is NEVER called, even with pending outbox", async () => {
    const loadDatabase = vi.fn(async () => {
      throw new Error("must not be touched while disabled");
    });
    const runtime = createControlledNotificationRuntime({
      flags: readNotificationRuntimeFlags({ NOTIFICATIONS_DELIVERY_ENABLED: "true" }),
      loadDatabase,
    });
    await expect(runtime.tick()).resolves.toEqual({ status: "disabled" });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("delivery OFF -> disabled before any database access", async () => {
    const loadDatabase = vi.fn(async () => null);
    const runtime = createControlledNotificationRuntime({
      flags: readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" }),
      loadDatabase,
    });
    await expect(runtime.tick()).resolves.toEqual({ status: "disabled" });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("the flags snapshot decides - a later environment flip cannot enable a disabled runtime", async () => {
    const env: Record<string, string | undefined> = {
      NOTIFICATIONS_DELIVERY_ENABLED: "true",
    };
    const loadDatabase = vi.fn(async () => null);
    const runtime = createControlledNotificationRuntime({
      flags: readNotificationRuntimeFlags(env),
      loadDatabase,
    });
    env.NOTIFICATIONS_ENABLED = "true";
    await expect(runtime.tick()).resolves.toEqual({ status: "disabled" });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("an enabled runtime opens the database lazily on the first tick only", async () => {
    const loadDatabase = vi.fn(async () => ({ transaction: vi.fn() }));
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase,
      clock: () => new Date(),
    });
    expect(loadDatabase).not.toHaveBeenCalled();
    await runtime.tick().catch(() => {});
    expect(loadDatabase).toHaveBeenCalledTimes(1);
  });

  it("fail closed: a database without transaction support rejects the tick, never a silent skip", async () => {
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase: async () => ({}),
    });
    await expect(runtime.tick()).rejects.toThrow(/database unavailable/i);
  });
});

describe("R40R57 one-shot invocation semantics", () => {
  function fakeDb(options: { gateTransactionUntil?: Promise<void> } = {}) {
    // satisfies the store's (transaction/select/update) AND the audience
    // reader's (select) dependency validation; select() returns a terminal
    // empty-row chain so the real claim query resolves with no rows.
    // The REAL store is composed from this database - only the DB boundary
    // is faked here.
    const chain: any = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject),
    };
    const db = {
      select: vi.fn(() => chain),
      update: vi.fn(() => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) })),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        if (options.gateTransactionUntil) await options.gateTransactionUntil;
        return fn(chain);
      }),
    };
    return db;
  }

  it("an empty queue completes claim rounds and opens the DB exactly once", async () => {
    const loadDatabase = vi.fn(async () => fakeDb());
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase,
    });
    const first = await runtime.tick();
    expect(first.status).toBe("completed");
    const second = await runtime.tick();
    expect(second.status).toBe("completed");
    expect(loadDatabase).toHaveBeenCalledTimes(1);
  });

  it("overlapping invocations collapse to ONE worker via the busy guard", async () => {
    const gate = deferred();
    const db = fakeDb({ gateTransactionUntil: gate.promise });
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase: async () => db,
    });
    const inFlight = runtime.tick();
    const overlapped = await runtime.tick();
    expect(overlapped).toEqual({ status: "busy" });
    gate.resolve();
    const completed = await inFlight;
    expect(completed.status).toBe("completed");
  });

  it("a transient database failure rejects that tick; a later tick recovers without process state", async () => {
    let healthy = false;
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase: async () => {
        if (!healthy) throw new Error("connection refused");
        return fakeDb();
      },
    });
    await expect(runtime.tick()).rejects.toThrow(/connection refused/);
    healthy = true;
    const recovered = await runtime.tick();
    expect(recovered.status).toBe("completed");
  });
});

describe("R40R57 no-autostart guarantee", () => {
  function fakeDb() {
    const chain: any = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject),
    };
    return {
      select: vi.fn(() => chain),
      update: vi.fn(() => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) })),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(chain)),
    };
  }

  it("importing the module and composing the runtime starts nothing", async () => {
    const loadDatabase = vi.fn(async () => fakeDb());
    const module = await import("./controlledRuntime");
    // pure factory: importing resolved without touching anything, and
    // composing only stores configuration
    const runtime = module.createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase,
    });
    expect(loadDatabase).not.toHaveBeenCalled();
    // an explicit one-shot is the ONLY way work happens
    await runtime.tick().catch(() => {});
    expect(loadDatabase).toHaveBeenCalledTimes(1);
  });

  it("an idle enabled runtime with pending rows still does nothing until ticked", async () => {
    const db = fakeDb();
    const runtime = createControlledNotificationRuntime({
      flags: ENABLED,
      loadDatabase: async () => db,
    });
    // yield the event loop a few turns - no timers exist to fire, and the
    // composition never claims on its own
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
