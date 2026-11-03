import { and, asc, eq, gt } from "drizzle-orm";
import { novels, users, wishlists } from "../../drizzle/schema";
import { notificationEvents as events, notificationPreferences as prefs } from "./tables";
import { isEligibleAudienceRecipient } from "./audiencePolicy";
import type { QualifiedAudienceReader } from "./sqlDeliveryStore";
import type { NotificationKind } from "./contract";

function safeUserCursor(value: string | null): number {
  if (value === null) return 0;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid notification audience cursor");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Invalid notification audience cursor");
  return n;
}
function safeNovelId(sourceId: string, digest: boolean): number {
  const match = digest ? /^([1-9][0-9]*)_[A-Za-z0-9_-]{1,72}_[0-9]{1,5}$/.exec(sourceId)
    : /^([1-9][0-9]*)$/.exec(sourceId);
  if (!match) throw new Error("Invalid notification publication identity");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new Error("Invalid notification publication identity");
  return id;
}

/**
 * Read-only qualified audience for the unmounted SQL delivery store.
 * Keyset pagination advances across RAW candidate users, even if every user
 * in a page is filtered out. Never backfill users who opted in or added a
 * wishlist after the immutable event timestamp.
 *
 * Account lifecycle contract (R40R56): this schema has NO soft-active flag -
 * admin deletion and account merge HARD-delete the users row (together with
 * its classified notification rows). `activeAccount` is therefore DERIVED
 * from the row's existence in every query below - a returned row is the
 * evidence, and a deleted account simply never appears to be paged.
 * insertRecipientIfAbsent re-checks the row under the delivery transaction
 * so a deletion racing the pager cannot produce an orphan recipient.
 *
 * This is NOT a deployment-ready fanout: first-publication producer markers,
 * migration registration, lifecycle handling and real-DB concurrency gates
 * must qualify before the scheduler can mount it.
 */
export function createQualifiedSqlAudienceReader(database: any): QualifiedAudienceReader {
  if (!database || typeof database.select !== "function") {
    throw new Error("Notification audience database unavailable");
  }
  return async (claimed, limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid notification audience page bound");
    }
    const cursor = safeUserCursor(claimed.audienceCursor);
    const eventId = BigInt(claimed.eventId);
    const found = await database.select({
      eventKey: events.eventKey, kind: events.kind, sourceType: events.sourceType,
      sourceId: events.sourceId, occurredAt: events.occurredAt,
      eligibleAfter: events.eligibleAfter, targetUserId: events.targetUserId,
    }).from(events).where(eq(events.id, eventId)).limit(1);
    const item = found[0];
    if (!item || item.eventKey !== claimed.eventKey || item.kind !== claimed.kind ||
        !(item.occurredAt instanceof Date) || !(item.eligibleAfter instanceof Date) ||
        Number.isNaN(item.occurredAt.getTime()) ||
        Number.isNaN(item.eligibleAfter.getTime()) ||
        item.occurredAt.getTime() < item.eligibleAfter.getTime()) {
      throw new Error("Notification event audience identity mismatch");
    }
    const kind = item.kind as NotificationKind;
    const publicNovel = kind === "novel_published" || kind === "wishlist_episodes_published";
    if (publicNovel !== (item.targetUserId === null)) {
      throw new Error("Invalid notification audience targeting");
    }
    if (!publicNovel) {
      const expectedSourceType: Record<string, string> = {
        wallet_topup_approved: "wallet_topups",
        wallet_topup_rejected: "wallet_topups",
        order_completed: "orders",
        episode_wallet_purchased: "episode_purchases",
        daily_checkin_reminder: "checkin_campaign",
      };
      if (!expectedSourceType[kind] || item.sourceType !== expectedSourceType[kind] ||
          (kind === "daily_checkin_reminder"
            ? !/^[A-Za-z0-9_-]{1,96}$/.test(item.sourceId)
            : !/^[1-9][0-9]*$/.test(item.sourceId) ||
              !Number.isSafeInteger(Number(item.sourceId)))) {
        throw new Error("Invalid notification direct source identity");
      }
    }
    let novelId: number | null = null;
    let authorUserId: number | null = null;
    if (publicNovel) {
      if (item.sourceType !== (kind === "novel_published" ? "novels" : "novel_publish_batches")) {
        throw new Error("Invalid notification publication source");
      }
      novelId = safeNovelId(item.sourceId, kind === "wishlist_episodes_published");
      const novelRows = await database.select({
        authorUserId: novels.authorUserId, status: novels.publicationStatus,
      }).from(novels).where(eq(novels.id, novelId)).limit(1);
      if (novelRows.length !== 1 || novelRows[0].status !== "published") {
        // Withdrawn or deleted content is not advertised.
        return { userIds: [], nextCursor: null };
      }
      authorUserId = novelRows[0].authorUserId;
    }
    const selectFields = {
      userId: users.id, role: users.role, accountRowId: users.id,
      preferenceOverride: prefs.enabled, preferenceUpdatedAt: prefs.updatedAt,
      wishlistCreatedAt: wishlists.createdAt,
    };
    // Direct outcomes never enumerate the entire users table.
    if (!publicNovel) {
      if (!Number.isSafeInteger(item.targetUserId) || item.targetUserId < 1) {
        throw new Error("Invalid notification targeted audience");
      }
      if (item.targetUserId <= cursor) return { userIds: [], nextCursor: null };
      const rows = await database.select({
        userId: users.id, role: users.role, accountRowId: users.id,
        preferenceOverride: prefs.enabled, preferenceUpdatedAt: prefs.updatedAt,
      }).from(users).leftJoin(prefs, and(eq(prefs.userId, users.id), eq(prefs.kind, kind)))
        .where(eq(users.id, item.targetUserId)).limit(1);
      const row = rows[0];
      if (!row) return { userIds: [], nextCursor: null };
      const eligible = isEligibleAudienceRecipient({
        kind, eventAt: item.occurredAt,
        recipient: {
          userId: row.userId, activeAccount: row.accountRowId !== null, isAuthor: row.role === "author",
          preferenceOverride: row.preferenceOverride,
          preferenceUpdatedAt: row.preferenceUpdatedAt,
          wishlistActive: false, wishlistCreatedAt: null,
        },
      });
      return { userIds: eligible ? [row.userId] : [], nextCursor: null };
    }
    // A wishlist digest pages only current followers of its novel, using
    // the unique (userId, novelId) membership. A new follow after the event
    // is rejected by isEligibleAudienceRecipient.
    const rows = kind === "wishlist_episodes_published"
      ? await database.select(selectFields).from(users)
        .innerJoin(wishlists, and(eq(wishlists.userId, users.id), eq(wishlists.novelId, novelId!)))
        .leftJoin(prefs, and(eq(prefs.userId, users.id), eq(prefs.kind, kind)))
        .where(gt(users.id, cursor)).orderBy(asc(users.id)).limit(limit)
      : await database.select({
          userId: users.id, role: users.role, accountRowId: users.id,
          preferenceOverride: prefs.enabled, preferenceUpdatedAt: prefs.updatedAt,
        }).from(users)
        .leftJoin(prefs, and(eq(prefs.userId, users.id), eq(prefs.kind, kind)))
        .where(gt(users.id, cursor)).orderBy(asc(users.id)).limit(limit);
    let previous = cursor;
    const eligibleIds: number[] = [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.userId) || row.userId <= previous) {
        throw new Error("Invalid notification audience ordering");
      }
      previous = row.userId;
      if (row.userId === authorUserId) continue;
      if (isEligibleAudienceRecipient({
        kind, eventAt: item.occurredAt,
        recipient: {
          userId: row.userId, activeAccount: row.accountRowId !== null, isAuthor: row.role === "author",
          preferenceOverride: row.preferenceOverride,
          preferenceUpdatedAt: row.preferenceUpdatedAt,
          wishlistActive: kind === "wishlist_episodes_published",
          wishlistCreatedAt: kind === "wishlist_episodes_published"
            ? row.wishlistCreatedAt : null,
        },
      })) eligibleIds.push(row.userId);
    }
    return {
      userIds: eligibleIds,
      nextCursor: rows.length === limit ? String(previous) : null,
    };
  };
}
