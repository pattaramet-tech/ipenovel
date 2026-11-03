import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  notificationEvents,
  notificationOutbox,
  notificationPublicationMarkers,
} from "./tables";
import {
  recordNovelFirstPublicationIfEnabled,
  resolveNotificationsActivationAt,
} from "./novelPublicationProducer";
import { readNotificationRuntimeFlags } from "./runtimeGate";

const ENABLED = readNotificationRuntimeFlags({
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "true",
});
const FANOUT_OFF = readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" });
const ALL_OFF = readNotificationRuntimeFlags({});

/**
 * In-memory fake of the caller-owned business transaction. Every producer
 * write goes through THIS object, so "same transaction" claims below are
 * provable at the unit level. Real MySQL concurrency (unique index races,
 * live rollback) is NOT qualified here and is reported as an unverified-SQL
 * gap in the round report.
 */
function createFakeTx(options?: {
  claimedMarkers?: Set<string>;
  existingEventKeys?: Set<string>;
  priorEvents?: Array<{ eventKey: string; kind: string; sourceType: string; sourceId: string; transitionKey: string; targetUserId: number | null }>;
}) {
  const claimedMarkers = options?.claimedMarkers ?? new Set<string>();
  const existingEventKeys = options?.existingEventKeys ?? new Set<string>();
  const calls = {
    markersInsert: 0, eventsInsert: 0, outboxInsert: 0,
    markerFirstEventUpdates: 0, eventIdLookups: 0,
  };
  const markerRows: Array<Record<string, unknown>> = [];
  const eventRows: Array<Record<string, unknown>> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  let eventSeq = 1000;
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
          if (name === getTableName(notificationPublicationMarkers)) {
            calls.markersInsert += 1;
            const key = `${values.entityType}:${values.entityId}`;
            if (claimedMarkers.has(key)) {
              throw Object.assign(new Error("Duplicate entry 'notificationPublicationMarkers'"), { code: "ER_DUP_ENTRY" });
            }
            claimedMarkers.add(key);
            markerRows.push(values);
            return { insertId: 5000 + markerRows.length };
          }
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
            return { insertId: 9000 + outboxRows.length };
          }
          throw new Error(`unexpected insert target: ${name}`);
        },
      };
    },
    update(table: any) {
      const name = tableName(table);
      return {
        set(values: Record<string, unknown>) {
          return {
            where(_condition: unknown) {
              if (name === getTableName(notificationPublicationMarkers)) {
                calls.markerFirstEventUpdates += 1;
                for (const row of markerRows) {
                  if ("firstEventId" in values) row.firstEventId = values.firstEventId;
                }
              }
              return Promise.resolve({ affectedRows: 1 });
            },
          };
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
  return { tx, calls, markerRows, eventRows, outboxRows };
}

const TRANSITION = new Date("2026-10-27T08:00:00.000Z");

function producer(tx: any, overrides?: {
  flags?: ReturnType<typeof readNotificationRuntimeFlags>;
  env?: Record<string, string | undefined>;
  occurredAt?: Date;
  novelId?: number;
}) {
  return recordNovelFirstPublicationIfEnabled(tx, {
    novelId: overrides?.novelId ?? 42,
    flags: overrides?.flags ?? ENABLED,
    env: overrides?.env ?? {},
    occurredAt: overrides?.occurredAt ?? TRANSITION,
  });
}

describe("P1 disabled-gate safety (hardened)", () => {
  it("when notifications are OFF, an invalid activation configuration must not block the catalog publication and no SQL runs", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { flags: ALL_OFF, env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" } });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.markersInsert).toBe(0);
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("when only catalog fanout is OFF, no notification SQL runs regardless of activation configuration", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { flags: FANOUT_OFF, env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" } });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.markersInsert).toBe(0);
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
  });

  it("the flags snapshot is decided by the caller: an environment flipped on afterwards cannot activate the producer", async () => {
    const env: Record<string, string | undefined> = {};
    const flags = readNotificationRuntimeFlags(env);
    const { tx, calls } = createFakeTx();
    env.NOTIFICATIONS_ENABLED = "true";
    env.NOTIFICATIONS_CATALOG_FANOUT_ENABLED = "true";
    const outcome = await producer(tx, { flags });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.markersInsert).toBe(0);
  });
});

describe("P1 activation watermark (strict UTC, resolved only after the gates)", () => {
  it("unset configuration falls back to the transition instant so a live transition is deliverable", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "created" });
    expect(calls.eventsInsert).toBe(1);
  });

  it("a pinned future watermark claims the marker but skips the event (no historical backfill)", async () => {
    const { tx, calls, eventRows, outboxRows } = createFakeTx();
    const outcome = await producer(tx, {
      env: { NOTIFICATIONS_ACTIVATION_AT: "2026-10-28T00:00:00.000Z" },
      occurredAt: TRANSITION,
    });
    expect(outcome).toMatchObject({ status: "skipped_before_activation" });
    expect(calls.markersInsert).toBe(1);
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
    expect(eventRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it("rejects non-UTC or naive timestamps loudly when notifications are enabled", () => {
    const invalid = ["2026-10-27", "2026-10-27T08:00:00", "2026-10-27T08:00:00+07:00", "not-a-timestamp", "2026-10-27T08:00:00.000+00:00"];
    for (const value of invalid) {
      try {
        resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: value }, TRANSITION);
        expect.unreachable(`configuration ${value} must be rejected`);
      } catch (error) {
        expect((error as Error).message).toContain("NOTIFICATIONS_ACTIVATION_AT");
      }
    }
    expect(resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: "2026-10-27T08:00:00.000Z" }, TRANSITION))
      .toEqual(new Date("2026-10-27T08:00:00.000Z"));
    expect(resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: "2026-10-27T08:00:00Z" }, TRANSITION))
      .toEqual(new Date("2026-10-27T08:00:00.000Z"));
  });

  it("rejects nonexistent UTC calendar dates via component round-trip", () => {
    const invalid = ["2026-02-30T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "2026-04-31T12:00:00Z", "2026-06-31T00:00:00.500Z"];
    for (const value of invalid) {
      try {
        resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: value }, TRANSITION);
        expect.unreachable(`nonexistent calendar date ${value} must be rejected`);
      } catch (error) {
        expect((error as Error).message).toContain("not a real UTC calendar date");
      }
    }
    // A real leap-year day and a real date round-trip cleanly.
    expect(resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: "2024-02-29T12:30:00.250Z" }, TRANSITION))
      .toEqual(new Date("2024-02-29T12:30:00.250Z"));
    expect(resolveNotificationsActivationAt({ NOTIFICATIONS_ACTIVATION_AT: "2026-02-28T23:59:59.999Z" }, TRANSITION))
      .toEqual(new Date("2026-02-28T23:59:59.999Z"));
  });
});

describe("P1 first-publication semantics", () => {
  it("creates exactly 1 marker + 1 event + 1 outbox row on the proven first-public transition, inside the caller transaction", async () => {
    const { tx, calls, markerRows, eventRows, outboxRows } = createFakeTx();
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "created" });
    expect(String(outcome.status === "created" && outcome.eventKey)).toContain("novel_published");
    expect(calls.markersInsert).toBe(1);
    expect(calls.eventsInsert).toBe(1);
    expect(calls.outboxInsert).toBe(1);
    expect(markerRows).toHaveLength(1);
    expect(markerRows[0]).toMatchObject({ entityType: "novel", entityId: BigInt(42), state: "published" });
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({ kind: "novel_published", sourceType: "novels", sourceId: "42", targetUserId: null });
    expect(outboxRows).toHaveLength(1);
    expect(calls.markerFirstEventUpdates).toBe(1);
    expect(markerRows[0].firstEventId).toBe(eventRows[0].id);
  });

  it("suppresses emission when the marker is already claimed (duplicate publish / republish)", async () => {
    const { tx, calls, eventRows, outboxRows } = createFakeTx();
    expect((await producer(tx)).status).toBe("created");
    const second = await producer(tx);
    expect(second).toMatchObject({ status: "skipped_not_first_public" });
    expect(calls.eventsInsert).toBe(1);
    expect(calls.outboxInsert).toBe(1);
    expect(eventRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
  });

  it("lets exactly one of two concurrent first-public claims win", async () => {
    const { tx, calls } = createFakeTx();
    const [first, second] = await Promise.all([
      producer(tx),
      producer(tx),
    ]);
    expect([first, second].filter((o) => o.status === "created")).toHaveLength(1);
    expect([first, second].filter((o) => o.status === "skipped_not_first_public")).toHaveLength(1);
    expect(calls.eventsInsert).toBe(1);
  });

  it("routes an existing identical event key to the dedupe outcome without a second outbox row", async () => {
    const { tx, calls, outboxRows } = createFakeTx({
      priorEvents: [{
        eventKey: "notification:v1:novel_published:novels:42:first_public",
        kind: "novel_published", sourceType: "novels", sourceId: "42",
        transitionKey: "first_public", targetUserId: null,
      }],
    });
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "duplicate" });
    expect(calls.outboxInsert).toBe(0);
    expect(outboxRows).toHaveLength(0);
  });

  it("throws on an event-key identity collision instead of silently deduping", async () => {
    const { tx } = createFakeTx({
      priorEvents: [{
        eventKey: "notification:v1:novel_published:novels:42:first_public",
        kind: "order_completed", sourceType: "orders", sourceId: "42",
        transitionKey: "first_public", targetUserId: null,
      }],
    });
    await expect(producer(tx)).rejects.toThrowError(/identity collision/);
  });

  it("rejects an invalid novel identity outright", async () => {
    const { tx, calls } = createFakeTx();
    await expect(producer(tx, { novelId: 0 })).rejects.toThrowError(/novel publication identity/);
    expect(calls.markersInsert).toBe(0);
  });
});
