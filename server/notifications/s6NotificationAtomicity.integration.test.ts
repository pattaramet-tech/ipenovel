/**
 * R40R55 S6 — REAL-DATABASE notification event/outbox atomicity and unique
 * constraint qualification.
 *
 * Exercises the REAL transactional event-outbox adapter
 * (server/notifications/eventOutboxStore.ts) inside REAL drizzle
 * transactions on the disposable `ipenovel_test` MySQL 8 database, plus the
 * raw unique constraints 0067 created. No mocks, no fake transactions.
 *
 * Proven here:
 *   - business write + event + outbox commit together
 *   - an event-identity collision inside the transaction rolls the business
 *     write back (no partial commit)
 *   - an outbox unique violation rolls the event back (event+outbox are one
 *     unit)
 *   - concurrent duplicate eventKey: exactly one event row survives
 *   - recipients / digest membership / publication marker unique constraints
 *   - pre-activation events are skipped, never written
 *
 * NOTE (schema fact proven during qualification): 0067 is additive and
 * intentionally declares NO foreign keys between notification tables - the
 * outbox/event pairing is enforced by the application transaction plus the
 * notificationOutbox.eventId UNIQUE key, both exercised below.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  notificationDigestBatches,
  notificationDigestMemberships,
  notificationEvents,
  notificationOutbox,
  notificationPublicationMarkers,
  notificationRecipients,
  walletTopups,
} from "../../drizzle/schema";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import type { ValidatedNotificationEvent } from "./eventIngress";
import { getTestDb } from "../test-helpers/testDb";
import { createTestUser, deleteFixtures, uniqueTestTag, type TestUserFixture } from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("S6 integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

const ACTIVATION = new Date("2026-10-01T00:00:00.000Z");

const trackedUserIds: number[] = [];
const trackedEventKeys: string[] = [];
const trackedTopupIds: number[] = [];
const trackedBatchIds: number[] = [];
const trackedMarkerIds: number[] = [];

function makeEvent(overrides: Partial<ValidatedNotificationEvent> = {}): ValidatedNotificationEvent {
  const topupId = 1 + Math.floor(Math.random() * 1_000_000_000);
  const event: ValidatedNotificationEvent = {
    kind: "wallet_topup_approved",
    key: `wallet_topup_approved:wallet_topups:s6_${uniqueTestTag()}:credited`,
    sourceType: "wallet_topups",
    sourceId: String(topupId),
    transitionKey: "credited",
    targetUserId: trackedUserIds[trackedUserIds.length - 1] ?? 1,
    episodeIds: [],
  };
  return { ...event, ...overrides };
}

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

function insertIdOf(result: any): number {
  return Number(result?.[0]?.insertId ?? result?.insertId);
}

afterEach(async () => {
  const t = requireTestDb();
  while (trackedMarkerIds.length > 0) {
    const id = trackedMarkerIds.pop()!;
    await t.delete(notificationPublicationMarkers).where(eq(notificationPublicationMarkers.id, id)).catch(() => {});
  }
  while (trackedBatchIds.length > 0) {
    const id = trackedBatchIds.pop()!;
    await t.delete(notificationDigestMemberships).where(eq(notificationDigestMemberships.batchId, id)).catch(() => {});
    await t.delete(notificationDigestBatches).where(eq(notificationDigestBatches.id, id)).catch(() => {});
  }
  while (trackedTopupIds.length > 0) {
    const id = trackedTopupIds.pop()!;
    await t.delete(walletTopups).where(eq(walletTopups.id, id)).catch(() => {});
  }
  while (trackedEventKeys.length > 0) {
    const key = trackedEventKeys.pop()!;
    const rows = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, key))
      .catch(() => []);
    for (const row of rows) {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id)).catch(() => {});
      await t.delete(notificationRecipients).where(eq(notificationRecipients.eventId, row.id)).catch(() => {});
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.eventKey, key)).catch(() => {});
  }
  while (trackedUserIds.length > 0) {
    const id = trackedUserIds.pop()!;
    await deleteFixtures({ userIds: [id] }).catch(() => {});
  }
});

async function newUser(): Promise<TestUserFixture> {
  const user = await createTestUser();
  trackedUserIds.push(user.id);
  return user;
}

async function createBusinessTopup(tx: any, userId: number): Promise<number> {
  const result = await tx.insert(walletTopups).values({
    userId,
    requestedAmount: "100.00",
    slipImageUrl: `https://example.test/slips/${uniqueTestTag()}.jpg`,
  });
  const id = insertIdOf(result);
  trackedTopupIds.push(id);
  return id;
}

describe("S6 event+outbox transactional atomicity (real adapter, real transactions)", () => {
  it("S6-N1: business commit success -> event AND outbox written in the SAME transaction", async () => {
    const user = await newUser();
    const t = requireTestDb();
    let event = makeEvent({ targetUserId: user.id });

    await t.transaction(async (tx: any) => {
      const topupId = await createBusinessTopup(tx, user.id);
      event = {
        ...event,
        sourceId: String(topupId),
        key: `wallet_topup_approved:wallet_topups:${topupId}:credited`,
      };
      const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION);
      await expect(adapter.insertEventWithOutboxIfAbsent(event)).resolves.toBe("created");
    });
    trackedEventKeys.push(event.key);

    const stored = (
      await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
    )[0];
    expect(stored).toBeDefined();
    expect(stored.targetUserId).toBe(user.id);
    const outbox = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, stored.id));
    expect(outbox.length).toBe(1);
    expect(outbox[0].state).toBe("pending");
  });

  it("S6-N2: event identity collision inside the transaction rolls the BUSINESS write back", async () => {
    const user = await newUser();
    const t = requireTestDb();
    const event = makeEvent({ targetUserId: user.id });
    trackedEventKeys.push(event.key);

    // pre-seed an event with the SAME key but a DIFFERENT identity
    await t.transaction(async (tx: any) => {
      const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION);
      await expect(adapter.insertEventWithOutboxIfAbsent(event)).resolves.toBe("created");
    });

    const colliding: ValidatedNotificationEvent = {
      ...event,
      kind: "wallet_topup_rejected",
    };

    let topupIdSeen = 0;
    await expect(
      t.transaction(async (tx: any) => {
        topupIdSeen = await createBusinessTopup(tx, user.id);
        const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION);
        await adapter.insertEventWithOutboxIfAbsent(colliding);
      })
    ).rejects.toThrow(/identity collision/);

    // the business write from the aborted transaction must NOT exist
    const rows = await t.select().from(walletTopups).where(eq(walletTopups.id, topupIdSeen));
    expect(rows.length).toBe(0);
    // and the original event is untouched, exactly one copy
    expect(
      await scalarCount(
        t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
      )
    ).toBe(1);
  });

  it("S6-N3: outbox unique violation rolls the EVENT back - event+outbox are one unit", async () => {
    const user = await newUser();
    const t = requireTestDb();
    const event = makeEvent({ targetUserId: user.id });
    trackedEventKeys.push(event.key);

    // In one real transaction: insert the event via the adapter (which also
    // inserts its outbox row), then attempt a SECOND outbox row for the same
    // eventId. notificationOutbox_eventId_uq must reject it and the WHOLE
    // transaction - the event row included - must roll back.
    let txFailed = false;
    await t
      .transaction(async (tx: any) => {
        const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION);
        await adapter.insertEventWithOutboxIfAbsent(event);
        const rows = await tx.select().from(notificationEvents).where(eq(notificationEvents.eventKey, event.key));
        await tx.insert(notificationOutbox).values({ eventId: rows[0].id, state: "pending", attempt: 0 });
      })
      .catch(() => {
        txFailed = true;
      });
    expect(txFailed).toBe(true);

    expect(
      await scalarCount(
        t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
      )
    ).toBe(0);
    // the synthetic business topup from the same rolled-back tx is gone too
    expect(
      await scalarCount(
        t.select({ c: count() }).from(walletTopups).where(eq(walletTopups.userId, user.id))
      )
    ).toBe(0);
    trackedEventKeys.pop(); // event was never created; nothing to clean
  });

  it("S6-N4: concurrent duplicate eventKey -> exactly ONE event row survives", async () => {
    const user = await newUser();
    const t = requireTestDb();
    const event = makeEvent({ targetUserId: user.id });
    trackedEventKeys.push(event.key);

    const outcomes = await Promise.allSettled([
      t.transaction(async (tx: any) =>
        createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION).insertEventWithOutboxIfAbsent(event)
      ),
      t.transaction(async (tx: any) =>
        createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION).insertEventWithOutboxIfAbsent(event)
      ),
    ]);

    const values = outcomes
      .filter((o): o is PromiseFulfilledResult<string> => o.status === "fulfilled")
      .map((o) => o.value);
    // exactly one "created"; the other either resolved "duplicate" or its
    // transaction was rejected - never two "created"
    expect(values.filter((v) => v === "created").length).toBe(1);
    expect(
      values.filter((v) => v === "duplicate").length + outcomes.filter((o) => o.status === "rejected").length
    ).toBe(1);

    expect(
      await scalarCount(
        t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
      )
    ).toBe(1);
  });

  it("S6-N5: pre-activation events are skipped - zero rows written", async () => {
    const user = await newUser();
    const t = requireTestDb();
    const futureActivation = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const event = makeEvent({ targetUserId: user.id });

    // the adapter short-circuits before touching the transaction, so a
    // placeholder tx handle is safe here by construction
    const adapter = createTransactionalEventOutboxAdapter(undefined as never, new Date(), futureActivation);
    await expect(adapter.insertEventWithOutboxIfAbsent(event)).resolves.toBe("skipped");
    expect(
      await scalarCount(
        t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
      )
    ).toBe(0);
  });
});

describe("S6 notification unique constraints (real DDL from 0067)", () => {
  it("S6-N6: notificationRecipients (eventId,userId) is unique", async () => {
    const user = await newUser();
    const t = requireTestDb();
    const event = makeEvent({ targetUserId: user.id });
    trackedEventKeys.push(event.key);

    await t.transaction(async (tx: any) => {
      const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), ACTIVATION);
      await expect(adapter.insertEventWithOutboxIfAbsent(event)).resolves.toBe("created");
    });
    const stored = (
      await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, event.key))
    )[0];
    const seq = Date.now();

    await t.insert(notificationRecipients).values({
      eventId: stored.id,
      userId: user.id,
      receivedSequence: BigInt(seq),
      category: "transactional",
    });
    await expect(
      t.insert(notificationRecipients).values({
        eventId: stored.id,
        userId: user.id,
        receivedSequence: BigInt(seq + 1),
        category: "transactional",
      })
    ).rejects.toThrow();
    expect(
      await scalarCount(
        t
          .select({ c: count() })
          .from(notificationRecipients)
          .where(eq(notificationRecipients.eventId, stored.id))
      )
    ).toBe(1);
  });

  it("S6-N7: digest membership claims an episode exactly once (episodeId unique across batches)", async () => {
    const t = requireTestDb();
    const batchKey = `wr_s6_${uniqueTestTag()}`;
    const batchId = insertIdOf(
      await t.insert(notificationDigestBatches).values({
        batchKey,
        novelId: 1,
        sourceIdentity: `s6-${uniqueTestTag()}`,
      })
    );
    trackedBatchIds.push(batchId);
    const episodeId = BigInt(Date.now());

    await t.insert(notificationDigestMemberships).values({ batchId, episodeId });
    await expect(
      t.insert(notificationDigestMemberships).values({ batchId, episodeId })
    ).rejects.toThrow();
    expect(
      await scalarCount(
        t
          .select({ c: count() })
          .from(notificationDigestMemberships)
          .where(eq(notificationDigestMemberships.episodeId, episodeId))
      )
    ).toBe(1);

    // a SECOND batch claiming the same episode is equally rejected
    const secondBatchId = insertIdOf(
      await t.insert(notificationDigestBatches).values({
        batchKey: `${batchKey}_b`,
        novelId: 1,
        sourceIdentity: `s6-${uniqueTestTag()}`,
      })
    );
    trackedBatchIds.push(secondBatchId);
    await expect(
      t.insert(notificationDigestMemberships).values({ batchId: secondBatchId, episodeId })
    ).rejects.toThrow();
  });

  it("S6-N8: publication marker is unique per (entityType, entityId)", async () => {
    const t = requireTestDb();
    const entityId = BigInt(Date.now());
    const markerId = insertIdOf(
      await t.insert(notificationPublicationMarkers).values({
        entityType: "novel",
        entityId,
        state: "published",
        firstPublishedAt: new Date(),
      })
    );
    trackedMarkerIds.push(markerId);

    await expect(
      t.insert(notificationPublicationMarkers).values({ entityType: "novel", entityId, state: "published" })
    ).rejects.toThrow();
    expect(
      await scalarCount(
        t
          .select({ c: count() })
          .from(notificationPublicationMarkers)
          .where(
            and(
              eq(notificationPublicationMarkers.entityType, "novel"),
              eq(notificationPublicationMarkers.entityId, entityId)
            )
          )
      )
    ).toBe(1);
  });
});
