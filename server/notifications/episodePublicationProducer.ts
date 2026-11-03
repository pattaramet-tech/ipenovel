import { and, eq } from "drizzle-orm";
import { novels } from "../../drizzle/schema";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";
import { notificationEvents, notificationPublicationMarkers } from "./tables";
import { insertQualifiedNotification } from "./eventIngress";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import type { NotificationRuntimeFlags } from "./runtimeGate";
import { resolveNotificationsActivationAt } from "./novelPublicationProducer";

/**
 * P2-A `wishlist_episodes_published` producer (admin/author catalog episode
 * CREATION only).
 *
 * Scope discipline: this producer fires for a BRAND-NEW episode created with
 * `isPublished=true` whose parent novel is CURRENTLY "published", verified
 * from authoritative rows inside the caller's transaction. Episode updates,
 * republishing, Workspace/ZIP publishing and financial flows deliberately do
 * NOT call it (an absent marker proves nothing about first-ever publication
 * for pre-existing episodes - see novelPublicationProducer.ts's provenance
 * policy).
 *
 * Recipient selection is NOT the producer's concern: it writes event,
 * outbox, digest membership and the durable first-publication marker only;
 * the delivery worker's audience reader later pages current wishlist
 * followers and rejects follows created after the event.
 */
export type EpisodeFirstPublicationOutcome =
  | { status: "disabled" }
  | { status: "skipped_episode_not_published" }
  | { status: "skipped_novel_not_published" }
  | { status: "skipped_not_first_public" }
  | { status: "skipped_before_activation" }
  | { status: "duplicate"; eventKey: string }
  | { status: "created"; eventKey: string };

export async function recordEpisodeFirstPublicationIfEnabled(
  tx: any,
  params: {
    episodeId: number;
    novelId: number;
    /** The created episode's effective isPublished value (true required). */
    isPublished: boolean;
    /** Fixed flags snapshot - same process-lifetime policy as the API mount. */
    flags: NotificationRuntimeFlags;
    /** Process environment; read ONLY after the gates pass. */
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<EpisodeFirstPublicationOutcome> {
  const { episodeId, novelId, isPublished, flags, env } = params;
  const occurredAt = params.occurredAt ?? new Date();
  if (!Number.isSafeInteger(episodeId) || episodeId < 1 ||
    !Number.isSafeInteger(novelId) || novelId < 1) {
    throw new Error("Invalid episode publication identity");
  }
  // Gate FIRST, before ANY notification-only configuration or table access.
  if (!flags.notificationsEnabled || !flags.catalogFanoutEnabled) {
    return { status: "disabled" };
  }
  if (isPublished !== true) {
    return { status: "skipped_episode_not_published" };
  }
  // The parent novel must be CURRENTLY published, read inside this same
  // transaction; an archived (or otherwise non-public) novel suppresses the
  // notification without claiming any marker.
  const parent = await tx.select({ publicationStatus: novels.publicationStatus })
    .from(novels)
    .where(eq(novels.id, novelId))
    .limit(1);
  if (parent?.[0]?.publicationStatus !== "published") {
    return { status: "skipped_novel_not_published" };
  }
  const activationAt = resolveNotificationsActivationAt(env, occurredAt);
  // Atomic first-publication claim per episode.
  try {
    await tx.insert(notificationPublicationMarkers).values({
      entityType: "episode",
      entityId: BigInt(episodeId),
      state: "published",
      firstPublishedAt: occurredAt,
      firstEventId: null,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { status: "skipped_not_first_public" };
    }
    throw error;
  }
  const outcome = await insertQualifiedNotification(
    createTransactionalEventOutboxAdapter(tx, occurredAt, activationAt),
    {
      kind: "wishlist_episodes_published",
      novelId,
      batchKey: `ep${episodeId}`,
      partIndex: 0,
      transitionKey: "first_public",
      firstPublicEpisodeIds: [episodeId],
    },
  );
  if (outcome.created) {
    const rows = await tx.select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, outcome.eventKey))
      .limit(1);
    const eventId = rows?.[0]?.id;
    if (eventId !== undefined) {
      await tx.update(notificationPublicationMarkers)
        .set({ firstEventId: eventId })
        .where(and(
          eq(notificationPublicationMarkers.entityType, "episode"),
          eq(notificationPublicationMarkers.entityId, BigInt(episodeId)),
        ));
    }
  }
  if (outcome.status === "created") return { status: "created", eventKey: outcome.eventKey };
  if (outcome.status === "skipped") return { status: "skipped_before_activation" };
  return { status: "duplicate", eventKey: outcome.eventKey };
}

/**
 * Wiring adapter for the admin/author episode-create transaction in
 * server/routers.ts. Mirrors db.createEpisode's effective publication rule
 * EXACTLY (`isPublished !== false` - an omitted flag means the episode is
 * born PUBLISHED), so the default-published creation path invokes the
 * producer exactly like an explicit `isPublished: true`.
 *
 * Backdated `publishedAt` supplied by the client is deliberately ignored and
 * never reaches this adapter: the event's occurredAt, the marker's
 * firstPublishedAt and the activation cutoff all use the server-side
 * transaction time, so a client cannot age a notification by supplying an
 * old date. First-public status is proven by in-transaction creation of the
 * episode row itself - never inferred from a timestamp.
 */
export async function recordEpisodeCreationNotificationIfEnabled(
  tx: any,
  params: {
    /** The `id` extracted from db.createEpisode's INSERT result (unknown-safe). */
    createdEpisodeId: unknown;
    novelId: number;
    /** The raw parsed `input.isPublished` (boolean | undefined). */
    requestedIsPublished: unknown;
    flags: NotificationRuntimeFlags;
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<EpisodeFirstPublicationOutcome | { status: "skipped_invalid_created_id" }> {
  const createdEpisodeId = Number(params.createdEpisodeId);
  if (!Number.isSafeInteger(createdEpisodeId) || createdEpisodeId < 1 ||
    String(createdEpisodeId) !== String(params.createdEpisodeId)) {
    return { status: "skipped_invalid_created_id" };
  }
  // Mirrors db.createEpisode's isPublished rule exactly: only an explicit
  // false is unpublished; an omitted flag means the episode is born published.
  const effectivePublished = params.requestedIsPublished !== false;
  return recordEpisodeFirstPublicationIfEnabled(tx, {
    episodeId: createdEpisodeId,
    novelId: params.novelId,
    isPublished: effectivePublished,
    flags: params.flags,
    env: params.env,
    occurredAt: params.occurredAt,
  });
}
