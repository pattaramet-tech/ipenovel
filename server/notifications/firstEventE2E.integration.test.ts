/**
 * R40R85 — FIRST-EVENT E2E for wishlist_episodes_published, on the
 * identity-verified disposable MySQL (ipenovel_test) only.
 *
 * THE one missing integration seam this suite proves: the REAL business API
 * (tRPC episode.create) drives the transactional producer so that
 * event + outbox + digest + publication marker + episode land in ONE
 * transaction, a same-identity replay creates nothing, and a one-shot
 * scheduler tick delivers to exactly the eligible audience (pre-event
 * follower, opted-in by default; excludes non-followers, late followers,
 * opted-out users and the author) into the real inbox with a real unread
 * count.
 *
 * R40R85R1 cleanup repair: the cleanup is fail-loud (never swallows errors),
 * finds event/outbox rows by SOURCE IDENTITY even when an assertion failed
 * before the eventKey was registered, deletes in foreign-key order scoped to
 * this run's fixtures only, then VERIFIES zero leftovers and THROWS with the
 * identifying rows if anything remains.
 *
 * R40R85R2 integrity repair:
 *   - source-identity sweep uses an ESCAPED LIKE (`{novelId}\_%`) so the
 *     `_` can never act as a single-character wildcard: a longer novel id
 *     whose digits EXTEND ours (novel 1239 against our novel 123) can no
 *     longer be matched and deleted by our cleanup (regression-tested);
 *   - `notificationDigestEpisodes` rows are deleted and verified per
 *     event BEFORE the events themselves;
 *   - every fixture id is registered immediately after creation;
 *   - leftover verification covers every tracked id (outbox, digest,
 *     markers, recipients, preferences, users) and tracked state is cleared
 *     only after verification succeeds - a failed cleanup keeps its
 *     diagnostic identifiers;
 *   - the neighbour fixture in the failure-path test tears down through
 *     try/finally even when assertions fail mid-way.
 */
import "./firstEventE2EEnv";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import {
  episodes,
  notificationDigestEpisodes,
  notificationEvents,
  notificationOutbox,
  notificationPreferences,
  notificationPublicationMarkers,
  notificationRecipients,
  novels,
  users,
  wishlists,
} from "../../drizzle/schema";
import { ensureVerifiedTestDb, getTestDb } from "../test-helpers/testDb";
import { createTestEpisode, createTestUser, deleteFixtures, uniqueTestTag } from "../test-helpers/fixtures";
import { recordEpisodeCreationNotificationIfEnabled } from "./episodePublicationProducer";
import { readNotificationRuntimeFlags } from "./runtimeGate";

function authorContext(id: number, name: string): TrpcContext {
  return {
    user: {
      id,
      openId: `r85-author-${id}`,
      email: `r85-author-${id}@example.test`,
      name,
      loginMethod: "test",
      role: "author",
    },
  } as TrpcContext;
}

function readerContext(id: number, tag: string): TrpcContext {
  return {
    user: {
      id,
      openId: `r85-reader-${tag}`,
      email: `r85-reader-${tag}@example.test`,
      name: `R85 Reader ${tag}`,
      loginMethod: "test",
      role: "user",
    },
  } as TrpcContext;
}

const SCRIPT = "scripts/notifications-tick.ts";

function spawnTick(): { code: number; stdout: string; stderr: string } {
  const env = {
    ...process.env,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL!,
    DEPLOYMENT_ENVIRONMENT: "local-test",
    NOTIFICATIONS_ENABLED: "true",
    NOTIFICATIONS_DELIVERY_ENABLED: "true",
    NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "true",
    NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED: "false",
  };
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT], {
      env,
      timeout: 90_000,
      encoding: "utf8",
      cwd: new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error: any) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

// Scope of THIS test run, registered IMMEDIATELY after each fixture is
// created so a mid-test failure still leaves a complete cleanup map.
const tracked = {
  eventKeys: [] as string[],
  userIds: [] as number[],
  novelIds: [] as number[],
  episodeIds: [] as number[],
};

interface CleanupReport {
  deletedEvents: number;
  deletedOutbox: number;
  deletedRecipients: number;
  deletedDigests: number;
  deletedMarkers: number;
  leftovers: Record<string, number>;
}

/**
 * R40R85R2: removes exactly this run's fixtures, in foreign-key order, and
 * FAILS LOUDLY (throws with identifying rows) when:
 *   - any delete statement errors (nothing is swallowed), or
 *   - any scoped row remains after deletion (events, outbox, digest
 *     episodes, recipients, publication markers/digests, wishlists,
 *     episodes, novels, preferences, users).
 *
 * Event discovery is scoped with an ESCAPED prefix match
 * (`{novelId}\_%` with `\` as the escape character), so an underscore is a
 * literal underscore: cleanup for novel 123 can never match rows belonging
 * to novel 1239 (or any id whose digits merely extend ours).
 *
 * Tracked state is cleared ONLY after verification succeeds; when the
 * cleanup fails, the thrown error carries the identifying rows and the
 * fixtures stay in the database for inspection.
 */
async function cleanupTracked(): Promise<CleanupReport> {
  const t = getTestDb();
  const novelIds = [...new Set(tracked.novelIds)];
  const deletedEventIds: bigint[] = [];
  const report: CleanupReport = {
    deletedEvents: 0, deletedOutbox: 0, deletedRecipients: 0, deletedDigests: 0, deletedMarkers: 0,
    leftovers: {},
  };

  try {
    // 1. Events under THIS run's novels, discovered by exact-prefix source
    // identity (escaped underscore). Robust even when a mid-test failure
    // prevented eventKey registration.
    for (const novelId of novelIds) {
      const scopedEvents = await t
        .select({ id: notificationEvents.id, eventKey: notificationEvents.eventKey })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            eq(notificationEvents.sourceType, "novel_publish_batches"),
            novelBatchPrefix(novelId),
          ),
        );
      for (const ev of scopedEvents) {
        deletedEventIds.push(ev.id);
        // digest episodes FIRST (children of the event)
        const digests = await t
          .delete(notificationDigestEpisodes)
          .where(eq(notificationDigestEpisodes.eventId, ev.id));
        report.deletedDigests += affectedRows(digests);
        const recipients = await t
          .delete(notificationRecipients)
          .where(eq(notificationRecipients.eventId, ev.id));
        report.deletedRecipients += affectedRows(recipients);
        const outbox = await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, ev.id));
        report.deletedOutbox += affectedRows(outbox);
        const removed = await t.delete(notificationEvents).where(eq(notificationEvents.id, ev.id));
        report.deletedEvents += affectedRows(removed);
      }
    }
    // Defensive eventKey path (rows registered through assertions).
    for (const key of tracked.eventKeys) {
      const rows = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(eq(notificationEvents.eventKey, key));
      for (const row of rows) {
        if (deletedEventIds.some(id => id === row.id)) continue;
        deletedEventIds.push(row.id);
        const digests = await t
          .delete(notificationDigestEpisodes)
          .where(eq(notificationDigestEpisodes.eventId, row.id));
        report.deletedDigests += affectedRows(digests);
        const recipients = await t
          .delete(notificationRecipients)
          .where(eq(notificationRecipients.eventId, row.id));
        report.deletedRecipients += affectedRows(recipients);
        const outbox = await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id));
        report.deletedOutbox += affectedRows(outbox);
        const removed = await t.delete(notificationEvents).where(eq(notificationEvents.id, row.id));
        report.deletedEvents += affectedRows(removed);
      }
    }

    // 2. Episode publication markers, then the episode rows themselves.
    for (const episodeId of tracked.episodeIds) {
      const markers = await t
        .delete(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "episode"),
            eq(notificationPublicationMarkers.entityId, BigInt(episodeId)),
          ),
        );
      report.deletedMarkers += affectedRows(markers);
    }
    for (const novelId of novelIds) {
      await t.delete(episodes).where(eq(episodes.novelId, novelId));
    }

    // 3. Novel publication markers, wishlists, then the novel rows.
    for (const novelId of novelIds) {
      const markers = await t
        .delete(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "novel"),
            eq(notificationPublicationMarkers.entityId, BigInt(novelId)),
          ),
        );
      report.deletedMarkers += affectedRows(markers);
      await t.delete(wishlists).where(eq(wishlists.novelId, novelId));
      await t.delete(novels).where(eq(novels.id, novelId));
    }

    // 4. Preferences, then the user fixtures (last - everything above may
    // reference them).
    for (const userId of tracked.userIds) {
      await t.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
      await t.delete(notificationRecipients).where(eq(notificationRecipients.userId, userId));
      await deleteFixtures({ userIds: [userId] });
    }
  } catch (error) {
    throw new Error(
      `R40R85R2 CLEANUP FAILED while deleting (fixtures left in ipenovel_test for inspection; ` +
        `scope novelIds=${JSON.stringify(novelIds)} episodeIds=${JSON.stringify(tracked.episodeIds)} ` +
        `userIds=${JSON.stringify(tracked.userIds)}): ${(error as Error).message}`,
    );
  }

  // 5. Verify zero leftovers across EVERY tracked id - outbox, digest,
  // recipients, digest/markers included. Any survivor is listed with its
  // identifiers and the cleanup is reported as failed.
  const leftovers: Record<string, number> = {};
  const identifiers: Record<string, unknown[]> = {};
  const pushLeftover = (table: string, rows: Array<{ label: string; id: unknown }>) => {
    if (rows.length > 0) {
      leftovers[table] = rows.length;
      identifiers[table] = rows.map(r => r.label);
    }
  };
  if (deletedEventIds.length > 0) {
    const ids = deletedEventIds.map(id => id.toString());
    const outboxRows = await t
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(inArray(notificationOutbox.eventId, deletedEventIds));
    pushLeftover("outbox", outboxRows.map(r => ({ label: `outbox:${r.id}`, id: r.id })));
    const digestRows = await t
      .select({ id: notificationDigestEpisodes.id, eventId: notificationDigestEpisodes.eventId })
      .from(notificationDigestEpisodes)
      .where(inArray(notificationDigestEpisodes.eventId, deletedEventIds));
    pushLeftover("digest_episodes", digestRows.map(r => ({ label: `digest:event${r.eventId}`, id: r.id })));
    const recipientRows = await t
      .select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(inArray(notificationRecipients.eventId, deletedEventIds));
    pushLeftover("recipients", recipientRows.map(r => ({ label: `recipient:${r.id}`, id: r.id })));
  }
  if (novelIds.length > 0) {
    const novelRows = await t
      .select({ id: novels.id })
      .from(novels)
      .where(inArray(novels.id, novelIds));
    pushLeftover("novels", novelRows.map(r => ({ label: `novel:${r.id}`, id: r.id })));
    const episodeRows = await t
      .select({ id: episodes.id })
      .from(episodes)
      .where(inArray(episodes.novelId, novelIds));
    pushLeftover("episodes", episodeRows.map(r => ({ label: `episode:${r.id}`, id: r.id })));
    const wishlistRows = await t
      .select({ id: wishlists.id })
      .from(wishlists)
      .where(inArray(wishlists.novelId, novelIds));
    pushLeftover("wishlists", wishlistRows.map(r => ({ label: `wishlist:${r.id}`, id: r.id })));
    for (const novelId of novelIds) {
      const eventRows = await t
        .select({ id: notificationEvents.id, eventKey: notificationEvents.eventKey })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            eq(notificationEvents.sourceType, "novel_publish_batches"),
            novelBatchPrefix(novelId),
          ),
        );
      pushLeftover(`events(novel ${novelId})`, eventRows.map(r => ({ label: r.eventKey, id: r.id })));
      const novelMarkerRows = await t
        .select({ entityId: notificationPublicationMarkers.entityId })
        .from(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "novel"),
            eq(notificationPublicationMarkers.entityId, BigInt(novelId)),
          ),
        );
      pushLeftover(`novel_markers(${novelId})`, novelMarkerRows.map(r => ({ label: `marker:${r.entityId}`, id: r.entityId })));
    }
    if (tracked.episodeIds.length > 0) {
      const episodeMarkerRows = await t
        .select({ entityId: notificationPublicationMarkers.entityId })
        .from(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "episode"),
            inArray(notificationPublicationMarkers.entityId, tracked.episodeIds.map(id => BigInt(id))),
          ),
        );
      pushLeftover("episode_markers", episodeMarkerRows.map(r => ({ label: `marker:${r.entityId}`, id: r.entityId })));
    }
  }
  for (const userId of tracked.userIds) {
    const prefRows = await t
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
    pushLeftover(`prefs(user ${userId})`, prefRows.map(r => ({ label: `pref:${r.id}`, id: r.id })));
    const recipientRows = await t
      .select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(eq(notificationRecipients.userId, userId));
    pushLeftover(`recipients(user ${userId})`, recipientRows.map(r => ({ label: `recipient:${r.id}`, id: r.id })));
    const userRows = await t
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    pushLeftover(`users(user ${userId})`, userRows.map(r => ({ label: `user:${r.id}`, id: r.id })));
  }

  report.leftovers = leftovers;
  if (Object.keys(leftovers).length > 0) {
    // Tracked state deliberately NOT cleared: the identifiers above remain
    // the diagnostic record of what is still in the database.
    throw new Error(
      `R40R85R2 CLEANUP INCOMPLETE - rows remain in ipenovel_test and MUST be inspected: ` +
        JSON.stringify({ leftovers, identifiers }, null, 2),
    );
  }

  // Clear tracked state only after a verified-complete cleanup.
  tracked.eventKeys.length = 0;
  tracked.userIds.length = 0;
  tracked.novelIds.length = 0;
  tracked.episodeIds.length = 0;
  return report;
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const n = (header as { affectedRows?: number } | null)?.affectedRows;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Escaped prefix condition for events of ONE novel: `{novelId}\_%` with an
 * explicit ESCAPE clause, so the `_` is a LITERAL underscore and a longer
 * novel id whose digits merely extend ours (1239 vs 123) can never match.
 * Raw `sql` template is REQUIRED here - drizzle's like() strips the
 * backslash from the bound parameter, silently reintroducing the wildcard.
 */
function novelBatchPrefix(novelId: number) {
  return sql`${notificationEvents.sourceId} like ${`${novelId}\\_%`} escape '\\\\'`;
}

/** Insert a bare wishlist_episodes_published event row (regression probe). */
async function insertProbeEvent(
  t: Awaited<ReturnType<typeof ensureVerifiedTestDb>>,
  sourceId: string,
): Promise<string> {
  const eventKey = `r85r2-collision-${uniqueTestTag("probe")}`;
  const now = new Date();
  await t.insert(notificationEvents).values({
    eventKey,
    kind: "wishlist_episodes_published",
    sourceType: "novel_publish_batches",
    sourceId,
    transitionKey: "collision_probe",
    targetUserId: null,
    occurredAt: now,
    eligibleAfter: now,
  });
  return eventKey;
}

interface NeighbourState {
  authorId?: number;
  novelId?: number;
  episodeId?: number;
  eventId?: bigint;
  extraUserIds: number[];
}

/**
 * R40R85R3/R40R85R3A: guaranteed teardown of a failure-path neighbour
 * fixture. Foreign-key order, exact ids of THIS fixture only, and nothing
 * is swallowed - every failing step is collected and the function throws
 * with every id that remains.
 *
 * R40R85R3A guard: when the producer already committed but the eventId was
 * never recorded (a crash between the commit and the registration), the
 * novel's events are discovered through the collision-safe source identity
 * (escaped prefix, see novelBatchPrefix) and torn down in the order
 * digest -> recipients -> outbox -> event.
 */
async function teardownNeighbourFixture(
  t: Awaited<ReturnType<typeof ensureVerifiedTestDb>>,
  neighbour: NeighbourState,
): Promise<void> {
  const teardownErrors: string[] = [];
  const eventIds: bigint[] = [];
  if (neighbour.eventId !== undefined) {
    eventIds.push(neighbour.eventId);
  } else if (neighbour.novelId !== undefined) {
    try {
      const discovered = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            eq(notificationEvents.sourceType, "novel_publish_batches"),
            novelBatchPrefix(neighbour.novelId),
          ),
        );
      for (const ev of discovered) eventIds.push(ev.id);
    } catch (error) {
      teardownErrors.push(`event discovery(novel ${neighbour.novelId}): ${(error as Error).message}`);
    }
  }

  const steps: Array<[string, () => Promise<void>]> = [];
  for (const eventId of eventIds) {
    steps.push([`digest(event ${eventId})`, async () => {
      await t.delete(notificationDigestEpisodes).where(eq(notificationDigestEpisodes.eventId, eventId));
    }]);
    steps.push([`recipients(event ${eventId})`, async () => {
      await t.delete(notificationRecipients).where(eq(notificationRecipients.eventId, eventId));
    }]);
    steps.push([`outbox(event ${eventId})`, async () => {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, eventId));
    }]);
    steps.push([`event(${eventId})`, async () => {
      await t.delete(notificationEvents).where(eq(notificationEvents.id, eventId));
    }]);
  }
  if (neighbour.episodeId !== undefined) {
    steps.push(["episode_marker", async () => {
      await t
        .delete(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "episode"),
            eq(notificationPublicationMarkers.entityId, BigInt(neighbour.episodeId!)),
          ),
        );
    }]);
    steps.push(["episode", async () => {
      await t.delete(episodes).where(eq(episodes.id, neighbour.episodeId!));
    }]);
  }
  if (neighbour.novelId !== undefined) {
    steps.push(["wishlists", async () => {
      await t.delete(wishlists).where(eq(wishlists.novelId, neighbour.novelId!));
    }]);
    steps.push(["novel", async () => {
      await t.delete(novels).where(eq(novels.id, neighbour.novelId!));
    }]);
  }
  const userIds = [neighbour.authorId, ...neighbour.extraUserIds].filter((id): id is number => typeof id === "number");
  if (userIds.length > 0) {
    steps.push(["users", async () => {
      await deleteFixtures({ userIds });
    }]);
  }
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (error) {
      teardownErrors.push(`${label}: ${(error as Error).message}`);
    }
  }
  if (teardownErrors.length > 0) {
    throw new Error(
      `R40R85R3A NEIGHBOUR TEARDOWN FAILED - ids left in ipenovel_test for inspection ` +
        `(novelId=${neighbour.novelId ?? "none"} episodeId=${neighbour.episodeId ?? "none"} ` +
        `eventIds=${JSON.stringify(eventIds.map(id => id.toString()))} userIds=${JSON.stringify(userIds)}): ` +
        teardownErrors.join(" | "),
    );
  }
}

describe("R40R85 first-event E2E: wishlist_episodes_published (business API -> producer -> one-shot delivery)", () => {
  afterEach(async () => {
    // A cleanup failure must fail this suite - it is never swallowed, and
    // the error carries the identifying rows.
    await cleanupTracked();
  });

  it("creates event+outbox+digest+marker through the REAL episode.create API, replays as skipped_not_first_public, and delivers to exactly the pre-event opted-in follower", async () => {
    // Phase 0: verified disposable identity - live DATABASE() must be
    // ipenovel_test before anything else runs (no DATABASE_URL fallback).
    await ensureVerifiedTestDb();
    const t = getTestDb();
    const testDbUrl = new URL(process.env.TEST_DATABASE_URL!);
    expect(testDbUrl.pathname).toBe("/ipenovel_test");

    // ---- fixtures (each id registered immediately) ---------------------
    const author = await createTestUser({ role: "author" });
    tracked.userIds.push(author.id);
    const r1FollowBefore = await createTestUser();
    tracked.userIds.push(r1FollowBefore.id);
    const r2NonFollower = await createTestUser();
    tracked.userIds.push(r2NonFollower.id);
    const r3LateFollower = await createTestUser();
    tracked.userIds.push(r3LateFollower.id);
    const r4OptedOut = await createTestUser();
    tracked.userIds.push(r4OptedOut.id);

    const novel = await createTestNovelDirect(t, author.id);
    tracked.novelIds.push(novel.id);

    // pre-event followers: provably before ANY event (an hour in the past)
    const beforeEvent = new Date(Date.now() - 3_600_000);
    await t.insert(wishlists).values({ userId: r1FollowBefore.id, novelId: novel.id, createdAt: beforeEvent });
    await t.insert(wishlists).values({ userId: r4OptedOut.id, novelId: novel.id, createdAt: beforeEvent });

    // R4 opts out through the REAL preferences endpoint, well before the event.
    const callerR4 = appRouter.createCaller(readerContext(r4OptedOut.id, uniqueTestTag("r4")));
    await callerR4.notifications.setPreference({ kind: "wishlist_episodes_published", enabled: false });
    // second-resolution DATETIME truncation: guarantee strictly-earlier ordering
    await new Promise(resolve => setTimeout(resolve, 1_500));

    // ---- Phase 1: business API -> event + outbox + digest + marker -----
    const callerAuthor = appRouter.createCaller(authorContext(author.id, "R85 Author"));
    const created = (await callerAuthor.admin.episodes.create({
      novelId: novel.id,
      episodeNumber: uniqueTestTag("ep"),
      title: "R85 First Event Episode",
      price: "0",
      isFree: true,
    })) as { id?: number };
    expect(typeof created?.id).toBe("number");
    const episodeId = Number(created!.id);
    tracked.episodeIds.push(episodeId);

    // The event the API produced (sourceId = `{novelId}_{batchKey}_{partIndex}`):
    const eventRows = await t
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.kind, "wishlist_episodes_published"),
          eq(notificationEvents.sourceType, "novel_publish_batches"),
          eq(notificationEvents.sourceId, `${novel.id}_ep${episodeId}_0`),
        ),
      );
    expect(eventRows.length).toBe(1);
    const event = eventRows[0];
    tracked.eventKeys.push(event.eventKey);
    expect(event.targetUserId).toBeNull(); // public-novel fanout shape

    const outboxRows = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, event.id));
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].state).toBe("pending");
    expect(outboxRows[0].attempt).toBe(0);
    expect(outboxRows[0].leaseToken).toBeNull();

    // digest episodes: the producer registered this event's episode list
    const digestRows = await t
      .select({ id: notificationDigestEpisodes.id, episodeId: notificationDigestEpisodes.episodeId })
      .from(notificationDigestEpisodes)
      .where(eq(notificationDigestEpisodes.eventId, event.id));
    expect(digestRows.length).toBe(1);
    expect(digestRows[0].episodeId).toBe(BigInt(episodeId));

    const markerRows = await t
      .select()
      .from(notificationPublicationMarkers)
      .where(and(eq(notificationPublicationMarkers.entityType, "episode"), eq(notificationPublicationMarkers.entityId, BigInt(episodeId))));
    expect(markerRows.length).toBe(1);

    // the episode row itself really exists (transactional join with business write)
    const episodeRows = await t.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episodeRows.length).toBe(1);
    expect(episodeRows[0].isPublished).toBe(true);

    // ---- Phase 2: same-identity replay -> skipped_not_first_public ----
    const replay = await t.transaction((tx: any) =>
      recordEpisodeCreationNotificationIfEnabled(tx, {
        createdEpisodeId: episodeId,
        novelId: novel.id,
        requestedIsPublished: true,
        flags: readNotificationRuntimeFlags(process.env),
        env: process.env,
      }),
    );
    expect(replay).toEqual({ status: "skipped_not_first_public" });
    const eventsAfterReplay = await t
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, event.eventKey));
    expect(eventsAfterReplay.length).toBe(1);

    // ---- negative fixture: R3 follows AFTER the event -----------------
    await t.insert(wishlists).values({
      userId: r3LateFollower.id,
      novelId: novel.id,
      createdAt: new Date(event.occurredAt.getTime() + 3_600_000),
    });

    // ---- Phase 3: one-shot scheduler delivery --------------------------
    const tick = spawnTick();
    expect(tick.code).toBe(0);
    expect(tick.stdout).toContain('"status":"completed"');
    expect(tick.stdout).toContain('"recipientsCreated":1');

    // recipient: EXACTLY R1 - author, non-follower, late follower and
    // opted-out user must all be absent.
    const recipients = await t
      .select({ userId: notificationRecipients.userId })
      .from(notificationRecipients)
      .where(eq(notificationRecipients.eventId, event.id));
    expect(recipients.map(r => r.userId).sort()).toEqual([r1FollowBefore.id]);

    const outboxAfter = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, event.id));
    expect(outboxAfter.length).toBe(1);
    expect(outboxAfter[0].state).toBe("completed");
    expect(outboxAfter[0].attempt).toBe(1);
    expect(outboxAfter[0].leaseToken).toBeNull();

    // ---- inbox + unread count through the REAL endpoints ---------------
    const callerR1 = appRouter.createCaller(readerContext(r1FollowBefore.id, uniqueTestTag("r1")));
    const unread = await callerR1.notifications.unreadCount();
    expect(unread.count).toBe(1);
    const inbox = await callerR1.notifications.list({ category: "all", unreadOnly: false, limit: 20 });
    expect(inbox.items.length).toBe(1);
    // InboxView deliberately hides raw kind - it exposes the localized label.
    expect(inbox.items[0].title).toBe("Wishlist มีตอนใหม่");
    expect(inbox.items[0].category).toBe("novel");
    await callerR1.notifications.markRead({ id: inbox.items[0].id });
    const unreadAfter = await callerR1.notifications.unreadCount();
    expect(unreadAfter.count).toBe(0);

    // ---- Phase 3b: second tick creates nothing -------------------------
    const tick2 = spawnTick();
    expect(tick2.code).toBe(0);
    expect(tick2.stdout).toContain('"recipientsCreated":0');
    const recipientsAfterSecondTick = await t
      .select({ userId: notificationRecipients.userId })
      .from(notificationRecipients)
      .where(eq(notificationRecipients.eventId, event.id));
    expect(recipientsAfterSecondTick.length).toBe(1);
  });

  it("R40R85R3: fixture teardown is guaranteed for the neighbour lifecycle and the collision probe, fails loudly with ids, and never deletes outside this run", async () => {
    await ensureVerifiedTestDb();
    const t = getTestDb();

    // --- tracked fixture whose eventKey registration "crashed" ----------
    // (each id registered immediately after creation; afterEach +
    // cleanupTracked own this scope)
    const author = await createTestUser({ role: "author" });
    tracked.userIds.push(author.id);
    const follower = await createTestUser();
    tracked.userIds.push(follower.id);
    const novel = await createTestNovelDirect(t, author.id);
    tracked.novelIds.push(novel.id);
    await t.insert(wishlists).values({ userId: follower.id, novelId: novel.id, createdAt: new Date(Date.now() - 3_600_000) });

    const callerAuthor = appRouter.createCaller(authorContext(author.id, "R85 Author"));
    const created = (await callerAuthor.admin.episodes.create({
      novelId: novel.id,
      episodeNumber: uniqueTestTag("ep"),
      title: "R85 Failure-Path Episode",
      price: "0",
      isFree: true,
    })) as { id?: number };
    const episodeId = Number(created!.id);
    tracked.episodeIds.push(episodeId);

    // Simulate the mid-test crash: the eventKey was NEVER registered.
    tracked.eventKeys.length = 0;

    // --- NEIGHBOUR lifecycle: try/finally starts BEFORE the first
    // neighbour fixture is created, and every id is registered into the
    // composite teardown IMMEDIATELY as it comes into existence - any
    // failure at any point still runs the teardown for whatever exists.
    const neighbour: NeighbourState = { extraUserIds: [] };
    let probeEventKey: string | null = null;
    const teardownErrors: string[] = [];

    const probeTeardown = async (): Promise<void> => {
      if (probeEventKey === null) return;
      await t.delete(notificationEvents).where(eq(notificationEvents.eventKey, probeEventKey));
    };

    try {
      const otherAuthor = await createTestUser({ role: "author" });
      neighbour.authorId = otherAuthor.id;
      const otherNovel = await createTestNovelDirect(t, otherAuthor.id);
      neighbour.novelId = otherNovel.id;
      const otherEpisode = await createTestEpisode(otherNovel.id, { title: "R85 untouched neighbour" });
      neighbour.episodeId = otherEpisode.id;
      const otherUser = await createTestUser();
      neighbour.extraUserIds.push(otherUser.id);
      const callerOther = appRouter.createCaller(authorContext(otherAuthor.id, "R85 Other Author"));
      // produce a real event/outbox/digest/marker for the UNTRACKED novel
      await t.transaction((tx: any) =>
        recordEpisodeCreationNotificationIfEnabled(tx, {
          createdEpisodeId: otherEpisode.id,
          novelId: otherNovel.id,
          requestedIsPublished: true,
          flags: readNotificationRuntimeFlags(process.env),
          env: process.env,
        }),
      );
      const otherEvents = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            novelBatchPrefix(otherNovel.id),
          ),
        );
      expect(otherEvents.length).toBe(1);
      neighbour.eventId = otherEvents[0].id;

      // --- prefix-collision probe: a row whose sourceId digit-extends our
      // novel id (simulating a longer novel id `1239` against ours `123`).
      // The old unescaped LIKE `{novelId}_%` matched and deleted it (bug);
      // the escaped sweep must leave it alone. Registered for guaranteed
      // teardown IMMEDIATELY after creation.
      probeEventKey = await insertProbeEvent(t, `${novel.id}9_ep9_0`);

      // --- run the repaired cleanup -------------------------------------
      const report = await cleanupTracked();
      expect(report.deletedEvents).toBe(1);
      expect(report.deletedDigests).toBe(1);
      expect(report.deletedOutbox).toBe(1);
      expect(Object.keys(report.leftovers).length).toBe(0);

      // tracked fixture fully removed (event gone). The probe does NOT sit
      // under this prefix by design: the probe's sourceId has a digit where
      // the literal `_` belongs, so the escaped sweep correctly matches
      // nothing here - the dedicated probe check below proves it survived.
      const eventsAfter = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            novelBatchPrefix(novel.id),
          ),
        );
      expect(eventsAfter.length).toBe(0);
      const probeStillThere = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(eq(notificationEvents.eventKey, probeEventKey));
      expect(probeStillThere.length).toBe(1);

      // UNTRACKED neighbour untouched by cleanup: event, outbox, digest,
      // marker, novel all intact.
      const neighbourOutbox = await t
        .select({ id: notificationOutbox.id, state: notificationOutbox.state })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.eventId, neighbour.eventId!));
      expect(neighbourOutbox.length).toBe(1);
      expect(neighbourOutbox[0].state).toBe("pending");
      const neighbourDigest = await t
        .select({ id: notificationDigestEpisodes.id })
        .from(notificationDigestEpisodes)
        .where(eq(notificationDigestEpisodes.eventId, neighbour.eventId!));
      expect(neighbourDigest.length).toBe(1);
      const neighbourMarker = await t
        .select({ entityId: notificationPublicationMarkers.entityId })
        .from(notificationPublicationMarkers)
        .where(
          and(
            eq(notificationPublicationMarkers.entityType, "episode"),
            eq(notificationPublicationMarkers.entityId, BigInt(neighbour.episodeId!)),
          ),
        );
      expect(neighbourMarker.length).toBe(1);
      const neighbourNovel = await t.select({ id: novels.id }).from(novels).where(eq(novels.id, neighbour.novelId!));
      expect(neighbourNovel.length).toBe(1);
    } finally {
      // Guaranteed teardown of EVERYTHING this test created outside the
      // tracked scope - the probe and the whole neighbour lifecycle - even
      // when an assertion fails mid-way. A teardown error is collected,
      // never swallowed, and re-thrown with the ids that remain.
      try {
        await probeTeardown();
      } catch (error) {
        teardownErrors.push(`probe(${probeEventKey ?? "none"}): ${(error as Error).message}`);
      }
      try {
        await teardownNeighbourFixture(t, neighbour);
      } catch (error) {
        teardownErrors.push((error as Error).message);
      }
      if (teardownErrors.length > 0) {
        throw new Error(
          `R40R85R3 GUARANTEED TEARDOWN INCOMPLETE - probeEventKey=${probeEventKey ?? "none"}: ` +
            teardownErrors.join(" | "),
        );
      }
    }

    // post-teardown scope proof: neighbour, probe and tracked rows are ALL
    // gone; nothing outside this run was ever touched.
    const neighbourLeftovers = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.kind, "wishlist_episodes_published"),
          novelBatchPrefix(neighbour.novelId!),
        ),
      );
    expect(neighbourLeftovers.length).toBe(0);
    const probeGone = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, probeEventKey!));
    expect(probeGone.length).toBe(0);
  });


  it("R40R85R3A: neighbour teardown discovers events the producer committed before the eventId was recorded, and leaves zero rows", async () => {
    await ensureVerifiedTestDb();
    const t = getTestDb();

    // Neighbour-only fixture owned by the guaranteed teardown (not tracked).
    const neighbour: NeighbourState = { extraUserIds: [] };
    const committedEventIds: bigint[] = [];
    try {
      const author = await createTestUser({ role: "author" });
      neighbour.authorId = author.id;
      const novel = await createTestNovelDirect(t, author.id);
      neighbour.novelId = novel.id;
      const episode = await createTestEpisode(novel.id, { title: "R85R3A committed-before-record" });
      neighbour.episodeId = episode.id;

      // The producer COMMITS event + outbox + digest + marker ...
      await t.transaction((tx: any) =>
        recordEpisodeCreationNotificationIfEnabled(tx, {
          createdEpisodeId: episode.id,
          novelId: novel.id,
          requestedIsPublished: true,
          flags: readNotificationRuntimeFlags(process.env),
          env: process.env,
        }),
      );
      // ... and the test "crashes" before neighbour.eventId is recorded.
      // (ids captured locally ONLY for the post-teardown assertions; the
      // teardown state deliberately keeps eventId undefined.)
      const committed = await t
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "wishlist_episodes_published"),
            novelBatchPrefix(novel.id),
          ),
        );
      expect(committed.length).toBe(1);
      committedEventIds.push(...committed.map(r => r.id));
      expect(neighbour.eventId).toBeUndefined();
    } finally {
      // Discovery guard: eventId is undefined, novelId is set.
      await teardownNeighbourFixture(t, neighbour);
    }

    // Zero rows remain for this fixture - event children first.
    expect(committedEventIds.length).toBe(1);
    const digests = await t
      .select({ id: notificationDigestEpisodes.id })
      .from(notificationDigestEpisodes)
      .where(inArray(notificationDigestEpisodes.eventId, committedEventIds));
    expect(digests.length).toBe(0);
    const recipients = await t
      .select({ id: notificationRecipients.id })
      .from(notificationRecipients)
      .where(inArray(notificationRecipients.eventId, committedEventIds));
    expect(recipients.length).toBe(0);
    const outbox = await t
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(inArray(notificationOutbox.eventId, committedEventIds));
    expect(outbox.length).toBe(0);
    const events = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(inArray(notificationEvents.id, committedEventIds));
    expect(events.length).toBe(0);
    const markers = await t
      .select({ entityId: notificationPublicationMarkers.entityId })
      .from(notificationPublicationMarkers)
      .where(
        and(
          eq(notificationPublicationMarkers.entityType, "episode"),
          eq(notificationPublicationMarkers.entityId, BigInt(neighbour.episodeId!)),
        ),
      );
    expect(markers.length).toBe(0);
    const episodeRows = await t.select({ id: episodes.id }).from(episodes).where(eq(episodes.id, neighbour.episodeId!));
    expect(episodeRows.length).toBe(0);
    const novelRows = await t.select({ id: novels.id }).from(novels).where(eq(novels.id, neighbour.novelId!));
    expect(novelRows.length).toBe(0);
    const userRows = await t.select({ id: users.id }).from(users).where(eq(users.id, neighbour.authorId!));
    expect(userRows.length).toBe(0);
  });
});
/** Direct novel fixture (no business API, so novel_published can never fire). */
async function createTestNovelDirect(
  t: Awaited<ReturnType<typeof ensureVerifiedTestDb>>,
  authorUserId: number,
): Promise<{ id: number }> {
  const tag = uniqueTestTag("r85novel");
  const result = await t.insert(novels).values({
    title: `R85 First-Event Novel ${tag}`,
    slug: `r85-first-event-${tag}`,
    author: "R85 Test Author",
    description: "R40R85 disposable test novel - safe to delete.",
    publicationStatus: "published",
    storyStatus: "ongoing",
    authorUserId,
  });
  const header = Array.isArray(result) ? result[0] : result;
  const id = Number(header?.insertId);
  expect(id).toBeGreaterThan(0);
  return { id };
}
