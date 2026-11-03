import { and, eq } from "drizzle-orm";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";
import { notificationEvents, notificationPublicationMarkers } from "./tables";
import { insertQualifiedNotification } from "./eventIngress";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import type { NotificationRuntimeFlags } from "./runtimeGate";

/**
 * P1 `novel_published` producer (admin/author catalog flows only).
 *
 * MUST be invoked INSIDE the caller-owned business transaction, AFTER the
 * successful publication write; every notification write below joins that
 * transaction's fate (rollback removes event, outbox and marker together).
 *
 * First-publication identity is proven by an atomic insert into
 * notificationPublicationMarkers (unique entityType+entityId): exactly one
 * transition can win the claim; a duplicate-key loss proves an earlier
 * first publication and suppresses emission (unpublish -> republish can
 * never replay). Pre-activation transitions claim the marker but produce no
 * deliverable event (the outbox adapter's activation cutoff skips them), so
 * historical backfill is impossible.
 *
 * PROVENANCE POLICY (R40R45R1): an ABSENT marker is NOT proof that a novel
 * has never been published - legacy and Workspace-published novels carry no
 * marker. Therefore the ONLY wired caller is the provable one:
 * createAuthorOwnedNovelWithDb creating the novel "published" inside the
 * very transaction that inserts it. The catalog update/publish paths
 * deliberately do NOT call this producer (archived -> published alone
 * proves nothing about first-ever publication; without durable provenance
 * they fail closed by not emitting, while publishing itself behaves
 * normally). This path stays explicitly unsupported until a provable
 * provenance mechanism exists.
 */
export type NovelFirstPublicationOutcome =
  | { status: "disabled" }
  | { status: "skipped_not_first_public" }
  | { status: "skipped_before_activation" }
  | { status: "duplicate"; eventKey: string }
  | { status: "created"; eventKey: string };

/**
 * Activation watermark for the historical-backfill cutoff. Operators may pin
 * NOTIFICATIONS_ACTIVATION_AT so only publications at/after that instant are
 * deliverable; when unset the watermark is the transition instant itself (a
 * live transition is inherently post-activation).
 *
 * Strict validation: the value must be an EXPLICITLY qualified UTC
 * ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SS[.mmm]Z) AND a REAL UTC calendar
 * date/time - each field is round-tripped component-wise, so nonexistent
 * dates such as 2026-02-30 or 2026-02-29 in a non-leap year are rejected
 * instead of silently rolling over to the next month. Naive local or
 * date-only strings are rejected so an operator can never accidentally
 * pin a timezone-dependent watermark. Resolved ONLY after the enabled
 * gates pass - an invalid optional notification setting can never
 * interrupt a catalog publication while notifications are disabled.
 */
const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export function resolveNotificationsActivationAt(
  env: Readonly<Record<string, string | undefined>>,
  fallback: Date,
): Date {
  const raw = env.NOTIFICATIONS_ACTIVATION_AT;
  if (raw === undefined || raw === "") return fallback;
  if (!STRICT_UTC_TIMESTAMP.test(raw)) {
    throw new Error("NOTIFICATIONS_ACTIVATION_AT must be a fully qualified UTC timestamp, e.g. 2026-10-27T00:00:00.000Z");
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const hours = Number(raw.slice(11, 13));
  const minutes = Number(raw.slice(14, 16));
  const seconds = Number(raw.slice(17, 19));
  const millis = raw.length > 20 ? Number(raw.slice(20, 23)) : 0;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day || parsed.getUTCHours() !== hours ||
    parsed.getUTCMinutes() !== minutes || parsed.getUTCSeconds() !== seconds ||
    parsed.getUTCMilliseconds() !== millis) {
    throw new Error("NOTIFICATIONS_ACTIVATION_AT is not a real UTC calendar date/time (e.g. 2026-02-30 does not exist)");
  }
  return parsed;
}

export async function recordNovelFirstPublicationIfEnabled(
  tx: any,
  params: {
    novelId: number;
    /** Fixed flags snapshot - same process-lifetime policy as the API mount. */
    flags: NotificationRuntimeFlags;
    /** Process environment; read ONLY after the gates pass. */
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<NovelFirstPublicationOutcome> {
  const { novelId, flags, env } = params;
  const occurredAt = params.occurredAt ?? new Date();
  if (!Number.isSafeInteger(novelId) || novelId < 1) {
    throw new Error("Invalid novel publication identity");
  }
  // Gate FIRST, before ANY notification-only configuration is parsed: a
  // disabled deployment performs zero notification SQL and an invalid
  // optional notification setting can never interrupt a catalog publication.
  if (!flags.notificationsEnabled || !flags.catalogFanoutEnabled) {
    return { status: "disabled" };
  }
  const activationAt = resolveNotificationsActivationAt(env, occurredAt);
  // Atomic first-publication claim. Losing the unique (entityType, entityId)
  // insert proves an earlier transition already claimed first-public status.
  try {
    await tx.insert(notificationPublicationMarkers).values({
      entityType: "novel",
      entityId: BigInt(novelId),
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
    { kind: "novel_published", novelId, transitionKey: "first_public", firstPublicTransition: true },
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
          eq(notificationPublicationMarkers.entityType, "novel"),
          eq(notificationPublicationMarkers.entityId, BigInt(novelId)),
        ));
    }
  }
  if (outcome.status === "created") return { status: "created", eventKey: outcome.eventKey };
  if (outcome.status === "skipped") return { status: "skipped_before_activation" };
  return { status: "duplicate", eventKey: outcome.eventKey };
}
