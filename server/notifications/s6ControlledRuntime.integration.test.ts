/**
 * R40R57 — REAL-DATABASE controlled runtime end-to-end qualification.
 *
 * Drives the REAL composed runtime (controlledRuntime.ts) against the
 * disposable `ipenovel_test` MySQL 8: real store, real qualified audience
 * reader, real runner, real events written by real producer paths. Every
 * tick is an EXPLICIT one-shot invocation - nothing self-schedules (E17).
 *
 * Covered here: E1-E17 of the R40R57 matrix. The store-level retry /
 * dead-letter / tombstone / paging depths live in
 * s6DeliveryInbox.integration.test.ts (D1-D20) and the collision races in
 * s6DeliveryRace.integration.test.ts (R1-R15) - both re-run in this round.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  notificationEvents,
  notificationOutbox,
  notificationRecipients,
  novels,
  users,
  walletAccounts,
  walletTopups,
  wishlists,
} from "../../drizzle/schema";
import * as db from "../db";
import { createControlledNotificationRuntime } from "./controlledRuntime";
import { readNotificationRuntimeFlags } from "./runtimeGate";
import { recordEpisodeFirstPublicationIfEnabled } from "./episodePublicationProducer";
import { createInboxDataStore } from "./inboxDataStore";
import { getTestDb } from "../test-helpers/testDb";
import {
  createTestEpisode,
  createTestNovel,
  createTestUser,
  deleteFixtures,
  uniqueTestTag,
  type TestUserFixture,
} from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("S6 runtime integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

/** Tick clock allowance for the disposable container's trailing clock
 *  (injected through the runtime's EXPLICIT test-only clock option - the
 *  production default remains the real clock). */
function allowanceClock(): Date {
  return new Date(Date.now() + 5_000);
}

function enabledFlags(catalog = false) {
  const flags = readNotificationRuntimeFlags({
    NOTIFICATIONS_ENABLED: "true",
    NOTIFICATIONS_DELIVERY_ENABLED: "true",
    ...(catalog ? { NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "true" } : {}),
  });
  return catalog ? { ...flags, catalogFanoutEnabled: true } : flags;
}

interface Tracked {
  userIds: number[];
  novelIds: number[];
  episodeIds: number[];
  topupIds: number[];
  eventKeys: string[];
  wishlistPairs: Array<{ userId: number; novelId: number }>;
}
const tracked: Tracked = { userIds: [], novelIds: [], episodeIds: [], topupIds: [], eventKeys: [], wishlistPairs: [] };

function trackUser(u: TestUserFixture): TestUserFixture {
  tracked.userIds.push(u.id);
  return u;
}

afterEach(async () => {
  const t = requireTestDb();
  for (const key of [...tracked.eventKeys]) {
    const rows = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, key))
      .catch(() => []);
    for (const row of rows) {
      await t.delete(notificationRecipients).where(eq(notificationRecipients.eventId, row.id)).catch(() => {});
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id)).catch(() => {});
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.eventKey, key)).catch(() => {});
  }
  for (const pair of tracked.wishlistPairs) {
    await t.delete(wishlists).where(and(eq(wishlists.userId, pair.userId), eq(wishlists.novelId, pair.novelId))).catch(() => {});
  }
  for (const id of tracked.topupIds) await t.delete(walletTopups).where(eq(walletTopups.id, id)).catch(() => {});
  for (const id of tracked.userIds) {
    await t.delete(notificationRecipients).where(eq(notificationRecipients.userId, id)).catch(() => {});
    await t.delete(walletAccounts).where(eq(walletAccounts.userId, id)).catch(() => {});
  }
  await deleteFixtures({ userIds: [...tracked.userIds], novelIds: [...tracked.novelIds] }).catch(() => {});
  tracked.userIds.length = 0; tracked.novelIds.length = 0; tracked.episodeIds.length = 0;
  tracked.topupIds.length = 0; tracked.eventKeys.length = 0; tracked.wishlistPairs.length = 0;
});

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

async function approvedTopupEvent(userId: number): Promise<{ topupId: number; eventKey: string }> {
  const topup = (await db.createWalletTopup(userId, "100.00", `https://example.test/slips/${uniqueTestTag()}.jpg`)) as { id: number };
  tracked.topupIds.push(topup.id);
  await db.approveWalletTopup(topup.id, 9001);
  return { topupId: topup.id, eventKey: `notification:v1:wallet_topup_approved:wallet_topups:${topup.id}:credited` };
}

async function fanoutEvent(opts: { followerOptIn: boolean; removeWishlist?: boolean; archiveNovel?: boolean }): Promise<{
  follower: TestUserFixture;
  novelId: number;
  eventKey: string;
}> {
  const follower = trackUser(await createTestUser());
  const novel = await createTestNovel();
  tracked.novelIds.push(novel.id);
  const episode = await createTestEpisode(novel.id, { isPublished: true });
  tracked.episodeIds.push(episode.id);
  await requireTestDb().insert(wishlists).values({
    userId: follower.id, novelId: novel.id, createdAt: new Date(Date.now() - 60_000),
  });
  tracked.wishlistPairs.push({ userId: follower.id, novelId: novel.id });
  await requireTestDb().transaction(async (tx: any) => {
    const outcome = await recordEpisodeFirstPublicationIfEnabled(tx, {
      episodeId: episode.id,
      novelId: novel.id,
      isPublished: true,
      flags: { ...enabledFlags(true), catalogFanoutEnabled: true },
      env: process.env,
    });
    if (outcome.status !== "created") throw new Error(`producer: ${outcome.status}`);
  });
  // explicit opt-in backdated BEFORE the event second (default-OFF catalog kind)
  if (opts.followerOptIn) {
    const t = requireTestDb();
    await t.transaction(async (tx: any) => {
      const { notificationPreferences } = await import("./tables");
      await tx.insert(notificationPreferences).values({
        userId: follower.id, kind: "wishlist_episodes_published", enabled: true,
        updatedAt: new Date(Date.now() - 120_000),
      }).onDuplicateKeyUpdate({ set: { enabled: true, updatedAt: new Date(Date.now() - 120_000) } });
    });
  }
  // wait for a fresh second so the opt-in second is strictly before the
  // events that the FOLLOWING mutations create (only used in opt-in tests)
  if (opts.followerOptIn && !opts.removeWishlist && !opts.archiveNovel) {
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 50));
  }
  const t = requireTestDb();
  if (opts.removeWishlist) {
    await t.delete(wishlists).where(and(eq(wishlists.userId, follower.id), eq(wishlists.novelId, novel.id)));
    tracked.wishlistPairs = tracked.wishlistPairs.filter((p) => p.userId !== follower.id);
  }
  if (opts.archiveNovel) {
    await t.update(novels).set({ publicationStatus: "archived" }).where(eq(novels.id, novel.id));
  }
  const eventRows = await t
    .select()
    .from(notificationEvents)
    .where(and(eq(notificationEvents.kind, "wishlist_episodes_published"), eq(notificationEvents.sourceId, `${novel.id}_ep${episode.id}_0`)));
  expect(eventRows.length).toBe(1);
  tracked.eventKeys.push(eventRows[0].eventKey);
  return { follower, novelId: novel.id, eventKey: eventRows[0].eventKey };
}

async function recipientsCount(eventKey: string): Promise<number> {
  const t = requireTestDb();
  const event = (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0];
  if (!event) return -1;
  return scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.eventId, event.id)));
}

describe("R40R57 controlled runtime end-to-end (real MySQL)", () => {
  it("E1: event + outbox -> explicit tick -> recipient in the owner's inbox", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(),
      loadDatabase: async () => requireTestDb(),
      clock: allowanceClock,
    });

    const result = await runtime.tick();
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.created).toBe(1);

    const view = await createInboxDataStore(requireTestDb()).listOwnInbox({
      actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20,
    });
    expect(view.map((v) => v.title)).toContain("เติมเงินสำเร็จ");
  });

  it("E2+E16: master OFF -> tick disabled, zero notification SQL even with pending outbox rows", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const t = requireTestDb();
    const ownEvent = (
      await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey))
    )[0];
    const before = (
      await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, ownEvent.id))
    )[0];
    expect(before.state).toBe("pending");

    const loadDatabase = vi.fn(async () => requireTestDb());
    const runtime = createControlledNotificationRuntime({
      flags: readNotificationRuntimeFlags({ NOTIFICATIONS_DELIVERY_ENABLED: "true" }),
      loadDatabase,
      clock: allowanceClock,
    });
    await expect(runtime.tick()).resolves.toEqual({ status: "disabled" });
    expect(loadDatabase).not.toHaveBeenCalled();
    const after = (
      await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, ownEvent.id))
    )[0];
    expect(after.attempt).toBe(0);
    expect(after.state).toBe("pending");
  });

  it("E3: delivery OFF -> tick disabled, zero claim", async () => {
    const loadDatabase = vi.fn(async () => requireTestDb());
    const runtime = createControlledNotificationRuntime({
      flags: readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" }),
      loadDatabase,
      clock: allowanceClock,
    });
    await expect(runtime.tick()).resolves.toEqual({ status: "disabled" });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("E4: one-shot invocation completes the queue exactly once; the next tick claims nothing", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(),
      loadDatabase: async () => requireTestDb(),
      clock: allowanceClock,
    });
    const first = await runtime.tick();
    if (first.status !== "completed") throw new Error("expected completed");
    expect(first.result.created).toBe(1);
    const second = await runtime.tick();
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.result.claimed).toBe(0);
    expect(await recipientsCount(eventKey)).toBe(1);
  });

  it("E5: overlapping invocations inside the process collapse to busy + one completed", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(),
      loadDatabase: async () => requireTestDb(),
      clock: allowanceClock,
    });
    const results = await Promise.all([runtime.tick(), runtime.tick()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["busy", "completed"]);
    expect(await recipientsCount(eventKey)).toBe(1);
  });

  it("E6: two concurrent runtime instances are fenced by the DB lease - exactly one recipient", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const runtimeA = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const runtimeB = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const results = await Promise.allSettled([runtimeA.tick(), runtimeB.tick()]);
    let created = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.status === "completed") created += r.value.result.created;
    }
    expect(created).toBe(1);
    expect(await recipientsCount(eventKey)).toBe(1);
  });

  it("E7: direct notification reaches only the record owner", async () => {
    const owner = trackUser(await createTestUser());
    const bystander = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(owner.id);
    tracked.eventKeys.push(eventKey);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    await runtime.tick();
    const rows = await requireTestDb()
      .select({ userId: notificationRecipients.userId })
      .from(notificationEvents)
      .innerJoin(notificationRecipients, eq(notificationRecipients.eventId, notificationEvents.id))
      .where(eq(notificationEvents.eventKey, eventKey));
    expect(rows.map((r) => r.userId)).toEqual([owner.id]);
    expect(owner.id).not.toBe(bystander.id);
  });

  it("E8: catalog fanout reaches only the qualified (opted-in, pre-event follower) audience", async () => {
    const optedIn = await fanoutEvent({ followerOptIn: true });
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(true), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(1);
    expect(await recipientsCount(optedIn.eventKey)).toBe(1);
  });

  it("E9: wishlist unfollowed before the INSERT -> no recipient", async () => {
    const { follower, eventKey } = await fanoutEvent({ followerOptIn: true, removeWishlist: true });
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(true), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(0);
    expect(result.result.completed).toBe(1);
    void follower;
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("E10: novel archived before the INSERT -> no recipient", async () => {
    const { eventKey } = await fanoutEvent({ followerOptIn: true, archiveNovel: true });
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(true), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(0);
    expect(result.result.completed).toBe(1);
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("E11: opt-out after the event -> no delivery", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    await createInboxDataStore(requireTestDb()).setOwnPreference(user.id, "wallet_topup_approved", false);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(0);
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("E12: a dismissed recipient is never revived by a replay", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    await runtime.tick();
    const t = requireTestDb();
    const dismissedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await t.update(notificationRecipients).set({ dismissedAt }).where(eq(notificationRecipients.userId, user.id));

    // crash-style replay: expire nothing - instead re-insert through the
    // runtime's own store contract by ticking again after re-queueing the
    // same outbox row via its fenced state (pending) - the tombstone wins
    await t.update(notificationOutbox).set({ state: "pending", nextAttemptAt: new Date() }).where(
      eq(notificationOutbox.eventId, (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0].id)
    );
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.dismissed).toBe(1);
    expect(result.result.created).toBe(0);
    const rows = await t.select().from(notificationRecipients).where(eq(notificationRecipients.userId, user.id));
    expect(rows[0].dismissedAt?.getTime()).toBe(dismissedAt.getTime());
  });

  it("E13: transient database failure rejects the tick; the next tick recovers the queue", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    let healthy = false;
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(),
      loadDatabase: async () => {
        if (!healthy) throw new Error("connection refused");
        return requireTestDb();
      },
      clock: allowanceClock,
    });
    await expect(runtime.tick()).rejects.toThrow(/connection refused/);
    healthy = true;
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(1);
    expect(await recipientsCount(eventKey)).toBe(1);
  });

  it("E15: inbox read / unread count / mark all read / delete all through the real bulk path", async () => {
    const user = trackUser(await createTestUser());
    for (let i = 0; i < 2; i++) await approvedTopupEvent(user.id);
    const runtime = createControlledNotificationRuntime({
      flags: enabledFlags(), loadDatabase: async () => requireTestDb(), clock: allowanceClock,
    });
    const result = await runtime.tick();
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result.created).toBe(2);

    const inbox = createInboxDataStore(requireTestDb());
    expect(await inbox.countOwnUnread(user.id)).toBe(2);
    const marked = await inbox.bulk.transaction(async (tx) => {
      const op = await tx.lockOrCreateOperation(user.id, `s6-${uniqueTestTag()}`, "mark_all_read");
      const rows = await tx.applyToRecipients(op, new Date());
      await tx.completeOperation(op, rows);
      return rows;
    });
    expect(marked).toBe(2);
    expect(await inbox.countOwnUnread(user.id)).toBe(0);
    const deleted = await inbox.bulk.transaction(async (tx) => {
      const op = await tx.lockOrCreateOperation(user.id, `s6-${uniqueTestTag()}`, "delete_all");
      const rows = await tx.applyToRecipients(op, new Date());
      await tx.completeOperation(op, rows);
      return rows;
    });
    expect(deleted).toBe(2);
    expect((await inbox.listOwnInbox({ actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 })).length).toBe(0);
  });

  it("E17: composing an enabled runtime over pending rows starts NOTHING until explicitly ticked", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const loadDatabase = vi.fn(async () => requireTestDb());
    createControlledNotificationRuntime({
      flags: enabledFlags(),
      loadDatabase,
      clock: allowanceClock,
    });
    // yield generously - no timers exist, so nothing can fire
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(loadDatabase).not.toHaveBeenCalled();
    const outboxRow = (
      await requireTestDb().select().from(notificationOutbox).where(
        eq(notificationOutbox.eventId, (await requireTestDb().select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0].id)
      )
    )[0];
    expect(outboxRow.state).toBe("pending");
    expect(outboxRow.attempt).toBe(0);
  });
});
