import { describe, expect, it } from "vitest";
import { createInboxDataStore } from "./inboxDataStore";
import { executeInboxBulkOperation, type PersistedBulkOperation } from "./bulkOperations";
import { notificationBulkOperations, notificationRecipients, notificationSequence } from "./tables";

const now = new Date("2026-10-24T01:00:00.000Z");
const key = "sql_bulk_key_2026";

function sqlHarness(options: { missingSequence?: boolean; affected?: unknown } = {}) {
  const trace: string[] = [];
  let operation: PersistedBulkOperation | null = null;
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => ({
            for: async (lock: string) => {
              expect(lock).toBe("update");
              if (table === notificationSequence) {
                trace.push("sequence-lock");
                return options.missingSequence ? [] : [{ next: 11n }];
              }
              if (table === notificationBulkOperations) {
                trace.push("operation-lock");
                return operation ? [operation] : [];
              }
              throw Error("Unexpected locked table");
            },
          }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: any) => {
        if (table !== notificationBulkOperations) throw Error("Unexpected insert");
        trace.push("insert-operation");
        operation = { ...value, affected: null };
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (value: any) => ({
        where: async () => {
          if (table === notificationRecipients) {
            trace.push("update-recipients");
            return [{ affectedRows: options.affected ?? 2 }];
          }
          if (table === notificationBulkOperations) {
            trace.push("complete-operation");
            operation = { ...operation!, ...value };
            return [{ affectedRows: 1 }];
          }
          throw Error("Unexpected update");
        },
      }),
    }),
  };
  return {
    tx,
    trace,
    getOperation: () => operation,
  };
}

describe("notification SQL bulk adapter (mocked SQL; not a DB integration)", () => {
  it("locks sequence before operation lookup and freezes the server-side cutoff", async () => {
    const h = sqlHarness();
    const store = createInboxDataStore({ transaction: async (fn: any) => fn(h.tx) });
    const first = await executeInboxBulkOperation(store.bulk, 7, key, "mark_all_read", now);
    expect(first).toMatchObject({ affected: 2, replay: false, cutoffSequence: 10n });
    expect(h.trace).toEqual([
      "sequence-lock", "operation-lock", "insert-operation",
      "update-recipients", "complete-operation",
    ]);
    expect(h.getOperation()).toMatchObject({ state: "completed", cutoffSequence: 10n, affected: 2 });
    const second = await executeInboxBulkOperation(store.bulk, 7, key, "mark_all_read", now);
    expect(second).toMatchObject({ affected: 2, replay: true, cutoffSequence: 10n });
    expect(h.trace.filter(x => x === "update-recipients")).toHaveLength(1);
  });

  it("fails closed when the sequence seed is absent; never creates an operation", async () => {
    const h = sqlHarness({ missingSequence: true });
    const store = createInboxDataStore({ transaction: async (fn: any) => fn(h.tx) });
    await expect(executeInboxBulkOperation(store.bulk, 7, key, "delete_all", now))
      .rejects.toThrow("sequence not initialized");
    expect(h.trace).toEqual(["sequence-lock"]);
    expect(h.getOperation()).toBeNull();
  });

  it("refuses a malformed SQL update count instead of claiming bulk success", async () => {
    // An invalid driver outcome must abort the surrounding real SQL transaction.
    const broken = sqlHarness({ affected: "2" });
    const brokenStore = createInboxDataStore({ transaction: async (fn: any) => fn(broken.tx) });
    await expect(executeInboxBulkOperation(brokenStore.bulk, 7, key, "delete_all", now))
      .rejects.toThrow("Invalid notification write outcome");
    expect(broken.trace).not.toContain("complete-operation");
  });

  it("serializes preference changes behind the shared delivery sequence lock", async () => {
    const trace:string[]=[];
    const tx:any={
      select:()=>({from:(table:unknown)=>({where:()=>({limit:()=>({
        for:async()=>{expect(table).toBe(notificationSequence);trace.push("sequence-lock");return [{next:11n}];},
      })})})}),
      insert:()=>({values:()=>({onDuplicateKeyUpdate:async()=>{trace.push("write-pref");}})}),
    };
    const store=createInboxDataStore({transaction:async(fn:any)=>fn(tx)});
    await store.setOwnPreference(7,"order_completed",false);
    expect(trace).toEqual(["sequence-lock","write-pref"]);
  });

  it("fails closed without the sequence seed before changing consent", async () => {
    let writes=0;
    const tx:any={
      select:()=>({from:()=>({where:()=>({limit:()=>({for:async()=>[]})})})}),
      insert:()=>{writes++;throw Error("unexpected preference write");},
    };
    const store=createInboxDataStore({transaction:async(fn:any)=>fn(tx)});
    await expect(store.setOwnPreference(7,"order_completed",false))
      .rejects.toThrow("sequence not initialized");
    expect(writes).toBe(0);
  });

  it("refuses missing DB transaction and invalid actor before SQL mutation", async () => {
    expect(() => createInboxDataStore(null)).toThrow("DB unavailable");
    const h = sqlHarness();
    const store = createInboxDataStore({ transaction: async (fn: any) => fn(h.tx) });
    await expect(executeInboxBulkOperation(store.bulk, 0, key, "delete_all", now)).rejects.toThrow();
    expect(h.trace).toEqual([]);
  });
});
