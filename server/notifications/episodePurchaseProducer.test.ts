import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  notificationEvents,
  notificationOutbox,
} from "./tables";
import { recordEpisodeWalletPurchaseIfEnabled } from "./episodePurchaseProducer";
import { readNotificationRuntimeFlags } from "./runtimeGate";

const ENABLED = readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" });
const ALL_OFF = readNotificationRuntimeFlags({});

/**
 * In-memory fake of the wallet-purchase business transaction. The producer's
 * writes go through THIS object, so "same transaction" claims are provable at
 * unit level. Real MySQL concurrency (double-debit prevention via the atomic
 * balance UPDATE and the unique_user_episode_purchase constraint) is EXISTING
 * purchase-service behavior, unchanged by this producer, and remains a
 * disposable-DB qualification gap.
 */
function createFakeTx(options?: {
  existingEventKeys?: Set<string>;
  priorEvents?: Array<{ eventKey: string; kind: string; sourceType: string; sourceId: string; transitionKey: string; targetUserId: number | null }>
}) {
  const existingEventKeys = options?.existingEventKeys ?? new Set<string>();
  const calls = { eventsInsert: 0, outboxInsert: 0, eventIdLookups: 0 };
  const eventRows: Array<Record<string, unknown>> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  let eventSeq = 3000;
  for (const prior of options?.priorEvents ?? []) {
    eventSeq += 1;
    eventRows.push({ ...prior, id: BigInt(eventSeq) });
    existingEventKeys.add(prior.eventKey);
  }

  function tableName(table: any): string { return getTableName(table); }

  const tx = {
    insert(table: any) {
      const name = tableName(table);
      return {
        values(values: Record<string, unknown>) {
          if (name === getTableName(notificationEvents)) {
            calls.eventsInsert += 1;
            const key = String(values.eventKey);
            if (existingEventKeys.has(key)) {
              throw Object.assign(new Error("Duplicate entry 'notificationEvents'"), { code: "ER_DUP_ENTRY" });
            }
            existingEventKeys.add(key);
            const id = BigInt(++eventSeq);
            eventRows.push({ ...values, id });
            return { insertId: Number(id) };
          }
          if (name === getTableName(notificationOutbox)) {
            calls.outboxInsert += 1;
            outboxRows.push(values);
            return { insertId: 9300 + outboxRows.length };
          }
          throw new Error(`unexpected insert target: ${name}`);
        },
      };
    },
    select(_fields: unknown) {
      return {
        from(table: any) {
          const name = tableName(table);
          return {
            where(_condition: unknown) {
              return {
                limit(_n: number) {
                  if (name === getTableName(notificationEvents)) {
                    calls.eventIdLookups += 1;
                    const last = eventRows[eventRows.length - 1];
                    return Promise.resolve(last ? [{
                      id: last.id, kind: last.kind, sourceType: last.sourceType,
                      sourceId: last.sourceId, transitionKey: last.transitionKey,
                      targetUserId: last.targetUserId,
                    }] : []);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };
  return { tx, calls, eventRows, outboxRows };
}

const ACTIVATION = new Date("2026-10-27T00:00:00.000Z");
const TRANSITION = new Date("2026-10-27T10:00:00.000Z");

function producer(tx: any, overrides?: {
  flags?: ReturnType<typeof readNotificationRuntimeFlags>;
  env?: Record<string, string | undefined>;
  purchaseId?: number;
  userId?: number;
  occurredAt?: Date;
}) {
  return recordEpisodeWalletPurchaseIfEnabled(tx, {
    purchaseId: overrides?.purchaseId ?? 555,
    userId: overrides?.userId ?? 7,
    flags: overrides?.flags ?? ENABLED,
    env: overrides?.env ?? {},
    occurredAt: overrides?.occurredAt ?? TRANSITION,
  });
}

describe("P3-A episode_wallet_purchased producer", () => {
  it("creates exactly 1 event + 1 outbox row addressed to the buyer on a settled purchase", async () => {
    const { tx, calls, eventRows, outboxRows } = createFakeTx();
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "created" });
    expect(String(outcome.status === "created" && outcome.eventKey)).toContain("episode_wallet_purchased");
    expect(calls.eventsInsert).toBe(1);
    expect(calls.outboxInsert).toBe(1);
    expect(eventRows[0]).toMatchObject({
      kind: "episode_wallet_purchased",
      sourceType: "episode_purchases",
      sourceId: "555",
      transitionKey: "settled",
      targetUserId: 7,
    });
    expect(outboxRows).toHaveLength(1);
  });

  it("performs zero notification SQL when notifications are disabled", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { flags: ALL_OFF });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("skips an invalid purchase or user identity without touching notification tables", async () => {
    for (const invalid of [
      { purchaseId: 0, userId: 7 },
      { purchaseId: -1, userId: 7 },
      { purchaseId: Number.NaN, userId: 7 },
      { purchaseId: 555, userId: 0 },
      { purchaseId: 555, userId: Number.NaN },
    ]) {
      const { tx, calls } = createFakeTx();
      const outcome = await producer(tx, invalid);
      expect(outcome).toMatchObject({ status: "skipped_invalid_identity" });
      expect(calls.eventsInsert).toBe(0);
      expect(calls.outboxInsert).toBe(0);
    }
  });

  it("fails closed (skips, purchase unaffected) on an invalid activation configuration while enabled", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { env: { NOTIFICATIONS_ACTIVATION_AT: "2026-02-30T00:00:00.000Z" } });
    expect(outcome).toMatchObject({ status: "skipped_invalid_activation_config" });
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("is disabled without parsing or failing on a broken activation configuration", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { flags: ALL_OFF, env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" } });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("claims the event only at/after the activation watermark (no historical backfill)", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, {
      env: { NOTIFICATIONS_ACTIVATION_AT: "2026-10-28T00:00:00.000Z" },
      occurredAt: TRANSITION,
    });
    expect(outcome).toMatchObject({ status: "skipped_before_activation" });
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("routes an identical settled event key to the dedupe outcome without a second outbox row", async () => {
    const { tx, calls, outboxRows } = createFakeTx({
      priorEvents: [{
        eventKey: "notification:v1:episode_wallet_purchased:episode_purchases:555:settled",
        kind: "episode_wallet_purchased", sourceType: "episode_purchases",
        sourceId: "555", transitionKey: "settled", targetUserId: 7,
      }],
    });
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "duplicate" });
    expect(calls.outboxInsert).toBe(0);
    expect(outboxRows).toHaveLength(0);
  });

  it("keeps distinct purchases on distinct event identities", async () => {
    const { tx, eventRows } = createFakeTx();
    expect((await producer(tx, { purchaseId: 555 })).status).toBe("created");
    expect((await producer(tx, { purchaseId: 556 })).status).toBe("created");
    expect(eventRows).toHaveLength(2);
    expect(new Set(eventRows.map((e) => e.eventKey)).size).toBe(2);
  });

  it("propagates infrastructure failures so the caller transaction can roll back (money-safe)", async () => {
    const { tx } = createFakeTx({ existingEventKeys: new Set() });
    // Simulate an infrastructure failure on the outbox insert: the fake throws
    // a non-duplicate error AFTER the event row succeeded.
    const failing = new Proxy(tx, {
      get(target, prop) {
        if (prop !== "insert") return Reflect.get(target, prop);
        return (table: any) => {
          const name = getTableName(table);
          const inner = (target as any).insert(table);
          if (name === getTableName(notificationOutbox)) {
            return { values: async () => { throw new Error("connection lost"); } };
          }
          return inner;
        };
      },
    });
    await expect(producer(failing)).rejects.toThrowError(/connection lost/);
  });
});
