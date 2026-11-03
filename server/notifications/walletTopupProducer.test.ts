import { beforeEach, describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  notificationEvents,
  notificationOutbox,
} from "./tables";
import {
  recordWalletTopupOutcomeIfEnabled,
  type WalletTopupSettlement,
} from "./walletTopupProducer";
import { readNotificationRuntimeFlags } from "./runtimeGate";

const ENABLED = readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" });
const ALL_OFF = readNotificationRuntimeFlags({});

const notificationEvents: Array<Record<string, unknown>> = [];
const notificationOutbox: Array<Record<string, unknown>> = [];
let failNotificationInsert = false;

const ACTIVATION = new Date("2026-10-27T00:00:00.000Z");
const TRANSITION = new Date("2026-10-27T12:00:00.000Z");

function makeTxHolder() {
  const counts = { eventsInsert: 0, outboxInsert: 0 };
  const seenEventKeys = new Set<string>();
  const tx: any = {
    select(_fields: unknown) {
      const last = notificationEvents[notificationEvents.length - 1];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(last ? [last] : []).then(resolve, reject),
        catch: (reject: any) => Promise.resolve([]).catch(reject),
      };
      return chain;
    },
    insert(table: any) {
      const name = getTableName(table);
      return {
        values(values: Record<string, unknown>) {
          if (name === "notificationEvents") {
            if (failNotificationInsert) throw new Error("notification insert infra failure");
            const key = String(values.eventKey);
            if (seenEventKeys.has(key)) {
              throw Object.assign(new Error(`Duplicate entry '${key}'`), { code: "ER_DUP_ENTRY" });
            }
            seenEventKeys.add(key);
            notificationEvents.push(values);
            counts.eventsInsert += 1;
            return Promise.resolve({ insertId: notificationEvents.length });
          }
          if (name === "notificationOutbox") {
            if (failNotificationInsert) throw new Error("notification insert infra failure");
            notificationOutbox.push(values);
            counts.outboxInsert += 1;
            return Promise.resolve({ insertId: notificationOutbox.length });
          }
          throw new Error(`unexpected insert target: ${name}`);
        },
      };
    },
  };
  return { tx, calls: counts };
}

function getTableName(table: any): string {
  const sqlName = (table as any)?.[Symbol.for("drizzle:Name")];
  if (typeof sqlName === "string") return sqlName;
  const direct = (table as any)?.name;
  return typeof direct === "string" ? direct : String(table);
}

function producer(tx: any, overrides?: {
  flags?: ReturnType<typeof readNotificationRuntimeFlags>;
  env?: Record<string, string | undefined>;
  topupId?: number;
  userId?: number;
  settlement?: WalletTopupSettlement;
  occurredAt?: Date;
}) {
  return recordWalletTopupOutcomeIfEnabled(tx, {
    topupId: overrides?.topupId ?? 333,
    userId: overrides?.userId ?? 7,
    settlement: overrides?.settlement ?? "credited",
    flags: overrides?.flags ?? ENABLED,
    env: overrides?.env ?? {},
    occurredAt: overrides?.occurredAt ?? TRANSITION,
  });
}

beforeEach(() => {
  notificationEvents.length = 0;
  notificationOutbox.length = 0;
  failNotificationInsert = false;
});

describe("P3-C wallet top-up producer (approved)", () => {
  it("approved settlement emits exactly one wallet_topup_approved event + outbox row to the wallet owner", async () => {
    const { tx, calls } = makeTxHolder();
    const outcome = await producer(tx, { settlement: "credited" });
    expect(outcome).toMatchObject({ status: "created" });
    expect(String(outcome.status === "created" && outcome.eventKey)).toContain("wallet_topup_approved");
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]).toMatchObject({
      kind: "wallet_topup_approved",
      sourceType: "wallet_topups",
      sourceId: "333",
      transitionKey: "credited",
      targetUserId: 7,
    });
    expect(notificationOutbox).toHaveLength(1);
    expect(calls.eventsInsert).toBe(1);
    expect(calls.outboxInsert).toBe(1);
  });

  it("rejected settlement emits wallet_topup_rejected with its own transition identity", async () => {
    const { tx } = makeTxHolder();
    const outcome = await producer(tx, { settlement: "rejected" });
    expect(outcome).toMatchObject({ status: "created" });
    expect(notificationEvents[0]).toMatchObject({
      kind: "wallet_topup_rejected",
      transitionKey: "rejected",
      targetUserId: 7,
    });
    expect(notificationOutbox).toHaveLength(1);
  });

  it("keeps approved and rejected settlements on distinct immutable event identities", async () => {
    const { tx } = makeTxHolder();
    await producer(tx, { settlement: "credited" });
    await producer(tx, { settlement: "rejected" });
    expect(notificationEvents).toHaveLength(2);
    expect(new Set(notificationEvents.map((e) => e.eventKey)).size).toBe(2);
  });

  it("performs zero notification SQL when notifications are disabled", async () => {
    const { tx, calls } = makeTxHolder();
    const outcome = await producer(tx, { flags: ALL_OFF, settlement: "credited" });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("skips an invalid topup or user identity without touching notification tables", async () => {
    for (const invalid of [
      { topupId: 0, userId: 7 },
      { topupId: -1, userId: 7 },
      { topupId: Number.NaN, userId: 7 },
      { topupId: 333, userId: 0 },
      { topupId: 333, userId: Number.NaN },
    ]) {
      const holder = makeTxHolder();
      const outcome = await producer(holder.tx, invalid);
      expect(outcome).toMatchObject({ status: "skipped_invalid_identity" });
      expect(holder.calls.eventsInsert).toBe(0);
      expect(holder.calls.outboxInsert).toBe(0);
    }
  });

  it("fails closed (skips, no event) on an invalid activation configuration while enabled", async () => {
    const holder = makeTxHolder();
    const outcome = await producer(holder.tx, {
      env: { NOTIFICATIONS_ACTIVATION_AT: "2026-02-30T00:00:00.000Z" },
      settlement: "credited",
    });
    expect(outcome).toMatchObject({ status: "skipped_invalid_activation_config" });
    expect(holder.calls.eventsInsert).toBe(0);
    expect(holder.calls.outboxInsert).toBe(0);
  });

  it("is disabled without parsing or failing on a broken activation configuration", async () => {
    const holder = makeTxHolder();
    const outcome = await producer(holder.tx, {
      flags: ALL_OFF,
      env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" },
      settlement: "credited",
    });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(holder.calls.eventsInsert).toBe(0);
  });

  it("claims the event only at/after the activation watermark (no historical backfill)", async () => {
    const holder = makeTxHolder();
    const outcome = await producer(holder.tx, {
      env: { NOTIFICATIONS_ACTIVATION_AT: "2026-10-28T00:00:00.000Z" },
      settlement: "credited",
      occurredAt: TRANSITION,
    });
    expect(outcome).toMatchObject({ status: "skipped_before_activation" });
    expect(holder.calls.eventsInsert).toBe(0);
    expect(holder.calls.outboxInsert).toBe(0);
  });

  it("routes a replayed settled event key to the dedupe outcome without a second outbox row", async () => {
    const holder = makeTxHolder();
    const first = await producer(holder.tx, { settlement: "credited" });
    expect(first).toMatchObject({ status: "created" });
    const replay = await producer(holder.tx, { settlement: "credited" });
    expect(replay).toMatchObject({ status: "duplicate" });
    expect(holder.calls.eventsInsert).toBe(1);
    expect(holder.calls.outboxInsert).toBe(1);
  });

  it("rolls back atomically when the notification insert fails mid-transaction (money-safe)", async () => {
    failNotificationInsert = true;
    const holder = makeTxHolder();
    await expect(producer(holder.tx, { settlement: "credited" }))
      .rejects.toThrowError(/notification insert infra failure/);
    expect(holder.calls.eventsInsert).toBe(0);
    expect(holder.calls.outboxInsert).toBe(0);
    failNotificationInsert = false;
  });
});
