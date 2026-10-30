/**
 * R40R59 — bulk operation key manager unit tests.
 *
 * Pins the client-side half of the server's (actorUserId, operationKey)
 * kind-immutable idempotency contract:
 *   - markAllRead and deleteAll NEVER share a key (server throws "kind
 *     mismatch" on a cross-kind replay),
 *   - an uncertain outcome keeps its key (safe replay),
 *   - a confirmed success frees the kind for a fresh key (new cutoff),
 *   - identity change drops every key.
 */
import { describe, expect, it } from "vitest";
import {
  createBulkOperationKeyManager,
  makeBulkOperationKey,
} from "./bulkOperationKeys";

describe("R40R59 per-action bulk operation keys", () => {
  it("different action kinds never share a key", () => {
    const manager = createBulkOperationKeyManager(kind => `key-${kind}-1`);
    const markAll = manager.begin("mark_all_read");
    const deleteAll = manager.begin("delete_all");
    expect(markAll).toBe("key-mark_all_read-1");
    expect(deleteAll).toBe("key-delete_all-1");
    expect(markAll).not.toBe(deleteAll);
  });

  it("same-kind retry of an uncertain action reuses the SAME key", () => {
    let serial = 0;
    const manager = createBulkOperationKeyManager(kind => `key-${kind}-${serial++}`);
    const first = manager.begin("mark_all_read");
    const retry = manager.begin("mark_all_read");
    expect(retry).toBe(first);
  });

  it("a confirmed success frees the kind: the next logical action gets a NEW key", () => {
    let serial = 0;
    const manager = createBulkOperationKeyManager(kind => `key-${kind}-${serial++}`);
    const first = manager.begin("mark_all_read");
    manager.confirmSuccess("mark_all_read");
    const second = manager.begin("mark_all_read");
    expect(second).not.toBe(first);
    expect(second.startsWith("key-mark_all_read-")).toBe(true);
    // the other kind is unaffected by a foreign kind's confirmation
    const deleteAll = manager.begin("delete_all");
    expect(deleteAll.startsWith("key-delete_all-")).toBe(true);
    expect(deleteAll).not.toContain(String(first));
  });

  it("a FAILED mutation keeps its key so the user's retry replays the same operation", () => {
    let serial = 0;
    const manager = createBulkOperationKeyManager(kind => `key-${kind}-${serial++}`);
    const failed = manager.begin("delete_all");
    // no confirmSuccess call - the outcome is unknown
    const retryAfterFailure = manager.begin("delete_all");
    expect(retryAfterFailure).toBe(failed);
  });

  it("reset (identity change) drops every key so no account reuses another's key", () => {
    let serial = 0;
    const manager = createBulkOperationKeyManager(kind => `key-${kind}-${serial++}`);
    manager.begin("mark_all_read");
    manager.begin("delete_all");
    manager.reset();
    expect(manager.snapshot()).toEqual({});
    const nextMarkAll = manager.begin("mark_all_read");
    expect(nextMarkAll).toMatch(/^key-mark_all_read-\d+$/);
    expect(nextMarkAll).not.toBe("key-mark_all_read-0");
  });

  it("minted keys satisfy the server's operationKey format contract", () => {
    for (const kind of ["mark_all_read", "delete_all"] as const) {
      const key = makeBulkOperationKey(kind, 42);
      expect(key).toMatch(/^[A-Za-z0-9_-]{8,96}$/);
      expect(key.startsWith(kind === "mark_all_read" ? "mar-u42-" : "del-u42-")).toBe(true);
    }
  });
});
