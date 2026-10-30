import { insertQualifiedNotification } from "./eventIngress";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import { resolveNotificationsActivationAt } from "./novelPublicationProducer";
import type { NotificationRuntimeFlags } from "./runtimeGate";

/**
 * P3-B `order_completed` producer.
 *
 * MUST be invoked INSIDE the caller-owned business transaction, AFTER payment
 * approval AND a successful `finalizeOrderCompletion` - the receipt asserts
 * "purchases_finalized" and the event/outbox join that transaction's fate.
 *
 * Emission identity: UNIQUE event key (kind + orders + orderId +
 * "first_completion") makes an approval retry, a duplicate approval of an
 * already-approved payment, or an idempotent re-finalization a dedupe no-op
 * - an order can only ever produce one completion event.
 *
 * The receipt carries IDs only - never slip URLs, payment credentials or
 * amounts.
 */
export type OrderCompletionOutcome =
  | { status: "disabled" }
  | { status: "skipped_invalid_identity" }
  | { status: "skipped_invalid_activation_config" }
  | { status: "skipped_before_activation" }
  | { status: "duplicate"; eventKey: string }
  | { status: "created"; eventKey: string };

export async function recordOrderCompletionIfEnabled(
  tx: any,
  params: {
    /** Authoritative orders.id from the business transaction. */
    orderId: number;
    /** The order owner - the single notification recipient. */
    userId: number;
    /** Fixed flags snapshot - same process-lifetime policy as the API mount. */
    flags: NotificationRuntimeFlags;
    /** Process environment; read ONLY after the gates pass. */
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<OrderCompletionOutcome> {
  const { orderId, userId, flags, env } = params;
  const occurredAt = params.occurredAt ?? new Date();
  if (!Number.isSafeInteger(orderId) || orderId < 1 ||
    !Number.isSafeInteger(userId) || userId < 1) {
    return { status: "skipped_invalid_identity" };
  }
  // Gate FIRST, before ANY notification-only configuration or table access.
  if (!flags.notificationsEnabled) {
    return { status: "disabled" };
  }
  // Activation cutoff resolved only after the gate; an invalid optional
  // configuration fails closed for the notification (no event) without
  // touching the business outcome.
  let activationAt: Date;
  try {
    activationAt = resolveNotificationsActivationAt(env, occurredAt);
  } catch {
    return { status: "skipped_invalid_activation_config" };
  }
  const outcome = await insertQualifiedNotification(
    createTransactionalEventOutboxAdapter(tx, occurredAt, activationAt),
    {
      kind: "order_completed",
      orderId,
      transitionKey: "first_completion",
      settlement: "purchases_finalized",
      userId,
    },
  );
  if (outcome.status === "created") return { status: "created", eventKey: outcome.eventKey };
  if (outcome.status === "skipped") return { status: "skipped_before_activation" };
  return { status: "duplicate", eventKey: outcome.eventKey };
}
