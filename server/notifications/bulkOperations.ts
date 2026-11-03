import type { BulkActionKind } from "./contract";

/**
 * All DB adapters MUST scope this operation by ctx.user.id; caller-supplied
 * actor IDs are forbidden at the public API boundary.
 *
 * Durable unique constraint: (actorUserId, operationKey).
 * The original kind is immutable, including across retries.
 * The server assigns cutoffSequence under the same inbox sequencing lock
 * used by recipient inserts. This prevents a delayed older insert from
 * appearing within the newly chosen snapshot.
 */
export interface PersistedBulkOperation {
  actorUserId: number;
  operationKey: string;
  kind: BulkActionKind;
  cutoffSequence: bigint;
  state: "pending" | "completed";
  affected: number | null;
}

export interface InboxBulkTransaction {
  /** Serialized get-or-create, with actor/key uniqueness enforced by DB. */
  lockOrCreateOperation(
    actorUserId: number,
    operationKey: string,
    kind: BulkActionKind,
  ): Promise<PersistedBulkOperation>;
  /**
   * Single bulk SQL UPDATE, scoped by owner + cutoff; never page through a
   * client-supplied list of IDs. For delete_all only set dismissedAt.
   */
  applyToRecipients(operation: PersistedBulkOperation, now: Date): Promise<number>;
  /** Save terminal outcome atomically with the scoped recipient update. */
  completeOperation(operation: PersistedBulkOperation, affected: number): Promise<void>;
}

export interface InboxBulkStore {
  /** Transact must roll back operation + recipient changes together. */
  transaction<T>(fn: (tx: InboxBulkTransaction) => Promise<T>): Promise<T>;
}

export interface BulkOperationResult {
  operationKey: string;
  kind: BulkActionKind;
  cutoffSequence: bigint;
  affected: number;
  replay: boolean;
}

function validateInput(actorUserId: number, operationKey: string, kind: BulkActionKind, now: Date): void {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) throw new Error("Invalid notification actor");
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(operationKey)) throw new Error("Invalid notification operation key");
  if (kind !== "mark_all_read" && kind !== "delete_all") throw new Error("Invalid notification operation kind");
  if (Number.isNaN(now.getTime())) throw new Error("Invalid notification operation time");
}

/**
 * The caller must create or reuse the SAME operation key after transient
 * failures; never mint a new key when retrying an uncertain outcome.
 *
 * If a previous attempt committed, do not run applyToRecipients again: this
 * is essential to protect arrivals after the first snapshot.
 */
export async function executeInboxBulkOperation(
  store: InboxBulkStore,
  actorUserId: number,
  operationKey: string,
  kind: BulkActionKind,
  now: Date,
): Promise<BulkOperationResult> {
  validateInput(actorUserId, operationKey, kind, now);
  return store.transaction(async tx => {
    const operation = await tx.lockOrCreateOperation(actorUserId, operationKey, kind);
    if (operation.actorUserId !== actorUserId || operation.operationKey !== operationKey ||
        operation.kind !== kind || operation.cutoffSequence < BigInt(0)) {
      throw new Error("Notification bulk operation ownership or kind mismatch");
    }
    if (operation.state === "completed") {
      if (!Number.isSafeInteger(operation.affected) || operation.affected! < 0) {
        throw new Error("Invalid completed notification operation");
      }
      return {
        operationKey, kind, cutoffSequence: operation.cutoffSequence,
        affected: operation.affected!, replay: true,
      };
    }
    if (operation.state !== "pending") throw new Error("Invalid notification operation state");
    const affected = await tx.applyToRecipients(operation, now);
    if (!Number.isSafeInteger(affected) || affected < 0) throw new Error("Invalid operation row count");
    await tx.completeOperation(operation, affected);
    return { operationKey, kind, cutoffSequence: operation.cutoffSequence, affected, replay: false };
  });
}

/** Externally distinguish declined retries from committed outcomes. */
export function isCommittedBulkResult(result: BulkOperationResult | null): result is BulkOperationResult {
  return result !== null;
}
