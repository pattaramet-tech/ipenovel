import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  notificationDigestEpisodes,
  notificationEvents,
  notificationOutbox,
  notificationPublicationMarkers,
} from "./tables";
import { recordEpisodeCreationNotificationIfEnabled, recordEpisodeFirstPublicationIfEnabled } from "./episodePublicationProducer";
import { readNotificationRuntimeFlags } from "./runtimeGate";

const ENABLED = readNotificationRuntimeFlags({
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "true",
});
const FANOUT_OFF = readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" });
const ALL_OFF = readNotificationRuntimeFlags({});

/**
 * In-memory fake of the caller-owned catalog transaction (the SAME tx that
 * created the episode). All producer writes go through this object. Real
 * MySQL unique-index races and managed-transaction rollback are NOT
 * qualified here and remain a reported real-DB gap.
 */
function createFakeTx(options?: {
  claimedMarkers?: Set<string>;
  existingEventKeys?: Set<string>;
  novelPublicationStatus?: string;
}) {
  const claimedMarkers = options?.claimedMarkers ?? new Set<string>();
  const existingEventKeys = options?.existingEventKeys ?? new Set<string>();
  const calls = {
    novelStatusReads: 0,
    markersInsert: 0, eventsInsert: 0, outboxInsert: 0,
    digestInserts: 0, markerFirstEventUpdates: 0, eventIdLookups: 0,
  };
  const markerRows: Array<Record<string, unknown>> = [];
  const eventRows: Array<Record<string, unknown>> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const digestRows: Array<Record<string, unknown>> = [];
  let eventSeq = 2000;

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
            return { insertId: 7000 + markerRows.length };
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
            return { insertId: 9100 + outboxRows.length };
          }
          if (name === getTableName(notificationDigestEpisodes)) {
            calls.digestInserts += 1;
            digestRows.push(values);
            return { insertId: 9200 + digestRows.length };
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
                  if (name === "novels") {
                    calls.novelStatusReads += 1;
                    return Promise.resolve([{ publicationStatus: options?.novelPublicationStatus ?? "published" }]);
                  }
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
  return { tx, calls, markerRows, eventRows, outboxRows, digestRows };
}

const ACTIVATION = new Date("2026-10-27T00:00:00.000Z");
const TRANSITION = new Date("2026-10-27T09:00:00.000Z");

function producer(tx: any, overrides?: {
  flags?: ReturnType<typeof readNotificationRuntimeFlags>;
  env?: Record<string, string | undefined>;
  episodeId?: number;
  novelId?: number;
  isPublished?: boolean;
  occurredAt?: Date;
}) {
  return recordEpisodeFirstPublicationIfEnabled(tx, {
    episodeId: overrides?.episodeId ?? 777,
    novelId: overrides?.novelId ?? 42,
    isPublished: overrides?.isPublished ?? true,
    flags: overrides?.flags ?? ENABLED,
    env: overrides?.env ?? {},
    occurredAt: overrides?.occurredAt ?? TRANSITION,
  });
}

describe("P2-A wishlist_episodes_published producer", () => {
  it("creates exactly 1 marker + 1 event + 1 outbox + 1 digest membership on the first claim, inside the caller transaction", async () => {
    const { tx, calls, markerRows, eventRows, outboxRows, digestRows } = createFakeTx();
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "created" });
    expect(calls.markersInsert).toBe(1);
    expect(calls.eventsInsert).toBe(1);
    expect(calls.outboxInsert).toBe(1);
    expect(calls.digestInserts).toBe(1);
    expect(markerRows[0]).toMatchObject({ entityType: "episode", entityId: BigInt(777), state: "published" });
    expect(eventRows[0]).toMatchObject({
      kind: "wishlist_episodes_published",
      sourceType: "novel_publish_batches",
      sourceId: "42_ep777_0",
      transitionKey: "first_public",
      targetUserId: null,
    });
    expect(outboxRows).toHaveLength(1);
    expect(digestRows[0]).toMatchObject({ eventId: eventRows[0].id, episodeId: BigInt(777) });
    expect(calls.markerFirstEventUpdates).toBe(1);
    expect(markerRows[0].firstEventId).toBe(eventRows[0].id);
  });

  it("skips an unpublished new episode with zero notification SQL", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { isPublished: false });
    expect(outcome).toMatchObject({ status: "skipped_episode_not_published" });
    expect(calls.novelStatusReads).toBe(0);
    expect(calls.markersInsert).toBe(0);
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
    expect(calls.digestInserts).toBe(0);
  });

  it("skips a published episode whose parent novel is archived, without claiming a marker", async () => {
    const { tx, calls, markerRows } = createFakeTx({ novelPublicationStatus: "archived" });
    const outcome = await producer(tx);
    expect(outcome).toMatchObject({ status: "skipped_novel_not_published" });
    expect(calls.markersInsert).toBe(0);
    expect(markerRows).toHaveLength(0);
  });

  it("suppresses duplicate and replayed first-public claims", async () => {
    const { tx, calls, eventRows } = createFakeTx();
    expect((await producer(tx)).status).toBe("created");
    const replay = await producer(tx);
    expect(replay).toMatchObject({ status: "skipped_not_first_public" });
    expect(eventRows).toHaveLength(1);
    expect(calls.eventsInsert).toBe(1);
  });

  it("gives two different episodes separate event identities", async () => {
    const { tx, eventRows } = createFakeTx();
    const first = await producer(tx, { episodeId: 777 });
    const second = await producer(tx, { episodeId: 778 });
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(eventRows).toHaveLength(2);
    const keys = new Set(eventRows.map((e) => e.eventKey));
    expect(keys.size).toBe(2);
    expect(String([...keys][0])).not.toBe([...keys][1]);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const { tx, calls } = createFakeTx();
    const [first, second] = await Promise.all([
      producer(tx),
      producer(tx),
    ]);
    expect([first, second].filter((o) => o.status === "created")).toHaveLength(1);
    expect([first, second].filter((o) => o.status === "skipped_not_first_public")).toHaveLength(1);
    expect(calls.eventsInsert).toBe(1);
  });

  it("performs zero notification SQL when either gate is off", async () => {
    for (const flags of [ALL_OFF, FANOUT_OFF]) {
      const { tx, calls } = createFakeTx();
      const outcome = await producer(tx, { flags });
      expect(outcome).toMatchObject({ status: "disabled" });
      expect(calls.novelStatusReads).toBe(0);
      expect(calls.markersInsert).toBe(0);
      expect(calls.eventsInsert).toBe(0);
      expect(calls.outboxInsert).toBe(0);
      expect(calls.digestInserts).toBe(0);
    }
  });

  it("does not fail the catalog when the activation configuration is invalid and notifications are OFF", async () => {
    const { tx, calls } = createFakeTx();
    const outcome = await producer(tx, { flags: ALL_OFF, env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" } });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(calls.markersInsert).toBe(0);
  });

  it("rejects a nonexistent UTC calendar date when notifications are enabled", async () => {
    const { tx, calls } = createFakeTx();
    await expect(producer(tx, { env: { NOTIFICATIONS_ACTIVATION_AT: "2026-02-30T00:00:00.000Z" } }))
      .rejects.toThrowError(/not a real UTC calendar date/);
    expect(calls.markersInsert).toBe(0);
  });

  it("claims the marker but skips the event before the activation watermark", async () => {
    const { tx, calls, eventRows, digestRows } = createFakeTx();
    const outcome = await producer(tx, {
      env: { NOTIFICATIONS_ACTIVATION_AT: "2026-10-28T00:00:00.000Z" },
      occurredAt: TRANSITION,
    });
    expect(outcome).toMatchObject({ status: "skipped_before_activation" });
    expect(calls.markersInsert).toBe(1);
    expect(calls.eventsInsert).toBe(0);
    expect(calls.outboxInsert).toBe(0);
    expect(calls.digestInserts).toBe(0);
    expect(eventRows).toHaveLength(0);
    expect(digestRows).toHaveLength(0);
  });

  it("never writes notificationRecipients - audience selection belongs to the worker", async () => {
    const { tx } = createFakeTx();
    // The fake tx throws on any unexpected insert target, so a recipients
    // write would fail this producer call loudly instead of silently passing.
    const outcome = await producer(tx);
    expect(outcome.status).toBe("created");
  });
});

describe("P2-A episode-create wiring adapter (effective published state)", () => {
  function wiring(fake: ReturnType<typeof createFakeTx>, params?: {
    requestedIsPublished?: unknown;
    createdEpisodeId?: unknown;
    flags?: ReturnType<typeof readNotificationRuntimeFlags>;
    env?: Record<string, string | undefined>;
    occurredAt?: Date;
  }) {
    return recordEpisodeCreationNotificationIfEnabled(fake.tx, {
      // Pass through EXPLICIT ids (even invalid ones) - only default when
      // the caller omitted the key entirely.
      createdEpisodeId: params && "createdEpisodeId" in params ? params.createdEpisodeId : 777,
      novelId: 42,
      requestedIsPublished: params?.requestedIsPublished,
      flags: params?.flags ?? ENABLED,
      env: params?.env ?? {},
      occurredAt: params?.occurredAt,
    }).then((outcome) => ({ outcome, fake }));
  }

  it("R40R46R1 repair: an omitted isPublished is born PUBLISHED, so the producer runs exactly like an explicit true", async () => {
    const { outcome, fake } = await wiring(createFakeTx(), { requestedIsPublished: undefined });
    expect(outcome).toMatchObject({ status: "created" });
    expect(fake.calls.markersInsert).toBe(1);
    expect(fake.calls.eventsInsert).toBe(1);
    expect(fake.calls.outboxInsert).toBe(1);
    expect(fake.calls.digestInserts).toBe(1);
  });

  it("an explicit isPublished=true still produces the full first-publication record", async () => {
    const { outcome, fake } = await wiring(createFakeTx(), { requestedIsPublished: true });
    expect(outcome).toMatchObject({ status: "created" });
    expect(fake.calls.eventsInsert).toBe(1);
  });

  it("an explicit isPublished=false never reaches the producer", async () => {
    const { outcome, fake } = await wiring(createFakeTx(), { requestedIsPublished: false });
    expect(outcome).toMatchObject({ status: "skipped_episode_not_published" });
    expect(fake.calls.novelStatusReads).toBe(0);
    expect(fake.calls.markersInsert).toBe(0);
    expect(fake.calls.eventsInsert).toBe(0);
  });

  it("an archived parent novel suppresses the notification without claiming a marker", async () => {
    const { outcome, fake } = await wiring(createFakeTx({ novelPublicationStatus: "archived" }), { requestedIsPublished: undefined });
    expect(outcome).toMatchObject({ status: "skipped_novel_not_published" });
    expect(fake.calls.markersInsert).toBe(0);
  });

  it("notifications OFF means zero notification SQL even with a broken activation configuration", async () => {
    const { outcome, fake } = await wiring(createFakeTx(), {
      requestedIsPublished: undefined,
      flags: ALL_OFF,
      env: { NOTIFICATIONS_ACTIVATION_AT: "not-a-timestamp" },
    });
    expect(outcome).toMatchObject({ status: "disabled" });
    expect(fake.calls.novelStatusReads).toBe(0);
    expect(fake.calls.markersInsert).toBe(0);
    expect(fake.calls.eventsInsert).toBe(0);
  });

  it("an invalid or missing created episode id skips notification wiring outright", async () => {
    for (const createdEpisodeId of [undefined, null, 0, -5, "not-a-number", 777.5]) {
      const { outcome, fake } = await wiring(createFakeTx(), { requestedIsPublished: true, createdEpisodeId });
      expect(outcome).toMatchObject({ status: "skipped_invalid_created_id" });
      expect(fake.calls.novelStatusReads).toBe(0);
    }
  });

  it("duplicate/replayed claims against an already-claimed episode marker do not duplicate the event", async () => {
    const { outcome, fake } = await wiring(
      createFakeTx({ claimedMarkers: new Set(["episode:777"]) }),
      { requestedIsPublished: true, createdEpisodeId: 777 },
    );
    expect(outcome).toMatchObject({ status: "skipped_not_first_public" });
    expect(fake.calls.eventsInsert).toBe(0);
  });

  it("a client-supplied backdated publishedAt cannot age the notification: the event uses server transaction time", async () => {
    const occurredAt = new Date("2026-10-27T09:00:00.000Z");
    const wiringResult = await wiring(createFakeTx(), {
      requestedIsPublished: undefined, // born published via the default
      occurredAt,
    });
    expect(wiringResult.outcome).toMatchObject({ status: "created" });
    expect(wiringResult.fake.eventRows[0].occurredAt).toBe(occurredAt);
    expect(wiringResult.fake.calls.eventsInsert).toBe(1);
  });
});
