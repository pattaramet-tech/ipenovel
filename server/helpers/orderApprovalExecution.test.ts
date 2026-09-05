import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrderApprovalVerificationBudget,
  OrderApprovalVerificationTimeoutError,
  setOrderApprovalConnectionId,
  traceOrderApprovalStage,
  withOrderApprovalExecution,
} from "./orderApprovalExecution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function parseTraceCall(call: unknown[]) {
  expect(call).toHaveLength(1);
  const line = String(call[0]);
  const prefix = "[OrderPaymentApprovalExecution] ";
  expect(line.startsWith(prefix)).toBe(true);
  expect(line).not.toContain("\n");
  return JSON.parse(line.slice(prefix.length));
}

describe("order approval cooperative verification budget", () => {
  it("defaults to 15000ms and caps each fetch to its positive remaining time", () => {
    let now = 100;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    expect(budget.remainingMs(30_000)).toBe(15_000);
    expect(budget.remainingMs(2_000)).toBe(2_000);
    now += 12_000;
    expect(budget.remainingMs(10_000)).toBe(3_000);
    now += 2_999.5;
    expect(budget.remainingMs(10_000)).toBe(0.5);
    expect(() => budget.throwIfExpired()).not.toThrow();
    now += 0.5;
    expect(() => budget.throwIfExpired()).toThrow(OrderApprovalVerificationTimeoutError);
    expect(() => budget.remainingMs(10_000)).toThrow(OrderApprovalVerificationTimeoutError);
  });

  it("supports a controlled clock and exposes only the fixed safe timeout code/message", () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ timeoutMs: 50, now: () => now });
    now = 51;
    try {
      budget.throwIfExpired();
      throw new Error("Expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(OrderApprovalVerificationTimeoutError);
      expect(error).toMatchObject({
        code: "ORDER_PAYMENT_VERIFICATION_TIMEOUT",
        message: "Payment slip verification timed out. Nothing was approved. Please ask an administrator to check the verification logs before retrying.",
      });
    }
  });

  it("rejects invalid timeout/cap configuration and fails closed if the clock is invalid", () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => createOrderApprovalVerificationBudget({ timeoutMs: value })).toThrow(RangeError);
      expect(() => createOrderApprovalVerificationBudget().remainingMs(value)).toThrow(RangeError);
    }
    let now = 1;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    now = NaN;
    expect(() => budget.throwIfExpired()).toThrow(OrderApprovalVerificationTimeoutError);
  });

  it("does not allocate timers or race the operation as a hard deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const budget = createOrderApprovalVerificationBudget({ timeoutMs: 1, now: () => now });
      now = 2;
      expect(vi.getTimerCount()).toBe(0);
      expect(() => budget.throwIfExpired()).toThrow(OrderApprovalVerificationTimeoutError);
    } finally { vi.useRealTimers(); }
  });
});

describe("safe order approval execution tracing", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const records = () => vi.mocked(console.info).mock.calls.map(parseTraceCall);

  it("isolates concurrent payment runs and their connection IDs across awaits", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const run = (id: number, connectionId: number, gate: Promise<void>) =>
      withOrderApprovalExecution(id, true, async () => {
        setOrderApprovalConnectionId(connectionId);
        return traceOrderApprovalStage("verification", async () => {
          await gate;
          await traceOrderApprovalStage("claim_insert", async () => id);
          return id;
        });
      });
    const first = run(101, 501, a.promise);
    const second = run(202, 602, b.promise);
    b.resolve();
    expect(await second).toBe(202);
    a.resolve();
    expect(await first).toBe(101);

    const all = records();
    const runIds = new Set(all.map((record) => record.runId));
    expect(runIds.size).toBe(2);
    for (const paymentId of [101, 202]) {
      const group = all.filter((record) => record.paymentId === paymentId);
      expect(new Set(group.map((record) => record.runId)).size).toBe(1);
      expect(group[0].runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(group.filter((record) => record.event !== "run_start").every(
        (record) => record.connectionId === (paymentId === 101 ? 501 : 602)
      )).toBe(true);
      expect(group.at(-1)).toMatchObject({ event: "run_end", outcome: "committed" });
    }
  });

  it("does not report commit until the actual owned transaction promise resolves", async () => {
    const transaction = deferred<string>();
    const pending = withOrderApprovalExecution(101, true, () => transaction.promise);
    expect(records().map((record) => record.event)).toEqual(["run_start"]);
    transaction.resolve("done");
    expect(await pending).toBe("done");
    expect(records().at(-1)).toMatchObject({ event: "run_end", outcome: "committed" });
  });

  it("distinguishes owned transaction failure from borrowed failure without claiming rollback", async () => {
    const error = { code: "SOME_NON_1205_CODE", message: "sensitive SQL and reference" };
    for (const ownsTransaction of [true, false]) {
      await expect(withOrderApprovalExecution(101, ownsTransaction, async () =>
        traceOrderApprovalStage("payment_update", async () => { throw error; })
      )).rejects.toBe(error);
      expect(records().at(-1)).toMatchObject({
        event: "run_error",
        outcome: ownsTransaction ? "transaction_failed" : "failed_to_caller",
      });
    }
    expect(JSON.stringify(records())).not.toContain(error.message);
    expect(JSON.stringify(records())).not.toContain(error.code);
    expect(JSON.stringify(records())).not.toContain("rolled_back");
  });

  it("reports borrowed success as returned_to_caller, never as committed", async () => {
    expect(await withOrderApprovalExecution(101, false, async () => 42)).toBe(42);
    expect(records().at(-1)).toMatchObject({ event: "run_end", outcome: "returned_to_caller" });
    expect(JSON.stringify(records())).not.toContain("committed");
  });

  it("logs only known stages and positive safe integer identifiers, never arbitrary inputs", async () => {
    const secret = "secret-url-query-file-hash";
    await withOrderApprovalExecution(secret as any, false, async () => {
      for (const value of [secret, "123", 0, -2, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        setOrderApprovalConnectionId(value);
      }
      expect(await traceOrderApprovalStage(secret as any, async () => 7)).toBe(7);
      await traceOrderApprovalStage("connection_id", async () => {});
    });
    const all = records();
    expect(all.every((record) => !Object.hasOwn(record, "paymentId"))).toBe(true);
    expect(all.every((record) => !Object.hasOwn(record, "connectionId"))).toBe(true);
    expect(JSON.stringify(all)).not.toContain(secret);
    const allowedKeys = new Set(["event", "runId", "paymentId", "connectionId", "processPid", "stage", "durationMs", "elapsedMs", "outcome"]);
    expect(all.every((record) => Object.keys(record).every((key) => allowedKeys.has(key)))).toBe(true);
    expect(all.every((record) => record.processPid === process.pid)).toBe(true);
  });

  it("emits one slow warning after 5000ms and cleans up the timer on success", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const running = withOrderApprovalExecution(101, true, () =>
      traceOrderApprovalStage("current_byte_hash", () => gate.promise)
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(parseTraceCall(warn.mock.calls[0])).toMatchObject({ event: "stage_slow", paymentId: 101, stage: "current_byte_hash" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warn).toHaveBeenCalledTimes(1);
    gate.resolve();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up pending slow timers on failure and never wraps an error", async () => {
    vi.useFakeTimers();
    const error = new Error("business failure");
    await expect(withOrderApprovalExecution(101, true, () =>
      traceOrderApprovalStage("claim_insert", async () => { throw error; })
    )).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not trace without an execution context or let a logging failure alter the result", async () => {
    setOrderApprovalConnectionId(42);
    expect(await traceOrderApprovalStage("owner_read", async () => 7)).toBe(7);
    expect(info).not.toHaveBeenCalled();
    info.mockImplementation(() => { throw new Error("logging unavailable"); });
    expect(await withOrderApprovalExecution(101, true, () =>
      traceOrderApprovalStage("owner_read", async () => 9)
    )).toBe(9);
  });
});
