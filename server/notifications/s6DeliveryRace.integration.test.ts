/**
 * R40R56R1 — REAL-DATABASE delivery-time revalidation RACE qualification.
 *
 * Two (or more) REAL connections collide under explicit promise BARRIERS -
 * never sleeps - to pin the exact statement interleaving:
 *   - the DELIVERY side is the real fenced store (FOR SHARE current reads)
 *   - the ADVERSARY side is a raw mysql2 connection replaying the AUDITED
 *     external-writer statement orders:
 *       admin deletion  = BEGIN; SELECT users ... FOR UPDATE (step 1); ...
 *       novel archive   = UPDATE novels ... publicationStatus
 *       wishlist remove = DELETE FROM wishlists ...
 *       live opt-out    = sequence FOR UPDATE; UPDATE notificationPreferences
 *
 * Lock-order theorem exercised here (see sqlDeliveryStore.ts header): every
 * adversary takes ITS OWN row lock FIRST and never requests the outbox/
 * sequence/prefs/recipient locks the delivery transaction holds, so the
 * delivery transaction can only WAIT - the {users, novels, wishlists} FOR
 * SHARE contacts cannot form a cycle.
 *
 * Mock proofs: sqlDeliveryStore.test.ts. Full tick coverage:
 * s6DeliveryInbox.integration.test.ts (D1-D20). THIS file pins the races.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
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
import { createSqlNotificationDeliveryStore } from "./sqlDeliveryStore";
import { createQualifiedSqlAudienceReader } from "./sqlAudienceReader";
import { runInAppDeliveryTick, DEFAULT_DELIVERY_LIMITS, type DeliveryLimits } from "./deliveryPolicy";
import { readNotificationRuntimeFlags } from "./runtimeGate";
import { recordEpisodeFirstPublicationIfEnabled } from "./episodePublicationProducer";
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
    throw new Error("S6 race integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

const FLAGS = readNotificationRuntimeFlags(process.env);
const FANOUT_FLAGS = { ...FLAGS, catalogFanoutEnabled: true };
const TICK_LIMITS: DeliveryLimits = { ...DEFAULT_DELIVERY_LIMITS, maxRecipientsPerEvent: 5, maxAttempts: 2, baseRetryMs: 60_000 };

/** Tick clock allowance for the disposable container's trailing clock. */
function tickNowFn(): Date {
  return new Date(Date.now() + 5_000);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

function makeStore() {
  return createSqlNotificationDeliveryStore(
    requireTestDb(),
    createQualifiedSqlAudienceReader(requireTestDb()),
    { catalogFanoutEnabled: true, checkinRemindersEnabled: false },
  );
}

/** A dedicated raw connection for adversary transactions (own session). */
async function adversary(): Promise<mysql.Connection> {
  return mysql.createConnection(process.env.TEST_DATABASE_URL!);
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

/** Real direct (wallet top-up approved) event through the real approval tx. */
async function approvedTopupEvent(userId: number): Promise<{ topupId: number; eventKey: string }> {
  const topup = (await db.createWalletTopup(userId, "100.00", `https://example.test/slips/${uniqueTestTag()}.jpg`)) as { id: number };
  tracked.topupIds.push(topup.id);
  await db.approveWalletTopup(topup.id, 9001);
  return { topupId: topup.id, eventKey: `notification:v1:wallet_topup_approved:wallet_topups:${topup.id}:credited` };
}

interface FanoutFixture {
  follower: TestUserFixture;
  novelId: number;
  episodeId: number;
  eventKey: string;
}

/** Real wishlist digest event for ONE pre-event follower (explicit opt-in). */
async function fanoutFixture(): Promise<FanoutFixture> {
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
      episodeId: episode.id, novelId: novel.id, isPublished: true, flags: FANOUT_FLAGS, env: process.env,
    });
    if (outcome.status !== "created") throw new Error(`producer: ${outcome.status}`);
  });
  // The preference row carries an explicit backdated updatedAt: the fixture
  // needs opt-in strictly BEFORE eventAt, and host/server clock skew plus
  // MySQL second truncation makes a "just now" opt-in ambiguous.
  const t = requireTestDb();
  await t.transaction(async (tx: any) => {
    const { notificationPreferences } = await import("./tables");
    await tx.insert(notificationPreferences).values({
      userId: follower.id, kind: "wishlist_episodes_published", enabled: true,
      updatedAt: new Date(Date.now() - 120_000),
    }).onDuplicateKeyUpdate({ set: { enabled: true, updatedAt: new Date(Date.now() - 120_000) } });
  });
  const eventRows = await t
    .select()
    .from(notificationEvents)
    .where(and(eq(notificationEvents.kind, "wishlist_episodes_published"), eq(notificationEvents.sourceId, `${novel.id}_ep${episode.id}_0`)));
  expect(eventRows.length).toBe(1);
  return { follower, novelId: novel.id, episodeId: episode.id, eventKey: eventRows[0].eventKey };
}

describe("R40R56R1 account deletion races (barrier-controlled, real connections)", () => {
  it("R1: audience read -> account deleted (committed) -> INSERT returns ineligible, zero orphans", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    const store = makeStore();
    const t = requireTestDb();

    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);

    // adversary: hard-delete the user AFTER the audience snapshot
    await t.delete(users).where(eq(users.id, user.id));

    await expect(store.insertRecipientIfAbsent(claimed[0], user.id)).resolves.toBe("ineligible");
    expect(await scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.userId, user.id)))).toBe(0);
    void eventKey;
  });

  it("R2a: deletion transaction holds the users row first -> delivery waits, sees committed deletion -> ineligible", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);

    // adversary replays the audited deletion step 1 and pauses mid-transaction
    const conn = await adversary();
    const deletionHeld = deferred();
    const releaseDeletion = deferred();
    const adversaryTx = (async () => {
      await conn.beginTransaction();
      await conn.query("SELECT * FROM users WHERE id = ? FOR UPDATE", [user.id]);
      deletionHeld.resolve();
      await releaseDeletion.promise;
      await conn.query("DELETE FROM users WHERE id = ?", [user.id]);
      await conn.commit();
    })();

    await deletionHeld.promise;
    // delivery now runs against the deletion's uncommitted users X-lock:
    // the FOR SHARE waits, the deletion commits, the current read sees the
    // row gone -> ineligible (never an orphan insert). The insert is NOT
    // awaited before the release - it can only finish once the adversary
    // commits, which is the exact interleaving under test.
    const insertPromise = store.insertRecipientIfAbsent(claimed[0], user.id);
    releaseDeletion.resolve();
    const outcome = await insertPromise;
    await adversaryTx;
    await conn.end();

    expect(outcome).toBe("ineligible");
    const t = requireTestDb();
    expect(await scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.userId, user.id)))).toBe(0);
    expect(await scalarCount(t.select({ c: count() }).from(users).where(eq(users.id, user.id)))).toBe(0);
  });

  it("R2b: delivery wins the users row first -> the real deletion assessment sees the recipient and CONFLICTS", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    await expect(store.insertRecipientIfAbsent(claimed[0], user.id)).resolves.toBe("created");

    // the REAL admin-deletion assessment now runs (plain reads inside the
    // deletion transaction) - the committed recipient is a user_owned
    // blocker, so the flow must refuse (canDelete=false), exactly the
    // contract that makes an orphan recipient impossible
    const assessment = await db.getAdminUserDeleteAssessment(user.id, requireTestDb());
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.some((b: any) => b.table === "notificationRecipients")).toBe(true);
    expect(await scalarCount(requireTestDb().select({ c: count() }).from(users).where(eq(users.id, user.id)))).toBe(1);
  });

  it("R3: role flipped to author between audience read and INSERT -> ineligible", async () => {
    const { follower, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    const t = requireTestDb();
    await t.update(users).set({ role: "author" }).where(eq(users.id, follower.id));

    await expect(store.insertRecipientIfAbsent(claimed[0], follower.id)).resolves.toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });
});

async function recipientsCount(eventKey: string): Promise<number> {
  const t = requireTestDb();
  const event = (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0];
  if (!event) return -1;
  return scalarCount(t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.eventId, event.id)));
}

describe("R40R56R1 novel publication races", () => {
  it("R4: novel archived between audience read and INSERT -> ineligible", async () => {
    const { follower, novelId, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    const t = requireTestDb();
    await t.update(novels).set({ publicationStatus: "archived" }).where(eq(novels.id, novelId));

    await expect(store.insertRecipientIfAbsent(claimed[0], follower.id)).resolves.toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("R5: archive transaction holds the novels row during the recipient transaction -> delivery waits, then applies the archive", async () => {
    const { follower, novelId, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);

    const conn = await adversary();
    const archiveHeld = deferred();
    const releaseArchive = deferred();
    const archiveTx = (async () => {
      await conn.beginTransaction();
      await conn.query("SELECT * FROM novels WHERE id = ? FOR UPDATE", [novelId]);
      archiveHeld.resolve();
      await releaseArchive.promise;
      await conn.query("UPDATE novels SET publicationStatus = 'archived' WHERE id = ?", [novelId]);
      await conn.commit();
    })();

    await archiveHeld.promise;
    const insertPromise = store.insertRecipientIfAbsent(claimed[0], follower.id);
    releaseArchive.resolve();
    const outcome = await insertPromise;
    await archiveTx;
    await conn.end();

    expect(outcome).toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });
});

describe("R40R56R1 wishlist membership races", () => {
  it("R6: wishlist removed between audience read and INSERT -> ineligible", async () => {
    const { follower, novelId, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    const t = requireTestDb();
    await t.delete(wishlists).where(and(eq(wishlists.userId, follower.id), eq(wishlists.novelId, novelId)));

    await expect(store.insertRecipientIfAbsent(claimed[0], follower.id)).resolves.toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("R7: unfollow transaction holds the wishlist row during the recipient transaction -> delivery waits, then applies the unfollow", async () => {
    const { follower, novelId, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);

    const conn = await adversary();
    const unfollowHeld = deferred();
    const releaseUnfollow = deferred();
    const unfollowTx = (async () => {
      await conn.beginTransaction();
      await conn.query("SELECT * FROM wishlists WHERE userId = ? AND novelId = ? FOR UPDATE", [follower.id, novelId]);
      unfollowHeld.resolve();
      await releaseUnfollow.promise;
      await conn.query("DELETE FROM wishlists WHERE userId = ? AND novelId = ?", [follower.id, novelId]);
      await conn.commit();
    })();

    await unfollowHeld.promise;
    const insertPromise = store.insertRecipientIfAbsent(claimed[0], follower.id);
    releaseUnfollow.resolve();
    const outcome = await insertPromise;
    await unfollowTx;
    await conn.end();

    expect(outcome).toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("R8: a follow committed after the event is never backfilled", async () => {
    const { follower, novelId, eventKey } = await fanoutFixture();
    tracked.eventKeys.push(eventKey);
    const t = requireTestDb();
    // simulate a late re-follow: delete + re-create with a post-event timestamp
    await t.delete(wishlists).where(and(eq(wishlists.userId, follower.id), eq(wishlists.novelId, novelId)));
    const event = (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0];
    await t.insert(wishlists).values({
      userId: follower.id, novelId, createdAt: new Date(event.occurredAt.getTime() + 60_000),
    });
    tracked.wishlistPairs = tracked.wishlistPairs.filter((p) => p.userId !== follower.id);

    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    await expect(store.insertRecipientIfAbsent(claimed[0], follower.id)).resolves.toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });
});

describe("R40R56R1 preference / idempotency / deadlock-safety races", () => {
  it("R9: live opt-out committed during delivery wins (sequence-lock interleaving)", async () => {
    const user = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(user.id);
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);

    // adversary replays setOwnPreference's audited order: sequence FOR UPDATE
    // first, then the preference write - while the delivery transaction is
    // blocked on that same sequence lock
    const conn = await adversary();
    const optOutHeld = deferred();
    const releaseOptOut = deferred();
    const optOutTx = (async () => {
      await conn.beginTransaction();
      await conn.query("SELECT nextSequence FROM notificationSequence WHERE id = 1 FOR UPDATE");
      optOutHeld.resolve();
      await releaseOptOut.promise;
      await conn.query(
        "INSERT INTO notificationPreferences (userId, kind, enabled, updatedAt) VALUES (?, 'wallet_topup_approved', 0, NOW(3)) " +
          "ON DUPLICATE KEY UPDATE enabled = 0, updatedAt = NOW(3)",
        [user.id]
      );
      await conn.commit();
    })();

    await optOutHeld.promise;
    const insertPromise = store.insertRecipientIfAbsent(claimed[0], user.id);
    releaseOptOut.resolve();
    const outcome = await insertPromise;
    await optOutTx;
    await conn.end();

    expect(outcome).toBe("ineligible");
    expect(await recipientsCount(eventKey)).toBe(0);
  });

  it("R14: mixed concurrent writers (delivery + deletion + archive) settle without unresolved deadlock", async () => {
    const owner = trackUser(await createTestUser());
    const novel = await createTestNovel();
    tracked.novelIds.push(novel.id);
    const { eventKey } = await approvedTopupEvent(owner.id);
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const t = requireTestDb();
    const deadline = Date.now() + 20_000;
    let deadlockCount = 0;
    let settled = false;

    // Hammer: alternate concurrent delivery ticks with audited lock contacts
    // (deletion's users-row FOR UPDATE + an archive's novels-row FOR UPDATE
    // inside ONE adversary transaction). A detected deadlock surfaces as a
    // tick retry (DELIVERY_ERROR) - the DESIGNED outcome - while an
    // UNRESOLVED deadlock hangs until the 20s vitest timeout and fails.
    while (Date.now() < deadline) {
      const ticks = Promise.allSettled([
        runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS),
        runInAppDeliveryTick(store, tickNowFn(), TICK_LIMITS),
      ]);
      const conn = await adversary();
      try {
        await conn.beginTransaction();
        await conn.query("SELECT * FROM users WHERE id = ? FOR UPDATE", [owner.id]);
        await conn.query("SELECT * FROM novels WHERE id = ? FOR UPDATE", [novel.id]);
        await conn.commit();
      } catch {
        deadlockCount++;
        await conn.query("ROLLBACK").catch(() => {});
      } finally {
        await conn.end().catch(() => {});
      }
      const results = await ticks;
      for (const r of results) {
        if (r.status === "rejected") throw new Error(`tick crashed: ${String(r.reason)}`);
      }
      const event = (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)))[0];
      const outboxRow = (await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, event.id)))[0];
      if (outboxRow.state === "completed") {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    // final consistency: the direct event delivered exactly once to the owner
    expect(await recipientsCount(eventKey)).toBe(1);
    // a deadlock may have been detected and retried - report for the record
    console.log("R14_DEADLOCKS", deadlockCount);
  });

  it("R15: direct financial delivery still reaches only the eligible owner", async () => {
    const owner = trackUser(await createTestUser());
    const outsider = trackUser(await createTestUser());
    const { eventKey } = await approvedTopupEvent(owner.id);
    tracked.eventKeys.push(eventKey);
    const store = makeStore();
    const claimed = await store.claimReadyEvents(tickNowFn(), 10);
    expect(claimed.length).toBe(1);
    await expect(store.insertRecipientIfAbsent(claimed[0], owner.id)).resolves.toBe("created");
    // a wrong-target insert attempt fails the identity check
    await expect(store.insertRecipientIfAbsent({ ...claimed[0] }, outsider.id)).rejects.toThrow(/identity mismatch/);
    expect(await recipientsCount(eventKey)).toBe(1);
  });
});
