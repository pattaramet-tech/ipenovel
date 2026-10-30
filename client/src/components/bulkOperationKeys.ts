/**
 * R40R59 — per-action bulk operation key management for the notification
 * UI.
 *
 * Server contract (server/notifications/bulkOperations.ts): the idempotency
 * identity is (actorUserId, operationKey) and the operation's action kind is
 * IMMUTABLE — reusing a mark_all_read key for delete_all throws "kind
 * mismatch", and a replay of a committed operation never re-applies.
 *
 * Therefore the client must:
 *   - keep ONE key per logical action kind (markAllRead / deleteAll never
 *     share),
 *   - reuse the SAME key while an outcome is uncertain (safe retry of the
 *     same logical action),
 *   - mint a FRESH key once the server confirmed that action kind (the next
 *     logical action targets a new cutoff),
 *   - drop every key when the signed-in identity changes (keys are
 *     actor-scoped server-side; account A's key must never be used by
 *     account B),
 *   - never treat a failed mutation as success (the key survives so the
 *     user's retry replays the same server-side operation).
 */

export type BulkActionKind = "mark_all_read" | "delete_all";

export interface BulkOperationKeyManager {
  /** Existing key for the kind (retry of an uncertain action), or a new one. */
  begin(kind: BulkActionKind): string;
  /** Server confirmed success - the next action of this kind gets a new key. */
  confirmSuccess(kind: BulkActionKind): void;
  /** Identity changed (login/logout/account switch) - drop every key. */
  reset(): void;
  /** Read-only view for tests/diagnostics. */
  snapshot(): Partial<Record<BulkActionKind, string>>;
}

export function createBulkOperationKeyManager(
  mintKey: (kind: BulkActionKind) => string,
): BulkOperationKeyManager {
  const keys: Partial<Record<BulkActionKind, string>> = {};
  return {
    begin(kind) {
      const existing = keys[kind];
      if (existing) return existing;
      const minted = mintKey(kind);
      keys[kind] = minted;
      return minted;
    },
    confirmSuccess(kind) {
      delete keys[kind];
    },
    reset() {
      delete keys.mark_all_read;
      delete keys.delete_all;
    },
    snapshot() {
      return { ...keys };
    },
  };
}

/** Deterministic-per-call key generator matching the server's
 *  ^[A-Za-z0-9_-]{8,96}$ contract, tagged with the action kind so logs and
 *  server rows are self-describing. */
export function makeBulkOperationKey(kind: BulkActionKind, userId: number | undefined): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${kind === "mark_all_read" ? "mar" : "del"}-u${userId ?? 0}-${Date.now().toString(36)}-${random}`;
}
