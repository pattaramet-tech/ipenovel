import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import { novels, users, wishlists } from "../../drizzle/schema";
import { NOTIFICATION_KINDS, NOTIFICATION_PREFERENCE_DESCRIPTIONS } from "@shared/notificationKindCatalog";
import type { NotificationKind } from "./contract";
import { isEligibleNotificationPreference } from "./audiencePolicy";
import type {
  AudiencePage, ClaimedEvent, NotificationDeliveryStore, RecipientInsert,
} from "./deliveryPolicy";
import {
  notificationEvents as events, notificationOutbox as outbox,
  notificationRecipients as recipients, notificationSequence as sequence,
  notificationPreferences as prefs,
} from "./tables";

/**
 * Fenced SQL persistence for the in-app delivery tick.
 *
 * This adapter is intentionally NOT mounted in the app or a scheduler.
 * The injected audience reader must independently qualify account status,
 * preference cutover, and (for wishlist) membership before event time.
 * It must page by ascending user ID. Without that reader the store fails
 * closed; the SQL layer never invents a broadcast audience.
 */
export type QualifiedAudienceReader = (
  event: ClaimedEvent, limit: number,
) => Promise<AudiencePage>;

export interface SqlDeliveryFeatureGates {
  catalogFanoutEnabled: boolean;
  checkinRemindersEnabled: boolean;
}

const kinds = new Set<string>(NOTIFICATION_KINDS);
const MAX_SEQUENCE = BigInt("18446744073709551614");
const LEASE_MS = 5 * 60_000;

function positiveId(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid notification event ID");
  const id = BigInt(value);
  if (id > BigInt("18446744073709551615")) throw new Error("Invalid notification event ID");
  return id;
}
function affectedRows(result: any): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!Number.isSafeInteger(header?.affectedRows) || header.affectedRows < 0) {
    throw new Error("Invalid notification write result");
  }
  return header.affectedRows;
}
function checkedSequence(value: unknown): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Unsafe notification sequence value");
  }
  if (typeof value !== "number" && typeof value !== "bigint" &&
      (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))) {
    throw new Error("Invalid notification sequence value");
  }
  return BigInt(value);
}
function checkedKind(kind: string): NotificationKind {
  if (!kinds.has(kind)) throw new Error("Unknown notification event kind");
  return kind as NotificationKind;
}

/** Novel id from a fanout event's sourceId - plain id for novel_published,
 *  `novelId_batch_part` for wishlist digests (same grammar the qualified
 *  audience reader enforces). */
function parseFanoutNovelId(sourceId: string, kind: NotificationKind): number {
  const digest = kind === "wishlist_episodes_published";
  const match = (digest
    ? /^([1-9][0-9]*)_[A-Za-z0-9_-]{1,72}_[0-9]{1,5}$/
    : /^([1-9][0-9]*)$/).exec(sourceId);
  if (!match) throw new Error("Invalid notification publication identity");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error("Invalid notification publication identity");
  }
  return id;
}
function checkedClaim(event: ClaimedEvent): bigint {
  if (!event.leaseToken || event.leaseToken.length > 96) {
    throw new Error("Invalid notification lease");
  }
  return positiveId(event.eventId);
}
function fencedWhere(event: ClaimedEvent, now: Date) {
  return and(
    eq(outbox.eventId, checkedClaim(event)),
    eq(outbox.state, "leased"),
    eq(outbox.leaseToken, event.leaseToken),
    gt(outbox.leasedUntil, now),
  );
}

/**
 * Connection-free SQL shape for the atomic MySQL8 claim. Exposed so the
 * exact Drizzle query can be qualified without a live database connection.
 */
export function buildNotificationClaimQuery(
  db: any, now: Date, limit: number, enabledKinds: readonly NotificationKind[],
) {
  return db.select({
    id: outbox.id, eventId: outbox.eventId, eventKey: events.eventKey,
    kind: events.kind, attempt: outbox.attempt,
    audienceCursor: outbox.audienceCursor,
  }).from(outbox).innerJoin(events, eq(outbox.eventId, events.id))
    .where(and(inArray(events.kind, [...enabledKinds]), or(
      and(eq(outbox.state, "pending"), lte(outbox.nextAttemptAt, now)),
      and(eq(outbox.state, "leased"), lte(outbox.leasedUntil, now)),
    ))).orderBy(outbox.id).limit(limit).for("update", { skipLocked: true });
}

/**
 * Claim and write methods fence every operation against the current DB lease.
 * All recipients use the SAME sequence row lock as inbox bulk operations.
 * Unique (event,user) and tombstones make crash replay non-revivable.
 */
export function createSqlNotificationDeliveryStore(
  database: any,
  audienceReader: QualifiedAudienceReader,
  gates: SqlDeliveryFeatureGates = {
    catalogFanoutEnabled: false, checkinRemindersEnabled: false,
  },
): NotificationDeliveryStore {
  if (!database || typeof database.transaction !== "function" ||
      typeof database.select !== "function" ||
      typeof database.update !== "function" ||
      typeof audienceReader !== "function") {
    throw new Error("Notification delivery dependencies unavailable");
  }
  const enabledKinds = NOTIFICATION_KINDS.filter(kind =>
    kind === "daily_checkin_reminder" ? gates.checkinRemindersEnabled :
    (kind === "novel_published" || kind === "wishlist_episodes_published")
      ? gates.catalogFanoutEnabled : true);
  const enabledSet = new Set<string>(enabledKinds);
  const checkedEnabledKind = (kind: string): NotificationKind => {
    const valid = checkedKind(kind);
    if (!enabledSet.has(valid)) throw new Error("Notification event category disabled");
    return valid;
  };
  const fencedUpdate = async (event: ClaimedEvent, values: Record<string, unknown>) => {
    const result = await database.update(outbox).set({
      ...values, leaseToken: null, leasedUntil: null,
    }).where(fencedWhere(event, new Date()));
    if (affectedRows(result) !== 1) throw new Error("Notification delivery lease lost");
  };
  return {
    async claimReadyEvents(now, limit) {
      if (Number.isNaN(now.getTime()) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 20) throw new Error("Invalid notification claim bounds");
      return database.transaction(async (tx: any) => {
        // SKIP LOCKED ensures two concurrent workers cannot claim the same row.
        // Expired leases are reclaimable, but never before their DB deadline.
        const rows = await buildNotificationClaimQuery(tx, now, limit, enabledKinds);
        const claimed: ClaimedEvent[] = [];
        for (const row of rows) {
          const attempt = Number(row.attempt);
          if (!Number.isSafeInteger(attempt) || attempt < 0 ||
              attempt >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid notification attempt");
          const token = randomUUID();
          const result = await tx.update(outbox).set({
            state: "leased", attempt: attempt + 1, leaseToken: token,
            leasedUntil: new Date(now.getTime() + LEASE_MS),
          }).where(eq(outbox.id, row.id));
          if (affectedRows(result) !== 1) throw new Error("Notification claim conflict");
          claimed.push({
            eventId: String(row.eventId), eventKey: row.eventKey,
            kind: checkedEnabledKind(row.kind), attempt: attempt + 1,
            leaseToken: token, audienceCursor: row.audienceCursor,
          });
        }
        return claimed;
      });
    },
    async readAudience(event, limit) {
      checkedClaim(event);
      checkedEnabledKind(event.kind);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Invalid notification audience bound");
      }
      const active = await database.select({ id: outbox.id }).from(outbox)
        .where(fencedWhere(event, new Date())).limit(1);
      if (active.length !== 1) throw new Error("Notification delivery lease lost");
      return audienceReader(event, limit);
    },
    async insertRecipientIfAbsent(event, userId): Promise<RecipientInsert> {
      if (!Number.isSafeInteger(userId) || userId < 1) {
        throw new Error("Invalid notification recipient");
      }
      const eventId = checkedClaim(event);
      checkedEnabledKind(event.kind);
      return database.transaction(async (tx: any) => {
        // Lock the outbox FIRST, so expiry/reclaim cannot race with insertion.
        const lease = await tx.select({ id: outbox.id }).from(outbox)
          .where(fencedWhere(event, new Date())).limit(1).for("update");
        if (lease.length !== 1) throw new Error("Notification delivery lease lost");
        // The same sequence lock is held by bulk high-water operations.
        const counter = await tx.select({ next: sequence.nextSequence })
          .from(sequence).where(eq(sequence.id, 1)).limit(1).for("update");
        if (counter.length !== 1) throw new Error("Notification sequence unavailable");
        const next = checkedSequence(counter[0].next);
        if (next < BigInt("1") || next > MAX_SEQUENCE) throw new Error("Notification sequence exhausted");
        const identity = await tx.select({
          kind: events.kind, sourceId: events.sourceId,
          targetUserId: events.targetUserId,
          occurredAt: events.occurredAt,
        }).from(events).where(eq(events.id, eventId)).limit(1);
        if (identity.length !== 1 || identity[0].kind !== event.kind ||
            (identity[0].targetUserId !== null && identity[0].targetUserId !== userId)) {
          throw new Error("Notification audience identity mismatch");
        }
        const prior = await tx.select({ dismissedAt: recipients.dismissedAt })
          .from(recipients).where(and(eq(recipients.eventId, eventId),
            eq(recipients.userId, userId))).limit(1);
        if (prior.length !== 0) return prior[0].dismissedAt === null
          ? "already_exists" : "dismissed";
        const kind = checkedKind(identity[0].kind);
        // R40R56R1: LOCKING CURRENT reads (FOR SHARE). Under REPEATABLE READ
        // a plain SELECT would read this transaction's snapshot, which a
        // concurrently committing deletion can predate; FOR SHARE always
        // reads the latest committed row and holds the shared lock to commit.
        //
        // Account/role: the admin deletion (and merge) flow locks the target
        // users row FOR UPDATE as its FIRST statement, so either this read
        // sees the committed deletion ("ineligible") or the deletion waits
        // here and then re-runs its assessment against our committed
        // recipient (user_owned_hard_block -> CONFLICT rollback) - an orphan
        // recipient for a deleted account is structurally impossible. Each
        // FOR SHARE below is a SINGLE contact point with one external
        // writer's own row (deletion->users, archive->novels, unfollow->
        // wishlists); no external writer requests the outbox/sequence/prefs
        // locks this transaction holds, so no cycle can form.
        const isPublicFanout = identity[0].targetUserId === null &&
          (kind === "novel_published" || kind === "wishlist_episodes_published");
        const account = await tx.select({ id: users.id, role: users.role })
          .from(users).where(eq(users.id, userId)).limit(1).for("share");
        if (account.length === 0) return "ineligible";
        if (isPublicFanout && account[0].role === "author") {
          // A role flip to author between paging and insertion re-applies
          // the fanout exclusion at the only write point.
          return "ineligible";
        }
        if (isPublicFanout) {
          // Novel identity + publication + author exclusion, revalidated as
          // a current read: withdrawn/archived content is never advertised
          // and the novel's own author never receives its fanout even if
          // their role is not "author".
          const fanoutNovelId = parseFanoutNovelId(identity[0].sourceId, kind);
          const novelRows = await tx
            .select({ authorUserId: novels.authorUserId, status: novels.publicationStatus })
            .from(novels).where(eq(novels.id, fanoutNovelId)).limit(1).for("share");
          if (novelRows.length === 0 || novelRows[0].status !== "published") {
            return "ineligible";
          }
          if (novelRows[0].authorUserId === userId) return "ineligible";
          if (kind === "wishlist_episodes_published") {
            // Membership must exist NOW and must predate the immutable event
            // time: an unfollow before delivery suppresses, a late follow is
            // never backfilled.
            const membership = await tx.select({ createdAt: wishlists.createdAt })
              .from(wishlists)
              .where(and(eq(wishlists.userId, userId), eq(wishlists.novelId, fanoutNovelId)))
              .limit(1).for("share");
            if (membership.length === 0) return "ineligible";
            if (!(membership[0].createdAt.getTime() < identity[0].occurredAt.getTime())) {
              return "ineligible";
            }
          }
        }
        // This is a locking CURRENT read, not the stale audience snapshot.
        // setOwnPreference acquires the same sequence lock before its write,
        // so a committed opt-out cannot race past this insertion.
        const currentPrefs = await tx.select({enabled:prefs.enabled,updatedAt:prefs.updatedAt})
          .from(prefs).where(and(eq(prefs.userId,userId),eq(prefs.kind,kind)))
          .limit(1).for("update");
        if(currentPrefs.length>1)throw new Error("Notification preference identity conflict");
        const preference = currentPrefs[0];
        if(!isEligibleNotificationPreference(kind,identity[0].occurredAt,
          preference?.enabled ?? null,preference?.updatedAt ?? null))return "ineligible";
        const category = NOTIFICATION_PREFERENCE_DESCRIPTIONS[kind].group;
        await tx.insert(recipients).values({
          eventId, userId, receivedSequence: next, category,
        });
        const result = await tx.update(sequence).set({ nextSequence: next + BigInt("1") })
          .where(eq(sequence.id, 1));
        if (affectedRows(result) !== 1) throw new Error("Notification sequence conflict");
        return "created";
      });
    },
    async checkpointAudience(event, nextCursor) {
      const previous = event.audienceCursor === null ? BigInt("0") : positiveId(event.audienceCursor);
      if (positiveId(nextCursor) <= previous) throw new Error("Invalid notification cursor");
      await fencedUpdate(event, {
        audienceCursor: nextCursor, state: "pending", nextAttemptAt: new Date(),
      });
    },
    async completeEvent(event) {
      await fencedUpdate(event, { state: "completed", completedAt: new Date() });
    },
    async scheduleRetry(event, retryAt, failureCode) {
      if (Number.isNaN(retryAt.getTime()) ||
          (failureCode !== "DELIVERY_ERROR" && failureCode !== "PERMANENT_DELIVERY_ERROR")) {
        throw new Error("Invalid notification retry");
      }
      await fencedUpdate(event, {
        state: "pending", nextAttemptAt: retryAt, lastFailureCode: failureCode,
      });
    },
    async deadLetter(event, failureCode) {
      if (failureCode !== "DELIVERY_ERROR" && failureCode !== "PERMANENT_DELIVERY_ERROR") {
        throw new Error("Invalid notification failure code");
      }
      await fencedUpdate(event, { state: "dead_letter", lastFailureCode: failureCode });
    },
  };
}
