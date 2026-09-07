import { describe, expect, it, vi } from "vitest";
import {
  runWorkspaceTransactionWithDeadlockRetry,
  WORKSPACE_TRANSACTION_MAX_ATTEMPTS,
} from "./transactionRetry";

function deadlockError() {
  return Object.assign(new Error("wrapped"), {
    cause: { errno: 1213, code: "ER_LOCK_DEADLOCK", sqlState: "40001" },
  });
}

describe("runWorkspaceTransactionWithDeadlockRetry", () => {
  it("retries one deadlock on a fresh transaction and returns the second result", async () => {
    const txObjects = [{ attempt: 1 }, { attempt: 2 }];
    const operation = vi.fn(async (tx: { attempt: number }) => {
      if (tx.attempt === 1) throw deadlockError();
      return `ok-${tx.attempt}`;
    });
    const database = {
      transaction: vi
        .fn()
        .mockImplementationOnce(async (callback: typeof operation) => callback(txObjects[0]))
        .mockImplementationOnce(async (callback: typeof operation) => callback(txObjects[1])),
    };

    await expect(
      runWorkspaceTransactionWithDeadlockRetry(database, operation)
    ).resolves.toBe("ok-2");
    expect(database.transaction).toHaveBeenCalledTimes(2);
    expect(operation.mock.calls.map(([tx]) => tx)).toEqual(txObjects);
  });

  it("does not retry non-deadlock errors", async () => {
    const failure = new Error("validation failed");
    const database = {
      transaction: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      runWorkspaceTransactionWithDeadlockRetry(database, vi.fn())
    ).rejects.toBe(failure);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it("fails closed after the bounded deadlock retry budget", async () => {
    const database = {
      transaction: vi.fn(async () => {
        throw deadlockError();
      }),
    };

    await expect(
      runWorkspaceTransactionWithDeadlockRetry(database, vi.fn())
    ).rejects.toMatchObject({
      cause: { errno: 1213, code: "ER_LOCK_DEADLOCK" },
    });
    expect(database.transaction).toHaveBeenCalledTimes(
      WORKSPACE_TRANSACTION_MAX_ATTEMPTS
    );
  });
});
