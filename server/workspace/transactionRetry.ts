const DEADLOCK_ERRNO = 1213;
const DEADLOCK_CODE = "ER_LOCK_DEADLOCK";
const MAX_CAUSE_DEPTH = 8;

export const WORKSPACE_TRANSACTION_MAX_ATTEMPTS = 2;

export function isWorkspaceTransactionDeadlock(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    if (visited.has(current)) return false;
    visited.add(current);

    const link = current as { errno?: unknown; code?: unknown; cause?: unknown };
    const errno =
      typeof link.errno === "number"
        ? link.errno
        : typeof link.errno === "string" && /^\s*1213\s*$/.test(link.errno)
          ? DEADLOCK_ERRNO
          : undefined;
    if (errno === DEADLOCK_ERRNO || link.code === DEADLOCK_CODE) return true;
    current = link.cause;
  }

  return false;
}

/**
 * Retries only a MariaDB/MySQL deadlock and always retries the whole transaction.
 * database.transaction() owns rollback before this function catches the failure,
 * so every retry receives a fresh transaction object/snapshot.
 */
export async function runWorkspaceTransactionWithDeadlockRetry<T>(
  database: {
    transaction<R>(operation: (tx: any) => Promise<R>): Promise<R>;
  },
  operation: (tx: any) => Promise<T>
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= WORKSPACE_TRANSACTION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await database.transaction(operation);
    } catch (error) {
      if (
        !isWorkspaceTransactionDeadlock(error) ||
        attempt >= WORKSPACE_TRANSACTION_MAX_ATTEMPTS
      ) {
        throw error;
      }
    }
  }

  throw new Error("Workspace transaction attempts exhausted without a result.");
}

/**
 * Retries one deadlock. If the committed work is already durable and only this
 * later transaction deadlocks again, return a deferred result instead of
 * throwing away the caller's success.
 */
export async function settleIdempotentWorkspaceTransaction<T>(
  database: {
    transaction<R>(operation: (tx: any) => Promise<R>): Promise<R>;
  },
  operation: (tx: any) => Promise<T>,
): Promise<T | { deferred: true; reason: "BOARD_PROJECTION_DEFERRED" }> {
  try {
    return await runWorkspaceTransactionWithDeadlockRetry(database, operation);
  } catch (error) {
    if (!isWorkspaceTransactionDeadlock(error)) throw error;
    return { deferred: true, reason: "BOARD_PROJECTION_DEFERRED" };
  }
}

/**
 * A deferred projection did not move the card. updated, replayed, and unchanged
 * mean the column now matches the committed checker target.
 */
export function editorialBoardProjectionResult(value: unknown): {
  status: "updated" | "unchanged" | "replayed" | "deferred" | "rejected";
  applied: boolean;
} {
  if (!value || typeof value !== "object") return { status: "rejected", applied: false };
  const row = value as {
    deferred?: boolean;
    reason?: unknown;
    changed?: boolean;
    replayed?: boolean;
    columnId?: unknown;
  };
  if (row.deferred === true || row.reason === "BOARD_PROJECTION_DEFERRED") {
    return { status: "deferred", applied: false };
  }
  if (row.reason === "LATER_BOARD_OWNS_COLUMN") {
    return { status: "unchanged", applied: false };
  }
  if (row.changed === true && typeof row.columnId === "number") {
    return { status: "updated", applied: true };
  }
  if (row.replayed === true && typeof row.columnId === "number") {
    return { status: "replayed", applied: true };
  }
  if (row.changed === false && typeof row.columnId === "number") {
    return { status: "unchanged", applied: true };
  }
  return { status: "rejected", applied: false };
}
