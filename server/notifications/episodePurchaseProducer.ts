import { insertQualifiedNotification } from "./eventIngress";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import { resolveNotificationsActivationAt } from "./novelPublicationProducer";
import type { NotificationRuntimeFlags } from "./runtimeGate";

/**
 * P3-A `episode_wallet_purchased` producer.
 *
 * MUST be invoked INSIDE the wallet-purchase business transaction, AFTER the
 * debit and the episodePurchase row both succeeded - the receipt asserts
 * "debited_and_entitled" and the event/outbox join that transaction's fate
 * (a rollback of the purchase removes the event and outbox together, leaving
 * no charge without notification trace and no notification without charge).
 *
 * Notification-side identity problems (invalid purchase id, invalid optional
 * configuration) NEVER fail the purchase: they skip the notification and the
 * business outcome proceeds unchanged. Only infrastructure failures inside
 * the event/outbox writes propagate, which aborts the whole purchase
 * transaction (no partial money movement - the debit rolls back too) and is
 * retriable by the buyer.
 *
 * The receipt carries IDs only - never amounts, balances, wallet internals
 * or payment credentials.
 */
export type EpisodeWalletPurchaseOutcome =
  | { status: "disabled" }
  | { status: "skipped_invalid_identity" }
  | { status: "skipped_invalid_activation_config" }
  | { status: "skipped_before_activation" }
  | { status: "duplicate"; eventKey: string }
  | { status: "created"; eventKey: string };

export async function recordEpisodeWalletPurchaseIfEnabled(
  tx: any,
  params: {
    /** Authoritative episodePurchases.id from the INSERT inside this transaction. */
    purchaseId: number;
    /** The buyer - the single notification recipient. */
    userId: number;
    /** Fixed flags snapshot - same process-lifetime policy as the API mount. */
    flags: NotificationRuntimeFlags;
    /** Process environment; read ONLY after the gates pass. */
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<EpisodeWalletPurchaseOutcome> {
  const { purchaseId, userId, flags, env } = params;
  const occurredAt = params.occurredAt ?? new Date();
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1 ||
    !Number.isSafeInteger(userId) || userId < 1) {
    return { status: "skipped_invalid_identity" };
  }
  // Gate FIRST, before ANY notification-only configuration or table access:
  // a disabled deployment performs zero notification SQL and the purchase
  // behaves exactly as it did before this producer existed.
  if (!flags.notificationsEnabled) {
    return { status: "disabled" };
  }
  // Activation cutoff is resolved only after the gate; an invalid optional
  // configuration fails closed for the notification (no event) without
  // touching the purchase outcome.
  let activationAt: Date;
  try {
    activationAt = resolveNotificationsActivationAt(env, occurredAt);
  } catch {
    return { status: "skipped_invalid_activation_config" };
  }
  const outcome = await insertQualifiedNotification(
    createTransactionalEventOutboxAdapter(tx, occurredAt, activationAt),
    {
      kind: "episode_wallet_purchased",
      purchaseId,
      transitionKey: "settled",
      settlement: "debited_and_entitled",
      userId,
    },
  );
  if (outcome.status === "created") return { status: "created", eventKey: outcome.eventKey };
  if (outcome.status === "skipped") return { status: "skipped_before_activation" };
  return { status: "duplicate", eventKey: outcome.eventKey };
}
