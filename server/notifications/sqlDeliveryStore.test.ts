import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { buildNotificationClaimQuery, createSqlNotificationDeliveryStore } from "./sqlDeliveryStore";
import type { ClaimedEvent } from "./deliveryPolicy";

const claimed: ClaimedEvent = {
  eventId: "17", eventKey: "notification:v1:order_completed:orders:3:approved",
  kind: "order_completed", leaseToken: "fenced-token", attempt: 1, audienceCursor: null,
};

function fakeDb(selectionRows: any[][] = [], writeCount = 1) {
  const queue = [...selectionRows];
  const inserts: Array<{ table: any; values: any }> = [];
  const updates: Array<{ table: any; values: any }> = [];
  const makeQuery = () => {
    const rows = queue.shift() ?? [];
    const chain: any = {
      from: () => chain, innerJoin: () => chain, where: () => chain,
      orderBy: () => chain, limit: () => chain, for: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  const db: any = {
    select: vi.fn(makeQuery),
    insert: vi.fn((table: any) => ({
      values: async (values: any) => { inserts.push({ table, values }); return [{ insertId: 1 }]; },
    })),
    update: vi.fn((table: any) => ({
      set: (values: any) => ({
        where: async () => {
          updates.push({ table, values });
          return [{ affectedRows: writeCount }];
        },
      }),
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
  };
  return { db, inserts, updates };
}
const reader = vi.fn(async () => ({ userIds: [2], nextCursor: null }));

describe("isolated fenced SQL notification delivery adapter", () => {
  it("renders the real MySQL8 SKIP LOCKED claim with a category gate", () => {
    // .toSQL() never opens a network connection.
    const db = drizzle("mysql://invalid:invalid@localhost:3306/not_connected", { mode: "default" });
    const rendered = buildNotificationClaimQuery(db, new Date("2026-10-25T00:00:00Z"), 5,
      ["order_completed"]).toSQL();
    expect(rendered.sql.toLowerCase()).toContain("for update skip locked");
    expect(rendered.sql).toContain("`notificationOutbox`");
    expect(rendered.sql).toContain("`notificationEvents`");
    expect(rendered.sql.toLowerCase()).toContain(" in (");
    expect(rendered.params).toContain("order_completed");
  });
  it("fails closed without a database and qualified audience reader", () => {
    expect(() => createSqlNotificationDeliveryStore(null, reader)).toThrow("dependencies");
    expect(() => createSqlNotificationDeliveryStore(fakeDb().db, null as any)).toThrow("dependencies");
  });

  it("claims no events when the DB queue is empty", async () => {
    const f = fakeDb([[]]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.claimReadyEvents(new Date(), 10)).toEqual([]);
    expect(f.updates).toHaveLength(0);
  });

  it("increments attempts and assigns a fresh fenced lease within a transaction", async () => {
    const f = fakeDb([[{
      id: BigInt("1"), eventId: BigInt("17"), eventKey: claimed.eventKey,
      kind: claimed.kind, attempt: 1, audienceCursor: "9",
    }]]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    const result = await store.claimReadyEvents(new Date("2026-10-25T01:00:00Z"), 1);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ eventId: "17", kind: claimed.kind, attempt: 2, audienceCursor: "9" });
    expect(result[0].leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.updates[0].values).toMatchObject({ state: "leased", attempt: 2, leaseToken: result[0].leaseToken });
  });

  it("never delegates audience reads after the lease is lost", async () => {
    const f = fakeDb([[]]);
    const fn = vi.fn(reader);
    const store = createSqlNotificationDeliveryStore(f.db, fn);
    await expect(store.readAudience(claimed, 100)).rejects.toThrow("lease lost");
    expect(fn).not.toHaveBeenCalled();
  });

  it("delegates only under a live lease and refuses invalid limits", async () => {
    const f = fakeDb([[{ id: BigInt("1") }]]);
    const fn = vi.fn(async () => ({ userIds: [3], nextCursor: null }));
    const store = createSqlNotificationDeliveryStore(f.db, fn);
    expect(await store.readAudience(claimed, 100)).toEqual({ userIds: [3], nextCursor: null });
    expect(fn).toHaveBeenCalledWith(claimed, 100);
    await expect(store.readAudience(claimed, 101)).rejects.toThrow("bound");
  });

  it("refuses delivery to the wrong targeted account before any insertion", async () => {
    const f = fakeDb([[{ id: BigInt("1") }], [{ next: BigInt("7") }], [{ kind: claimed.kind, targetUserId: 99 }]]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    await expect(store.insertRecipientIfAbsent(claimed, 2)).rejects.toThrow("identity mismatch");
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("preserves a dismissed tombstone on replay without consuming a sequence", async () => {
    const f = fakeDb([
      [{ id: BigInt("1") }], [{ next: BigInt("7") }], [{ kind: claimed.kind, targetUserId: 2 }],
      [{ dismissedAt: new Date() }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("dismissed");
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("inserts a new recipient with the shared global sequence under the lease", async () => {
    const f = fakeDb([
      [{ id: BigInt("1") }], [{ next: BigInt("7") }],
      [{ kind: claimed.kind, targetUserId: 2, occurredAt: new Date("2026-10-25T00:00:00Z") }], [],
      [{ id: 2, role: "user" }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("created");
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0].values).toMatchObject({
      eventId: BigInt("17"), userId: 2, receivedSequence: BigInt("7"), category: "finance",
    });
    expect(f.updates[0].values).toEqual({ nextSequence: BigInt("8") });
  });

  it("R40R56: a deleted account is never inserted - CURRENT users re-check inside the transaction", async () => {
    const f = fakeDb([
      [{ id: BigInt("1") }], [{ next: BigInt("7") }],
      [{ kind: claimed.kind, targetUserId: 2, occurredAt: new Date("2026-10-25T00:00:00Z") }], [],
      [],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("R40R56: a role flip to author between paging and insertion blocks a fanout insert", async () => {
    const novel = { ...claimed, kind: "novel_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: novel.kind, targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "author" }], [{ enabled: true, updatedAt: new Date("2026-10-24T00:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(novel, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("rechecks a committed opt-out under the sequence lock before insert", async () => {
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: claimed.kind, targetUserId: 2, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }], [{ enabled: false, updatedAt: new Date("2026-10-25T01:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("rejects re-opt-in after the event on a delayed retry", async () => {
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: claimed.kind, targetUserId: 2, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }], [{ enabled: true, updatedAt: new Date("2026-10-25T01:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("allows explicit opt-in committed before the event", async () => {
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: claimed.kind, targetUserId: 2, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }], [{ enabled: true, updatedAt: new Date("2026-10-24T23:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    expect(await store.insertRecipientIfAbsent(claimed, 2)).toBe("created");
    expect(f.inserts).toHaveLength(1);
  });

  it("honors default-off new-story notifications at insertion", async () => {
    const novel = { ...claimed, kind: "novel_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: novel.kind, sourceId: "5", targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 99, status: "published" }], [],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(novel, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("R40R56R1: a novel archived between paging and insertion blocks the fanout insert", async () => {
    const novelEvent = { ...claimed, kind: "novel_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: novelEvent.kind, sourceId: "5", targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 99, status: "archived" }], [],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(novelEvent, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("R40R56R1: the novel's own author never receives its fanout regardless of role", async () => {
    const novelEvent = { ...claimed, kind: "novel_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: novelEvent.kind, sourceId: "5", targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 2, status: "published" }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(novelEvent, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("R40R56R1: a wishlist digest without current membership is not delivered", async () => {
    const digest = { ...claimed, kind: "wishlist_episodes_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: digest.kind, sourceId: "5_ep7_0", targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 99, status: "published" }], [],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(digest, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("R40R56R1: a wishlist follow committed at/after the event is never backfilled", async () => {
    const digest = { ...claimed, kind: "wishlist_episodes_published" as const };
    const eventAt = new Date("2026-10-25T00:00:00Z");
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: digest.kind, sourceId: "5_ep7_0", targetUserId: null, occurredAt: eventAt }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 99, status: "published" }],
      [{ createdAt: new Date("2026-10-25T00:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(digest, 2)).toBe("ineligible");
    expect(f.inserts).toHaveLength(0);
  });

  it("R40R56R1: a pre-event wishlist member receives a digest insert", async () => {
    const digest = { ...claimed, kind: "wishlist_episodes_published" as const };
    const f = fakeDb([
      [{ id: 1n }], [{ next: 7n }],
      [{ kind: digest.kind, sourceId: "5_ep7_0", targetUserId: null, occurredAt: new Date("2026-10-25T00:00:00Z") }],
      [], [{ id: 2, role: "user" }],
      [{ authorUserId: 99, status: "published" }],
      [{ createdAt: new Date("2026-10-24T00:00:00Z") }],
      [{ enabled: true, updatedAt: new Date("2026-10-24T00:00:00Z") }],
    ]);
    const store = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: false,
    });
    expect(await store.insertRecipientIfAbsent(digest, 2)).toBe("created");
    expect(f.inserts).toHaveLength(1);
  });

  it("refuses unsafe sequence numbers before recipient insertion", async () => {
    const f = fakeDb([[{ id: BigInt("1") }], [{ next: Number.MAX_SAFE_INTEGER + 1 }]]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    await expect(store.insertRecipientIfAbsent(claimed, 2)).rejects.toThrow("Unsafe notification sequence");
    expect(f.inserts).toHaveLength(0);
  });

  it("fails closed for catalog and check-in categories unless separately enabled", async () => {
    const f = fakeDb([[{ id: BigInt("1") }]]);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    const catalog = { ...claimed, kind: "wishlist_episodes_published" as const };
    const checkin = { ...claimed, kind: "daily_checkin_reminder" as const };
    await expect(store.readAudience(catalog, 100)).rejects.toThrow("disabled");
    await expect(store.insertRecipientIfAbsent(checkin, 2)).rejects.toThrow("disabled");
    expect(f.db.select).not.toHaveBeenCalled();
    const enabledStore = createSqlNotificationDeliveryStore(f.db, reader, {
      catalogFanoutEnabled: true, checkinRemindersEnabled: true,
    });
    expect(await enabledStore.readAudience(catalog, 100)).toEqual({ userIds: [2], nextCursor: null });
  });

  it("rejects non-progressing cursor and refuses a stale write fence", async () => {
    const f = fakeDb([], 0);
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    await expect(store.checkpointAudience({ ...claimed, audienceCursor: "10" }, "9"))
      .rejects.toThrow("cursor");
    await expect(store.completeEvent(claimed)).rejects.toThrow("lease lost");
    expect(f.updates).toHaveLength(1);
  });

  it("rejects unapproved failure codes and invalid event IDs", async () => {
    const f = fakeDb();
    const store = createSqlNotificationDeliveryStore(f.db, reader);
    await expect(store.scheduleRetry(claimed, new Date(), "private SQL error"))
      .rejects.toThrow("retry");
    await expect(store.deadLetter({ ...claimed, eventId: "1 OR 1=1" }, "DELIVERY_ERROR"))
      .rejects.toThrow("event ID");
    expect(f.updates).toHaveLength(0);
  });
});
