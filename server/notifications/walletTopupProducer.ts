import { insertQualifiedNotification } from "./eventIngress";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import { resolveNotificationsActivationAt } from "./novelPublicationProducer";
import type { NotificationRuntimeFlags } from "./runtimeGate";

/**
 * P3-C wallet top-up outcome producer.
 *
 * MUST be invoked INSIDE the caller-owned business transaction, AFTER the
 * conditional status update WON (affectedRows >= 1) AND the wallet credit /
 * rejection log both succeeded - the receipt asserts the final settlement
 * ("credited" / "rejected") and the event/outbox join that transaction's fate.
 *
 * Emission identity: UNIQUE event key (kind + wallet_topups + topupId +
 * settlement transition) - approval retries, idempotent re-rejections and
 * provider replays dedupe to a no-op. Approved top-ups are structurally
 * protected from rejection events: rejectWalletTopup's conditional UPDATE
 * only matches pending/pending_review states, and the activation watermark
 * prevents historical backfill.
 *
 * The receipt carries IDs only - never amounts, balances, slip URLs, OCR
 * payloads, bank references or rejection reasons.
 */
export type WalletTopupSettlement = "credited" | "rejected";

export type WalletTopupOutcome =
  | { status: "disabled" }
  | { status: "skipped_invalid_identity" }
  | { status: "skipped_invalid_activation_config" }
  | { status: "skipped_before_activation" }
  | { status: "duplicate"; eventKey: string }
  | { status: "created"; eventKey: string };

export async function recordWalletTopupOutcomeIfEnabled(
  tx: any,
  params: {
    /** Authoritative walletTopups.id from the business transaction. */
    topupId: number;
    /** The wallet owner - the single notification recipient. */
    userId: number;
    /** Final, verified settlement of this call. */
    settlement: WalletTopupSettlement;
    /** Fixed flags snapshot - same process-lifetime policy as the API mount. */
    flags: NotificationRuntimeFlags;
    /** Process environment; read ONLY after the gates pass. */
    env: Readonly<Record<string, string | undefined>>;
    occurredAt?: Date;
  },
): Promise<WalletTopupOutcome> {
  const { topupId, userId, settlement, flags, env } = params;
  const occurredAt = params.occurredAt ?? new Date();
  if (!Number.isSafeInteger(topupId) || topupId < 1 ||
    !Number.isSafeInteger(userId) || userId < 1) {
    return { status: "skipped_invalid_identity" };
  }
  // Gate FIRST, before ANY notification-only configuration or table access:
  // a disabled deployment performs zero notification SQL and the wallet flow
  // behaves exactly as it did before this producer existed.
  if (!flags.notificationsEnabled) {
    return { status: "disabled" };
  }
  // Activation cutoff resolved only after the gate; an invalid optional
  // configuration fails closed for the notification (no event) without
  // touching the wallet outcome.
  let activationAt: Date;
  try {
    activationAt = resolveNotificationsActivationAt(env, occurredAt);
  } catch {
    return { status: "skipped_invalid_activation_config" };
  }
  const receipt = settlement === "credited"
    ? {
        kind: "wallet_topup_approved" as const,
        topupId,
        transitionKey: "credited",
        settlement: "credited" as const,
        userId,
      }
    : {
        kind: "wallet_topup_rejected" as const,
        topupId,
        transitionKey: "rejected",
        settlement: "rejected" as const,
        userId,
      };
  const outcome = await insertQualifiedNotification(
    createTransactionalEventOutboxAdapter(tx, occurredAt, activationAt),
    receipt,
  );
  if (outcome.status === "created") return { status: "created", eventKey: outcome.eventKey };
  if (outcome.status === "skipped") return { status: "skipped_before_activation" };
  return { status: "duplicate", eventKey: outcome.eventKey };
}
