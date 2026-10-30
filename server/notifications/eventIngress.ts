import { bangkokDayKey, eventDedupeKey, type NotificationKind } from "./contract";

/**
 * This input must be assembled from authoritative DB rows INSIDE the same
 * successful business transaction; it is never a public API request object.
 * Runtime checks reject unqualified outcome statuses but cannot independently
 * prove a caller actually completed the money/entitlement/publish mutation.
 */
export type BusinessOutcomeReceipt =
  | { kind: "wallet_topup_approved"; topupId: number; transitionKey: string;
      settlement: "credited"; userId: number }
  | { kind: "wallet_topup_rejected"; topupId: number; transitionKey: string;
      settlement: "rejected"; userId: number }
  | { kind: "order_completed"; orderId: number; transitionKey: string;
      settlement: "purchases_finalized"; userId: number }
  | { kind: "episode_wallet_purchased"; purchaseId: number; transitionKey: string;
      settlement: "debited_and_entitled"; userId: number }
  | { kind: "novel_published"; novelId: number; transitionKey: string;
      firstPublicTransition: true }
  | { kind: "wishlist_episodes_published"; novelId: number; batchKey: string;
      partIndex: number; transitionKey: string; firstPublicEpisodeIds: readonly number[] }
  | { kind: "daily_checkin_reminder"; campaignKey: string; userId: number;
      day: Date; campaignEnabled: true; optedIn: true; alreadyCheckedIn: false };

export interface ValidatedNotificationEvent {
  kind: NotificationKind;
  key: string;
  sourceType: string;
  sourceId: string;
  transitionKey: string;
  targetUserId: number | null;
  /** Reference IDs only; never chapter content, customer tokens or slip URLs. */
  episodeIds: readonly number[];
}

export interface BusinessNotificationTransaction {
  /**
   * Must use UNIQUE immutable event key and create outbox in the same
   * transaction, with both rolled back if original business write aborts.
   */
  insertEventWithOutboxIfAbsent(event: ValidatedNotificationEvent): Promise<"created" | "duplicate" | "skipped">;
}

function positiveId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid notification domain ID");
  return String(id);
}
function stableKey(input: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(input)) throw new Error("Invalid transition identity");
  return input;
}
function checkTarget(id: number): number {
  positiveId(id);
  return id;
}

/**
 * Side-effect limited to insertEventWithOutboxIfAbsent; this routine has no
 * access to wallet, order, entitlement, approval or publication methods.
 */
export function qualifyBusinessNotification(receipt: BusinessOutcomeReceipt): ValidatedNotificationEvent {
  let sourceType: string, sourceId: string, transitionKey: string;
  let targetUserId: number | null = null;
  let episodeIds: readonly number[] = [];
  const kind = receipt.kind;
  switch (kind) {
    case "wallet_topup_approved":
      if (receipt.settlement !== "credited") throw new Error("Topup credit is not settled");
      sourceType = "wallet_topups"; sourceId = positiveId(receipt.topupId);
      transitionKey = stableKey(receipt.transitionKey); targetUserId = checkTarget(receipt.userId);
      break;
    case "wallet_topup_rejected":
      if (receipt.settlement !== "rejected") throw new Error("Topup is not rejected");
      sourceType = "wallet_topups"; sourceId = positiveId(receipt.topupId);
      transitionKey = stableKey(receipt.transitionKey); targetUserId = checkTarget(receipt.userId);
      break;
    case "order_completed":
      if (receipt.settlement !== "purchases_finalized") throw new Error("Order is not finalized");
      sourceType = "orders"; sourceId = positiveId(receipt.orderId);
      transitionKey = stableKey(receipt.transitionKey); targetUserId = checkTarget(receipt.userId);
      break;
    case "episode_wallet_purchased":
      if (receipt.settlement !== "debited_and_entitled") throw new Error("Episode purchase is not settled");
      sourceType = "episode_purchases"; sourceId = positiveId(receipt.purchaseId);
      transitionKey = stableKey(receipt.transitionKey); targetUserId = checkTarget(receipt.userId);
      break;
    case "novel_published":
      if (receipt.firstPublicTransition !== true) throw new Error("Novel has not first published");
      sourceType = "novels"; sourceId = positiveId(receipt.novelId);
      transitionKey = stableKey(receipt.transitionKey);
      break;
    case "wishlist_episodes_published": {
      const batch = stableKey(receipt.batchKey);
      if (batch.length > 72) throw new Error("Invalid publication batch identity");
      if (!Number.isSafeInteger(receipt.partIndex) || receipt.partIndex < 0 || receipt.partIndex > 99999) {
        throw new Error("Invalid publication partition identity");
      }
      sourceType = "novel_publish_batches";
      sourceId = `${positiveId(receipt.novelId)}_${batch}_${receipt.partIndex}`;
      transitionKey = stableKey(receipt.transitionKey);
      const ids = Array.from(new Set(receipt.firstPublicEpisodeIds)).sort((a, b) => a - b);
      if (ids.length === 0 || ids.length > 50) throw new Error("Invalid publication digest size");
      ids.forEach(positiveId);
      episodeIds = ids;
      break;
    }
    case "daily_checkin_reminder":
      if (!receipt.campaignEnabled || !receipt.optedIn || receipt.alreadyCheckedIn) {
        throw new Error("Check-in reminder is ineligible");
      }
      targetUserId = checkTarget(receipt.userId);
      sourceType = "checkin_campaign"; sourceId = stableKey(receipt.campaignKey);
      transitionKey = `${targetUserId}_${bangkokDayKey(receipt.day).replace(/-/g,"")}`;
      break;
    default:
      throw new Error("Unsupported notification outcome");
  }
  return {
    kind, key: eventDedupeKey({kind, sourceType, sourceId, transitionId: transitionKey}),
    sourceType, sourceId, transitionKey, targetUserId, episodeIds,
  };
}

export async function insertQualifiedNotification(
  tx: BusinessNotificationTransaction,
  receipt: BusinessOutcomeReceipt,
): Promise<{ eventKey: string; created: boolean; status: "created" | "duplicate" | "skipped" }> {
  const event = qualifyBusinessNotification(receipt);
  const result = await tx.insertEventWithOutboxIfAbsent(event);
  if (result !== "created" && result !== "duplicate" && result !== "skipped") throw new Error("Invalid notification insert result");
  return { eventKey: event.key, created: result === "created", status: result };
}
