import { eq } from "drizzle-orm";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";
import {
  notificationDigestEpisodes,
  notificationEvents,
  notificationOutbox,
} from "./tables";
import type { BusinessNotificationTransaction, ValidatedNotificationEvent } from "./eventIngress";
import { isEventAfterActivation } from "./contract";

/**
 * Call ONLY within a caller-owned business transaction that also commits
 * wallet/order/purchase/publish outcomes. Do not create a new transaction
 * here and NEVER invoke a source domain action from the notification worker.
 *
 * This adapter must remain unmounted until the additive migration is applied
 * to an identity-verified disposable DB and all transaction paths are tested.
 */
export function createTransactionalEventOutboxAdapter(
  tx: any,
  eventOccurredAt: Date,
  activationAt: Date,
): BusinessNotificationTransaction {
  const activated = isEventAfterActivation(eventOccurredAt, activationAt);
  return {
    async insertEventWithOutboxIfAbsent(event: ValidatedNotificationEvent) {
      if (!activated) return "skipped";
      if (!Number.isSafeInteger(event.targetUserId ?? 1) || (event.targetUserId ?? 1) < 1) {
        throw new Error("Invalid notification recipient");
      }
      let eventId: bigint;
      try {
        const raw = await tx.insert(notificationEvents).values({
          eventKey:event.key,kind:event.kind,sourceType:event.sourceType,
          sourceId:event.sourceId,transitionKey:event.transitionKey,
          targetUserId:event.targetUserId,
          occurredAt:eventOccurredAt,eligibleAfter:activationAt,
        });
        const header = Array.isArray(raw) ? raw[0] : raw;
        if (!Number.isSafeInteger(header?.insertId) || header.insertId <= 0) {
          throw new Error("Invalid inserted notification event ID");
        }
        eventId = BigInt(header.insertId);
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await tx.select({
          id:notificationEvents.id,kind:notificationEvents.kind,
          sourceType:notificationEvents.sourceType,sourceId:notificationEvents.sourceId,
          transitionKey:notificationEvents.transitionKey,
          targetUserId:notificationEvents.targetUserId,
        }).from(notificationEvents).where(eq(notificationEvents.eventKey,event.key)).limit(1);
        const prior = existing?.[0];
        if (!prior || prior.kind !== event.kind || prior.sourceType !== event.sourceType ||
            prior.sourceId !== event.sourceId || prior.transitionKey !== event.transitionKey ||
            prior.targetUserId !== event.targetUserId) {
          throw new Error("Notification event identity collision");
        }
        return "duplicate";
      }
      // Outbox+event are committed or rolled back with the domain mutation.
      await tx.insert(notificationOutbox).values({
        eventId,state:"pending",attempt:0,
        nextAttemptAt:eventOccurredAt,
      });
      for (const episodeId of event.episodeIds) {
        await tx.insert(notificationDigestEpisodes).values({eventId,episodeId:BigInt(episodeId)});
      }
      return "created";
    },
  };
}
