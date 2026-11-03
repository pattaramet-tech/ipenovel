/**
 * Shared, side-effect-free notification contracts.
 *
 * These helpers intentionally do not fetch accounts, credit a wallet, publish a
 * novel, or write a recipient. Persistence must bind the actor to ctx.user and
 * record a business event in its owning transaction.
 */
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_KINDS, type NotificationKind,
} from "../../shared/notificationKindCatalog";
export { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_KINDS };
export type { NotificationKind };

/** An override is meaningful only after the server has verified ownership. */
export function preferenceAllows(
  kind: NotificationKind,
  overrides: Partial<Record<NotificationKind, boolean>>,
): boolean {
  const override = overrides[kind];
  return typeof override === "boolean" ? override : DEFAULT_NOTIFICATION_PREFERENCES[kind];
}

function safeIdentifier(value: string | number, field: string): string {
  const identifier = String(value);
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(identifier)) {
    throw new Error(`Invalid notification ${field}`);
  }
  return identifier;
}

/**
 * Immutable source event identity. Do not use timestamps, mutable episode
 * content, money amounts, user-entered names or provider secrets as keys.
 * transitionId must identify the first successful transition durably.
 */
export function eventDedupeKey(input: {
  kind: NotificationKind;
  sourceType: string;
  sourceId: string | number;
  transitionId: string | number;
}): string {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error("Invalid notification kind");
  }
  const type = safeIdentifier(input.sourceType, "source type");
  const id = safeIdentifier(input.sourceId, "source id");
  const transition = safeIdentifier(input.transitionId, "transition");
  return `notification:v1:${input.kind}:${type}:${id}:${transition}`;
}

export function recipientDedupeKey(eventKey: string, recipientUserId: number): string {
  if (!eventKey.startsWith("notification:v1:") || eventKey.length > 512) {
    throw new Error("Invalid notification event key");
  }
  if (!Number.isSafeInteger(recipientUserId) || recipientUserId <= 0) {
    throw new Error("Invalid recipient");
  }
  return `${eventKey}:recipient:${recipientUserId}`;
}

const bangkokFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Date boundary is always Asia/Bangkok, not runtime/server locale. */
export function bangkokDayKey(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid instant");
  const parts = bangkokFormatter.formatToParts(instant);
  const read = (name: string) => parts.find(part => part.type === name)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function isCheckinReminderEligible(input: {
  instant: Date;
  campaignEnabled: boolean;
  optedIn: boolean;
  hasCheckinForBangkokDay: boolean;
  userActive: boolean;
}): boolean {
  bangkokDayKey(input.instant);
  return input.campaignEnabled && input.optedIn && !input.hasCheckinForBangkokDay && input.userActive;
}

export interface WishlistEpisodePublication {
  novelId: number;
  episodeId: number;
  batchKey: string;
}

export interface WishlistDigest {
  novelId: number;
  batchKey: string;
  /** Zero-based partition within a COMPLETE, immutable publication batch. */
  partIndex: number;
  episodeIds: number[];
}

/**
 * Deduplicate and partition a COMPLETE immutable publication batch, not an
 * arbitrary worker page: page-local partition ordinals would collide on replay.
 * Batch keys come from the durable source; retries must use the same full set.
 * Never recreate a dismissed recipient via an UPDATE.
 */
export function groupWishlistEpisodes(
  publications: readonly WishlistEpisodePublication[],
  maxEpisodesPerDigest = 50,
): WishlistDigest[] {
  if (!Number.isSafeInteger(maxEpisodesPerDigest) || maxEpisodesPerDigest < 1 || maxEpisodesPerDigest > 50) {
    throw new Error("Digest limit must be between 1 and 50");
  }
  const groups = new Map<string, Set<number>>();
  for (const row of publications) {
    if (!Number.isSafeInteger(row.novelId) || row.novelId <= 0 ||
        !Number.isSafeInteger(row.episodeId) || row.episodeId <= 0) {
      throw new Error("Invalid publication identity");
    }
    const batchKey = safeIdentifier(row.batchKey, "batch");
    if (batchKey.length > 72) throw new Error("Publication batch key too long");
    const key = `${row.novelId}:${batchKey}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(row.episodeId);
  }
  const result: WishlistDigest[] = [];
  for (const [key, ids] of Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const delimiter = key.indexOf(":");
    const novelId = Number(key.slice(0, delimiter));
    const batchKey = key.slice(delimiter + 1);
    const sorted = Array.from(ids).sort((a, b) => a - b);
    for (let cursor = 0; cursor < sorted.length; cursor += maxEpisodesPerDigest) {
      result.push({ novelId, batchKey, partIndex: cursor / maxEpisodesPerDigest, episodeIds: sorted.slice(cursor, cursor + maxEpisodesPerDigest) });
    }
  }
  return result;
}

export type BulkActionKind = "mark_all_read" | "delete_all";

export interface BulkSnapshot {
  actorUserId: number;
  operationKey: string;
  kind: BulkActionKind;
  cutoffSequence: bigint;
}

export interface BulkRecipientRow {
  userId: number;
  receivedSequence: bigint;
  readAt: Date | null;
  dismissedAt: Date | null;
}

/**
 * This predicate is ONLY the SQL update selection contract; the caller must
 * persist snapshot + operation key under the authenticated actor and execute
 * updates in a transaction. Never accept snapshot actor/cutoff from a client.
 */
export function includedInBulkSnapshot(row: BulkRecipientRow, snapshot: BulkSnapshot): boolean {
  if (!Number.isSafeInteger(snapshot.actorUserId) || snapshot.actorUserId <= 0 ||
      !/^[A-Za-z0-9_-]{8,96}$/.test(snapshot.operationKey) ||
      snapshot.cutoffSequence < BigInt(0)) {
    throw new Error("Invalid server bulk snapshot");
  }
  return row.userId === snapshot.actorUserId &&
    row.receivedSequence <= snapshot.cutoffSequence &&
    row.dismissedAt === null &&
    (snapshot.kind === "delete_all" || row.readAt === null);
}

/**
 * A disabled event generator may prevent new records; an inactive worker may
 * defer delivery. Neither condition can turn a failed business transaction
 * into a successful one.
 */
export function isEventAfterActivation(eventAt: Date, activatedAt: Date): boolean {
  if (Number.isNaN(eventAt.getTime()) || Number.isNaN(activatedAt.getTime())) {
    throw new Error("Invalid notification activation time");
  }
  return eventAt.getTime() >= activatedAt.getTime();
}
