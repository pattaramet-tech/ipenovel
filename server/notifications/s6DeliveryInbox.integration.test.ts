/**
 * R40R56 — REAL-DATABASE delivery & inbox qualification (outbox → inbox).
 *
 * Runs the REAL delivery stack against the disposable `ipenovel_test`
 * MySQL 8 database: the real fenced SQL delivery store, the real qualified
 * audience reader, the real inbox data store, driven by EXPLICIT ONE-SHOT
 * `runInAppDeliveryTick()` calls in the test process. NO worker, cron or
 * scheduler is mounted anywhere - the runner gate
 * (createNotificationDeliveryRunner) is itself part of the matrix (D17/D18).
 *
 * Events are created by the REAL producer paths (wallet approval /
 * rejection, order approval, episode purchase, novel first-publication,
 * wishlist episode publication) exactly as the business transactions emit
 * them. Clock control is via the tick's explicit `now` argument - no sleeps.
 *
 * Mock proofs for this stack live in sqlDeliveryStore.test.ts /
 * sqlAudienceReader.test.ts / deliveryPolicy.test.ts; THIS file is the
 * SQL-level proof required before any runtime mount (which stays STOP).
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  episodePurchases,
  novels,
  notificationEvents,
  notificationOutbox,
  notificationRecipients,
  payments,
  topupLogs,
  users,
  walletAccounts,
  walletTransactions,
  walletTopups,
  wishlists,
} from "../../drizzle/schema";
import * as db from "../db";
import { approvePayment } from "../services/orderService";
import { purchaseEpisodeWithWallet } from "../services/episodePurchaseService";
import { createSqlNotificationDeliveryStore, type SqlDeliveryFeatureGates } from "./sqlDeliveryStore";
import { createQualifiedSqlAudienceReader } from "./sqlAudienceReader";
import { runInAppDeliveryTick, DEFAULT_DELIVERY_LIMITS, type DeliveryLimits } from "./deliveryPolicy";
import { createNotificationDeliveryRunner, readNotificationRuntimeFlags } from "./runtimeGate";
import { createInboxDataStore } from "./inboxDataStore";
import { recordNovelFirstPublicationIfEnabled } from "./novelPublicationProducer";
import { recordEpisodeFirstPublicationIfEnabled } from "./episodePublicationProducer";
import { getTestDb } from "../test-helpers/testDb";
import {
  createTestEpisode,
  createTestNovel,
  createTestOrder,
  createTestOrderItem,
  createTestPayment,
  createTestUser,
  deleteFixtures,
  uniqueTestTag,
  type TestUserFixture,
} from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("S6 delivery integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

const FLAGS = readNotificationRuntimeFlags(process.env);
/**
 * Catalog fanout is DEFAULT-OFF at the runtime-gate layer (exactly like a
 * deployment that has not enabled it); the fanout fixtures explicitly run
 * with the catalog gate ON while every store-level gate matrix case still
 * exercises its own explicit gates.
 */
const FANOUT_FLAGS = { ...FLAGS, catalogFanoutEnabled: true };
const TICK_LIMITS: DeliveryLimits = {
  ...DEFAULT_DELIVERY_LIMITS,
  maxRecipientsPerEvent: 2,
  maxAttempts: 2,
  baseRetryMs: 60_000,
};

/**
 * Tick clock with a 5-second allowance for the disposable container's clock:
 * Docker Desktop's MySQL clock can trail the Windows host by ~1-2s, and
 * MySQL TIMESTAMP columns truncate sub-second precision, so an event written
 * from the host clock can appear up to ~2s "in the future" to the server's
 * `nextAttemptAt <= now` claim comparison. Tick 5s ahead - a monotonic claim
 * condition makes this purely an environment-skew allowance, not a behavior
 * change (proven: D2 claimed=0 flaky vs created=1 with the same rows).
 */
function tickNowFn(): Date {
  return new Date(Date.now() + 5_000);
}

function makeStore(gates: Partial<SqlDeliveryFeatureGates> = {}) {
  return createSqlNotificationDeliveryStore(
    requireTestDb(),
    createQualifiedSqlAudienceReader(requireTestDb()),
    { catalogFanoutEnabled: false, checkinRemindersEnabled: false, ...gates },
  );
}

function inbox() {
  return createInboxDataStore(requireTestDb());
}

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

interface Tracked {
  userIds: number[];
  novelIds: number[];
  episodeIds: number[];
  topupIds: number[];
  orderIds: number[];
  orderItemIds: number[];
  paymentIds: number[];
  eventKeys: string[];
  wishlistPairs: Array<{ userId: number; novelId: number }>;
}
const tracked: Tracked = {
  userIds: [], novelIds: [], episodeIds: [], topupIds: [], orderIds: [],
  orderItemIds: [], paymentIds: [], eventKeys: [], wishlistPairs: [],
};

function trackUser(u: TestUserFixture): TestUserFixture {
  tracked.userIds.push(u.id);
  return u;
}

async function cleanup() {
  const t = requireTestDb();
  // Belt and braces: delete by tracked keys AND by tracked user, because a
  // mid-test assertion failure must never leak notification rows into the
  // next test's tick (leftover pending events change what a tick claims).
  const keyRows = tracked.eventKeys.length > 0
    ? await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(inArray(notificationEvents.eventKey, tracked.eventKeys))
        .catch(() => [])
    : [];
  const userRows = tracked.userIds.length > 0
    ? await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(inArray(notificationEvents.targetUserId, tracked.userIds))
        .catch(() => [])
    : [];
  for (const row of [...keyRows, ...userRows]) {
    await t.delete(notificationRecipients).where(eq(notificationRecipients.eventId, row.id)).catch(() => {});
    await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id)).catch(() => {});
  }
  if (keyRows.length > 0) {
    await t.delete(notificationEvents).where(inArray(notificationEvents.eventKey, tracked.eventKeys)).catch(() => {});
  }
  if (userRows.length > 0) {
    await t.delete(notificationEvents).where(inArray(notificationEvents.targetUserId, tracked.userIds)).catch(() => {});
  }
  for (const pair of tracked.wishlistPairs) {
    await t.delete(wishlists).where(and(eq(wishlists.userId, pair.userId), eq(wishlists.novelId, pair.novelId))).catch(() => {});
  }
  for (const id of tracked.userIds) {
    await t.delete(walletTransactions).where(eq(walletTransactions.userId, id)).catch(() => {});
    await t.delete(topupLogs).where(eq(topupLogs.userId, id)).catch(() => {});
    await t.delete(episodePurchases).where(eq(episodePurchases.userId, id)).catch(() => {});
  }
  for (const id of tracked.topupIds) await t.delete(walletTopups).where(eq(walletTopups.id, id)).catch(() => {});
  for (const id of tracked.userIds) {
    await t.delete(walletAccounts).where(eq(walletAccounts.userId, id)).catch(() => {});
    await t.delete(notificationRecipients).where(eq(notificationRecipients.userId, id)).catch(() => {});
  }
  for (const id of tracked.paymentIds) await t.delete(payments).where(eq(payments.id, id)).catch(() => {});
  await deleteFixtures({
    userIds: [...tracked.userIds],
    novelIds: [...tracked.novelIds],
    orderItemIds: [...tracked.orderItemIds],
    orderIds: [...tracked.orderIds],
    paymentIds: [...tracked.paymentIds],
  }).catch(() => {});
  tracked.userIds.length = 0; tracked.novelIds.length = 0; tracked.episodeIds.length = 0;
  tracked.topupIds.length = 0; tracked.orderIds.length = 0; tracked.orderItemIds.length = 0;
  tracked.paymentIds.length = 0; tracked.eventKeys.length = 0; tracked.wishlistPairs.length = 0;
}

afterEach(async () => {
  await cleanup();
});

/** The wishlist digest event's sourceId: `${novelId}_${batchKey}_0`, batchKey `ep${episodeId}`. */
function wishlistSourceId(novelId: number, episodeId: number): string {
  return `${novelId}_ep${episodeId}_0`;
}

async function wishlistEventByEpisode(novelId: number, episodeId: number) {
  const rows = await requireTestDb()
    .select()
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.kind, "wishlist_episodes_published"),
        eq(notificationEvents.sourceId, wishlistSourceId(novelId, episodeId))
      )
    );
  expect(rows.length, `wishlist event for novel ${novelId} episode ${episodeId} must exist`).toBe(1);
  return rows[0];
}

/** Real wallet-topup approval event through the real approval transaction. */
async function approvedTopupEvent(userId: number): Promise<number> {
  const topup = (await db.createWalletTopup(userId, "100.00", `https://example.test/slips/${uniqueTestTag()}.jpg`)) as { id: number };
  tracked.topupIds.push(topup.id);
  await db.approveWalletTopup(topup.id, 9001);
  return topup.id;
}

/** Real wishlist-episode publication event through the real producer tx. */
async function wishlistEpisodeEvent(novelId: number, episodeId: number): Promise<void> {
  await requireTestDb().transaction(async (tx: any) => {
    const outcome = await recordEpisodeFirstPublicationIfEnabled(tx, {
      episodeId, novelId, isPublished: true, flags: FANOUT_FLAGS, env: process.env,
    });
    if (outcome.status !== "created") {
      throw new Error(`wishlist producer did not emit: ${outcome.status}`);
    }
  });
}

/** Real novel first-publication event through the real producer tx. */
async function novelPublishedEvent(novelId: number): Promise<void> {
  await requireTestDb().transaction(async (tx: any) => {
    const outcome = await recordNovelFirstPublicationIfEnabled(tx, { novelId, flags: FANOUT_FLAGS, env: process.env });
    if (outcome.status !== "created") {
      throw new Error(`novel producer did not emit: ${outcome.status}`);
    }
  });
}

async function eventRowByKey(eventKey: string) {
  const rows = await requireTestDb()
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.eventKey, eventKey));
  return rows[0];
}

async function recipientsForEvent(eventId: bigint | number): Promise<Array<{ userId: number }>> {
  return requireTestDb()
    .select({ userId: notificationRecipients.userId })
    .from(notificationRecipients)
    .where(eq(notificationRecipients.eventId, eventId));
}

describe("S6 delivery: direct outcomes land in exactly one inbox (D1-D5)", () => {
  it("D1: approved topup event -> tick -> recipient + visible inbox entry", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);

    const result = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(result.created).toBe(1);
    expect(result.completed).toBe(1);

    const store = inbox();
    const view = await store.listOwnInbox({ actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 });
    expect(view.length).toBe(1);
    expect(view[0].title).toBe("เติมเงินสำเร็จ");
    expect(view[0].category).toBe("finance");
    expect(await store.countOwnUnread(user.id)).toBe(1);
  });

  it("D2: a direct outcome reaches ONLY the owner of the record", async () => {
    const owner = trackUser(await createTestUser());
    const bystander = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(owner.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);

    const dbgTick = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    const event = (await eventRowByKey(eventKey))!;
    const rows = await recipientsForEvent(event.id);
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].userId).not.toBe(bystander.id);
  });

  it("D2b: an episode wallet purchase event reaches only the buyer", async () => {
    const buyer = trackUser(await createTestUser());
    const novel = await createTestNovel();
    tracked.novelIds.push(novel.id);
    const episode = await createTestEpisode(novel.id, { price: "100.00", isFree: false, isPublished: true });
    tracked.episodeIds.push(episode.id);
    const t = requireTestDb();
    await t.insert(walletAccounts).values({
      userId: buyer.id, balance: "500.00", createdAt: new Date(), updatedAt: new Date(),
    });

    const purchase = await purchaseEpisodeWithWallet(buyer.id, episode.id);
    expect(purchase.success).toBe(true);
    const eventKey = `notification:v1:episode_wallet_purchased:episode_purchases:${purchase.episodePurchaseId}:settled`;
    tracked.eventKeys.push(eventKey);

    const tick = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(tick.created).toBe(1);
    const view = await inbox().listOwnInbox({ actorUserId: buyer.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 });
    expect(view.map((v) => v.title)).toContain("ซื้อตอนสำเร็จ");
  });

  it("D2c: an order completion event reaches only the order owner", async () => {
    const buyer = trackUser(await createTestUser());
    const novel = await createTestNovel();
    tracked.novelIds.push(novel.id);
    const episode = await createTestEpisode(novel.id, { price: "100.00", isFree: false, isPublished: true });
    tracked.episodeIds.push(episode.id);
    const order = await createTestOrder(buyer.id, { subtotal: "100.00", totalAmount: "100.00" });
    tracked.orderIds.push(order.id);
    const orderItem = await createTestOrderItem({ orderId: order.id, novelId: novel.id, episodeId: episode.id });
    tracked.orderItemIds.push(orderItem.id);
    const payment = await createTestPayment(order.id);
    tracked.paymentIds.push(payment.id);

    await expect(approvePayment(payment.id, "9001")).resolves.toBeDefined();
    const eventKey = `notification:v1:order_completed:orders:${order.id}:first_completion`;
    tracked.eventKeys.push(eventKey);

    const tick = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(tick.created).toBe(1);
    const view = await inbox().listOwnInbox({ actorUserId: buyer.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 });
    expect(view.map((v) => v.title)).toContain("คำสั่งซื้อสำเร็จ");
  });

  it("D3: a deleted account never receives a recipient (reader filters the row)", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);

    const t = requireTestDb();
    await t.delete(users).where(eq(users.id, user.id));

    const result = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(result.created).toBe(0);
    expect(result.completed).toBe(1);
    expect(await recipientsForEvent((await eventRowByKey(eventKey))!.id)).toHaveLength(0);
  });

  it("D4: opt-out after the event but before delivery -> no recipient", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);

    await inbox().setOwnPreference(user.id, "wallet_topup_approved", false);
    const result = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    // the qualified audience reader filters the opted-out user BEFORE any
    // insertion, so the event completes with an empty page - the insert-level
    // "ineligible" counter only counts users that reach the insertion tx.
    expect(result.ineligible).toBe(0);
    expect(result.created).toBe(0);
    expect(result.completed).toBe(1);
    expect(await recipientsForEvent((await eventRowByKey(eventKey))!.id)).toHaveLength(0);
  });

  it("D5: a late opt-in (after the event) never backfills the older event", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    await new Promise((r) => setTimeout(r, 1100));

    await inbox().setOwnPreference(user.id, "wallet_topup_approved", true);
    const result = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(result.created).toBe(0);
    expect(result.ineligible).toBe(0);
    expect(result.completed).toBe(1);
  });
});

describe("S6 delivery: catalog fanout revalidation (D6-D8, D14)", () => {
  async function fanoutFixture(followerCount: number): Promise<{ followers: TestUserFixture[]; novelId: number; episodeId: number }> {
    const followers: TestUserFixture[] = [];
    for (let i = 0; i < followerCount; i++) followers.push(trackUser(await createTestUser()));
    const novel = await createTestNovel();
    tracked.novelIds.push(novel.id);
    const episode = await createTestEpisode(novel.id, { isPublished: true });
    tracked.episodeIds.push(episode.id);
    for (const f of followers) {
      await requireTestDb().insert(wishlists).values({
        userId: f.id, novelId: novel.id, createdAt: new Date(Date.now() - 60_000),
      });
      tracked.wishlistPairs.push({ userId: f.id, novelId: novel.id });
      // catalog fanout kinds are DEFAULT-OFF by policy - a follower must have
      // an explicit opt-in committed strictly before the event
      await inbox().setOwnPreference(f.id, "wishlist_episodes_published", true);
    }
    // MySQL TIMESTAMP columns truncate sub-second precision and a same-second
    // opt-in/even tie fails closed - wait for a fresh second so the opt-in
    // second is STRICTLY before the event second, deterministically.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 50));
    await wishlistEpisodeEvent(novel.id, episode.id);
    // track the event key HERE so a later in-test failure cannot leak the
    // outbox row into subsequent tests
    const event = await wishlistEventByEpisode(novel.id, episode.id);
    tracked.eventKeys.push(event.eventKey);
    return { followers, novelId: novel.id, episodeId: episode.id };
  }

  it("D6: wishlist cancelled before delivery -> that follower gets nothing", async () => {
    const { followers, novelId, episodeId } = await fanoutFixture(2);
    const t = requireTestDb();
    await t.delete(wishlists).where(and(eq(wishlists.userId, followers[0].id), eq(wishlists.novelId, novelId)));
    tracked.wishlistPairs = tracked.wishlistPairs.filter((p) => p.userId !== followers[0].id);

    const result = await runInAppDeliveryTick(makeStore({ catalogFanoutEnabled: true }), tickNowFn(), TICK_LIMITS);
    expect(result.created).toBe(1);
    const event = await wishlistEventByEpisode(novelId, episodeId);
    tracked.eventKeys.push(event.eventKey);
    const rows = await recipientsForEvent(event.id);
    expect(rows.map((r) => r.userId)).toEqual([followers[1].id]);
  });

  it("D7: novel archived before delivery -> zero recipients, event still completes", async () => {
    const { novelId, episodeId } = await fanoutFixture(1);
    const t = requireTestDb();
    await t.update(novels).set({ publicationStatus: "archived" }).where(eq(novels.id, novelId));

    const result = await runInAppDeliveryTick(makeStore({ catalogFanoutEnabled: true }), tickNowFn(), TICK_LIMITS);
    expect(result.created).toBe(0);
    expect(result.completed).toBe(1);
    const event = await wishlistEventByEpisode(novelId, episodeId);
    tracked.eventKeys.push(event.eventKey);
    expect(await recipientsForEvent(event.id)).toHaveLength(0);
  });

  it("D8: follower promoted to author before delivery -> revalidated out at delivery", async () => {
    const { followers, novelId, episodeId } = await fanoutFixture(2);
    const t = requireTestDb();
    await t.update(users).set({ role: "author" }).where(eq(users.id, followers[0].id));

    await runInAppDeliveryTick(makeStore({ catalogFanoutEnabled: true }), tickNowFn(), TICK_LIMITS);

    const event = await wishlistEventByEpisode(novelId, episodeId);
    tracked.eventKeys.push(event.eventKey);
    const rows = await recipientsForEvent(event.id);
    expect(rows.map((r) => r.userId)).toEqual([followers[1].id]);
  });

  it("D14: audience larger than one page -> cursor advances, no one is skipped or duplicated", async () => {
    const { followers, novelId, episodeId } = await fanoutFixture(3);
    const t = requireTestDb();
    const store = makeStore({ catalogFanoutEnabled: true });

    const first = await runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS);
    expect(first.created).toBe(2);
    expect(first.partial).toBe(1);

    const second = await runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS);
    expect(second.created).toBe(1);
    expect(second.completed).toBe(1);

    const event = await wishlistEventByEpisode(novelId, episodeId);
    tracked.eventKeys.push(event.eventKey);
    const rows = await recipientsForEvent(event.id);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set(followers.map((f) => f.id)));
  });
});

describe("S6 delivery: exactly-once, leases and fencing (D9-D13, D15)", () => {
  it("D9: a duplicate tick claims nothing and creates nothing", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const store = makeStore();

    const first = await runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS);
    expect(first.created).toBe(1);
    const second = await runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS);
    expect(second.claimed).toBe(0);
    expect(second.created).toBe(0);
  });

  it("D10: two concurrent workers claim disjoint events (SKIP LOCKED), no duplicate recipients", async () => {
    const user = trackUser(await createTestUser());
    const t = requireTestDb();
    const topupIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      const topup = (await db.createWalletTopup(user.id, "10.00", `https://example.test/slips/${uniqueTestTag()}.jpg`)) as { id: number };
      tracked.topupIds.push(topup.id);
      topupIds.push(topup.id);
      await db.approveWalletTopup(topup.id, 9001);
      tracked.eventKeys.push(`notification:v1:wallet_topup_approved:wallet_topups:${topup.id}:credited`);
    }

    const sharedNow = tickNowFn();
    const results = await Promise.all([
      runInAppDeliveryTick(makeStore(), sharedNow, TICK_LIMITS),
      runInAppDeliveryTick(makeStore(), sharedNow, TICK_LIMITS),
    ]);
    expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(2);
    for (const topupId of topupIds) {
      const event = (await eventRowByKey(`notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`))!;
      expect(await scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.eventId, event.id)))).toBe(1);
    }
  });

  it("D11: an expired lease is reclaimable; the stale token is fenced out", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const t0 = tickNowFn();

    // claim with lease token A, then abandon it (no writes, no checkpoint)
    const firstClaim = await store.claimReadyEvents(t0, 10);
    expect(firstClaim.length).toBe(1);
    const staleToken = firstClaim[0].leaseToken;

    // after the 5-minute lease deadline a new claim re-claims the SAME event
    const later = new Date(t0.getTime() + 6 * 60_000);
    const reclaimed = await store.claimReadyEvents(later, 10);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].eventId).toBe(firstClaim[0].eventId);
    expect(reclaimed[0].attempt).toBe(2);
    expect(reclaimed[0].leaseToken).not.toBe(staleToken);

    // the STALE token can no longer fence any write
    await expect(store.completeEvent(firstClaim[0])).rejects.toThrow("lease lost");
    await expect(store.scheduleRetry(firstClaim[0], new Date(later.getTime() + 1000), "DELIVERY_ERROR"))
      .rejects.toThrow("lease lost");

    // the LIVE token completes cleanly
    await expect(store.completeEvent(reclaimed[0])).resolves.toBeUndefined();
  });

  it("D12: crash after some inserts, before checkpoint -> replay is idempotent", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const t0 = tickNowFn();

    // "crash": claim + insert one recipient, then abandon the lease
    const claimed = await store.claimReadyEvents(t0, 10);
    expect(claimed.length).toBe(1);
    await expect(store.insertRecipientIfAbsent(claimed[0], user.id)).resolves.toBe("created");

    // after lease expiry the next tick re-claims and replays safely
    const result = await runInAppDeliveryTick(store, new Date(t0.getTime() + 6 * 60_000), TICK_LIMITS);
    expect(result.created).toBe(0);
    expect(result.alreadyExists).toBe(1);
    expect(result.completed).toBe(1);
    const event = (await eventRowByKey(eventKey))!;
    expect(await recipientsForEvent(event.id)).toHaveLength(1);
  });

  it("D13: a dismissed recipient is a tombstone - replay never restores it", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const t = requireTestDb();
    const t0 = tickNowFn();

    // deliver, then crash before completion
    const claimed = await store.claimReadyEvents(t0, 10);
    expect(claimed.length).toBe(1);
    await expect(store.insertRecipientIfAbsent(claimed[0], user.id)).resolves.toBe("created");

    // the recipient is dismissed while the lease is abandoned
    // whole-second value: MySQL TIMESTAMP columns have no sub-second precision
    const dismissedAt = new Date(Math.floor((t0.getTime() + 1000) / 1000) * 1000);
    await t.update(notificationRecipients).set({ dismissedAt }).where(eq(notificationRecipients.userId, user.id));

    // replay after lease expiry: the tombstone wins - "dismissed", no restore
    const result = await runInAppDeliveryTick(store, new Date(t0.getTime() + 6 * 60_000), TICK_LIMITS);
    expect(result.dismissed).toBe(1);
    expect(result.created).toBe(0);
    expect(result.completed).toBe(1);

    const rows = await t.select().from(notificationRecipients).where(eq(notificationRecipients.userId, user.id));
    expect(rows.length).toBe(1);
    expect(Math.abs(rows[0].dismissedAt!.getTime() - dismissedAt.getTime())).toBeLessThanOrEqual(1000);
    const view = await inbox().listOwnInbox({ actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 });
    expect(view.length).toBe(0);
  });

  it("D15: repeated failures retry once, then dead-letter with a sanitized code", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const t = requireTestDb();
    const store = createSqlNotificationDeliveryStore(
      t,
      async () => {
        throw new Error("injected audience failure");
      },
      { catalogFanoutEnabled: false, checkinRemindersEnabled: false }
    );
    const t0 = tickNowFn();

    const first = await runInAppDeliveryTick(store, t0, TICK_LIMITS);
    expect(first.retried).toBe(1);
    const outboxRow = (
      await t.select().from(notificationOutbox).where(
        eq(notificationOutbox.eventId, (await eventRowByKey(eventKey))!.id)
      )
    )[0];
    expect(outboxRow.state).toBe("pending");
    expect(outboxRow.lastFailureCode).toBe("DELIVERY_ERROR");
    expect(outboxRow.attempt).toBe(1);

    const second = await runInAppDeliveryTick(store, new Date(t0.getTime() + 61_000), TICK_LIMITS);
    expect(second.deadLettered).toBe(1);
    const deadRow = (
      await t.select().from(notificationOutbox).where(
        eq(notificationOutbox.eventId, (await eventRowByKey(eventKey))!.id)
      )
    )[0];
    expect(deadRow.state).toBe("dead_letter");
    expect(deadRow.leaseToken).toBeNull();
  });
});

describe("S6 inbox operations on real rows (D16)", () => {
  it("D16: unread count, mark read, mark all read and delete all behave exactly", async () => {
    const user = trackUser(await createTestUser());
    const store = inbox();
    for (let i = 0; i < 2; i++) await approvedTopupEvent(user.id);
    const rejectedTopup = (await db.createWalletTopup(user.id, "50.00", `https://example.test/slips/${uniqueTestTag()}.jpg`)) as { id: number };
    tracked.topupIds.push(rejectedTopup.id);
    await db.rejectWalletTopup(rejectedTopup.id, 9001, "S6 D16");
    const tickResult = await runInAppDeliveryTick(makeStore(), tickNowFn(), TICK_LIMITS);
    expect(tickResult.created).toBe(3);

    expect(await store.countOwnUnread(user.id)).toBe(3);
    const view = await store.listOwnInbox({ actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 });
    expect(view.length).toBe(3);

    // mark ONE read
    expect(await store.markOwnRead(user.id, view[0].id)).toBe(true);
    expect(await store.countOwnUnread(user.id)).toBe(2);
    expect(await store.markOwnRead(user.id, view[0].id)).toBe(true);

    // mark ALL read via the real bulk path
    const marked = await store.bulk.transaction(async (tx) => {
      const op = await tx.lockOrCreateOperation(user.id, `s6-${uniqueTestTag()}`, "mark_all_read");
      const rows = await tx.applyToRecipients(op, new Date());
      await tx.completeOperation(op, rows);
      return rows;
    });
    expect(marked).toBe(2);
    expect(await store.countOwnUnread(user.id)).toBe(0);

    // delete ALL via the real bulk path -> tombstones excluded from the list
    const deleted = await store.bulk.transaction(async (tx) => {
      const op = await tx.lockOrCreateOperation(user.id, `s6-${uniqueTestTag()}`, "delete_all");
      const rows = await tx.applyToRecipients(op, new Date());
      await tx.completeOperation(op, rows);
      return rows;
    });
    expect(deleted).toBe(3);
    expect((await store.listOwnInbox({ actorUserId: user.id, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 })).length).toBe(0);
  });
});

describe("S6 gates fail closed before any delivery SQL (D17-D19)", () => {
  it("D17+D18: master or delivery gate OFF -> the runner does nothing", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const t = requireTestDb();
    const before = (await t.select().from(notificationOutbox))[0];

    const masterOff = createNotificationDeliveryRunner(makeStore(), {
      notificationsEnabled: false, deliveryEnabled: true,
      checkinRemindersEnabled: false, catalogFanoutEnabled: false,
    });
    await expect(masterOff()).resolves.toEqual({ status: "disabled" });

    const deliveryOff = createNotificationDeliveryRunner(makeStore(), {
      notificationsEnabled: true, deliveryEnabled: false,
      checkinRemindersEnabled: false, catalogFanoutEnabled: false,
    });
    await expect(deliveryOff()).resolves.toEqual({ status: "disabled" });

    const after = (await t.select().from(notificationOutbox))[0];
    expect(after.attempt).toBe(before.attempt);
    expect(after.state).toBe(before.state);
    expect(after.leaseToken).toBeNull();
  });

  it("D19: catalog/check-in gates OFF -> those event categories are never claimed", async () => {
    const novel = await createTestNovel();
    tracked.novelIds.push(novel.id);
    await novelPublishedEvent(novel.id);
    // track the event so cleanup removes its pending outbox row even though
    // this test never claims it (a leftover pending row would leak into
    // another file's manual claimReadyEvents)
    const d19Event = (
      await requireTestDb()
        .select()
        .from(notificationEvents)
        .where(and(eq(notificationEvents.kind, "novel_published"), eq(notificationEvents.sourceId, String(novel.id))))
    )[0];
    tracked.eventKeys.push(d19Event.eventKey);

    const result = await runInAppDeliveryTick(makeStore({ catalogFanoutEnabled: false }), tickNowFn(), TICK_LIMITS);
    expect(result.claimed).toBe(0);
    const t = requireTestDb();
    const event = (
      await t
        .select()
        .from(notificationEvents)
        .where(and(eq(notificationEvents.kind, "novel_published"), eq(notificationEvents.sourceId, String(novel.id))))
    )[0];
    expect(event).toBeDefined();
    const outboxRow = (
      await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, event.id))
    )[0];
    expect(outboxRow.state).toBe("pending");
    expect(outboxRow.attempt).toBe(0);
    expect(outboxRow.leaseToken).toBeNull();
  });
});

describe("S6 lifecycle: account merge / deletion cannot strand recipients (D20)", () => {
  it("D20: a user deleted mid-flight is filtered at the insertion write point", async () => {
    const user = trackUser(await createTestUser());
    const topupId = await approvedTopupEvent(user.id);
    const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${topupId}:credited`;
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const t = requireTestDb();

    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    // the account is hard-deleted AFTER the audience read claimed the event
    await t.delete(users).where(eq(users.id, user.id));

    await expect(store.insertRecipientIfAbsent(claimed[0], user.id)).resolves.toBe("ineligible");
    expect(await scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.userId, user.id)))).toBe(0);
    // the lease is still live: release it cleanly via retry scheduling
    await store.scheduleRetry(claimed[0], new Date(Date.now() + 60_000), "DELIVERY_ERROR");
  });
});
