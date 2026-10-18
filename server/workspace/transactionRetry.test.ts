import { describe, expect, it, vi } from "vitest";
import {
  editorialBoardReconcileDecision,
  editorialCheckerBoardProjectionInput,
} from "./editorialQcProjection.service";
import {
  editorialBoardProjectionResult,
  runWorkspaceTransactionWithDeadlockRetry,
  settleIdempotentWorkspaceTransaction,
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

describe("settleIdempotentWorkspaceTransaction", () => {
  it("returns the projection when the retry succeeds", async () => {
    const database = {
      transaction: vi
        .fn()
        .mockImplementationOnce(async () => {
          throw deadlockError();
        })
        .mockImplementationOnce(async (callback: (tx: { attempt: number }) => Promise<string>) =>
          callback({ attempt: 2 })),
    };
    await expect(settleIdempotentWorkspaceTransaction(database, async () => "projected")).resolves.toBe("projected");
  });

  it("reports a deferred board update after the committed work when every attempt deadlocks", async () => {
    const database = {
      transaction: vi.fn(async () => {
        throw deadlockError();
      }),
    };
    await expect(settleIdempotentWorkspaceTransaction(database, vi.fn())).resolves.toEqual({
      deferred: true,
      reason: "BOARD_PROJECTION_DEFERRED",
    });
  });

  it("still throws a non-deadlock projection failure", async () => {
    const failure = new Error("board missing");
    const database = {
      transaction: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(settleIdempotentWorkspaceTransaction(database, vi.fn())).rejects.toBe(failure);
  });

  it("does not treat an exhausted deadlock as a board update, then applies the same key on reconciliation", async () => {
    const idempotencyKey = "editorial-qc-9-needs_fix";
    const attempted: string[] = [];
    const failing = {
      transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation({})),
    };
    const deferred = await settleIdempotentWorkspaceTransaction(failing, async () => {
      attempted.push(idempotencyKey);
      throw deadlockError();
    });
    expect(editorialBoardProjectionResult(deferred)).toEqual({
      status: "deferred",
      applied: false,
    });
    expect(attempted).toEqual([idempotencyKey, idempotencyKey]);
    expect(failing.transaction).toHaveBeenCalledTimes(WORKSPACE_TRANSACTION_MAX_ATTEMPTS);

    attempted.length = 0;
    const recovering = {
      transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation({})),
    };
    const repaired = await settleIdempotentWorkspaceTransaction(recovering, async () => {
      attempted.push(idempotencyKey);
      return { changed: true, replayed: false, columnId: 4 };
    });
    expect(editorialBoardProjectionResult(repaired)).toEqual({
      status: "updated",
      applied: true,
    });
    expect(attempted).toEqual([idempotencyKey]);
    expect(recovering.transaction).toHaveBeenCalledTimes(1);
    expect(editorialCheckerBoardProjectionInput({
      workItemId: 7,
      draftId: 8,
      runId: 9,
      blockingIssueCount: 1,
      actorUserId: 4,
    }).idempotencyKey).toBe(idempotencyKey);
  });
});

describe("editorial board reconciliation", () => {
  it("retries a checker column that is still on an earlier column", () => {
    expect(editorialBoardReconcileDecision("editing")).toBe("project");
    expect(editorialBoardReconcileDecision("needs_fix")).toBe("project");
    expect(editorialBoardReconcileDecision("pending_confirm")).toBe("project");
    expect(editorialBoardReconcileDecision(null)).toBe("project");
  });

  it("does not treat a later stage or publish column as a successful QC update", () => {
    expect(editorialBoardProjectionResult({
      changed: false,
      reason: "LATER_BOARD_OWNS_COLUMN",
    })).toEqual({ status: "unchanged", applied: false });
  });

  it("does not pull a staged or published card back to the checker column", () => {
    expect(editorialBoardReconcileDecision("ready_to_publish")).toBe("leave-later-column");
    expect(editorialBoardReconcileDecision("published")).toBe("leave-later-column");
  });
});
