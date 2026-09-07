const DEADLOCK_ERRNO = 1213;
const DEADLOCK_CODE = "ER_LOCK_DEADLOCK";
const MAX_CAUSE_DEPTH = 8;

export const WORKSPACE_TRANSACTION_MAX_ATTEMPTS = 2;

function isWorkspaceTransactionDeadlock(error: unknown): boolean {
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
