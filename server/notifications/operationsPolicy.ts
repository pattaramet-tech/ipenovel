import type { NotificationKind } from "./contract";

/** Fail-closed, independently controllable gates (proposed environment keys). */
export interface NotificationSwitches {
  producerEnabled: boolean;
  deliveryEnabled: boolean;
  inboxEnabled: boolean;
  catalogFanoutEnabled: boolean;
  checkinRemindersEnabled: boolean;
}
export const NOTIFICATION_SWITCH_ENV_KEYS = Object.freeze({
  producerEnabled:"NOTIFICATIONS_ENABLED",
  deliveryEnabled:"NOTIFICATIONS_DELIVERY_ENABLED",
  inboxEnabled:"NOTIFICATIONS_INBOX_ENABLED",
  catalogFanoutEnabled:"NOTIFICATIONS_CATALOG_FANOUT_ENABLED",
  checkinRemindersEnabled:"NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED",
} satisfies Record<keyof NotificationSwitches,string>);

function explicitEnabled(value: unknown):boolean {
  // Never treat strings like "yes", "1" or "false " as enabled.
  return value === "true";
}
export function resolveNotificationSwitches(env:Readonly<Record<string,string|undefined>>):NotificationSwitches {
  return {
    producerEnabled: explicitEnabled(env.NOTIFICATIONS_ENABLED),
    deliveryEnabled: explicitEnabled(env.NOTIFICATIONS_DELIVERY_ENABLED),
    inboxEnabled: explicitEnabled(env.NOTIFICATIONS_INBOX_ENABLED),
    catalogFanoutEnabled: explicitEnabled(env.NOTIFICATIONS_CATALOG_FANOUT_ENABLED),
    checkinRemindersEnabled: explicitEnabled(env.NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED),
  };
}

export function mayCaptureNotification(
  kind:NotificationKind,
  switches:NotificationSwitches,
):boolean {
  if(!switches.producerEnabled)return false;
  if(kind==="novel_published"||kind==="wishlist_episodes_published") {
    return switches.catalogFanoutEnabled;
  }
  if(kind==="daily_checkin_reminder") return switches.checkinRemindersEnabled;
  return true;
}

/** Pausing the worker must not undo / roll back the original domain outcome. */
export function mayProcessNotificationWorker(switches:NotificationSwitches):boolean {
  return switches.deliveryEnabled;
}

export interface NotificationRetentionPolicy {
  /** Informational user-owned inbox expiry, not authoritative business ledger expiry. */
  inboxDays:number;
  /** Never prune processed outbox before uniqueness/tombstones can reject replay. */
  completedOutboxDays:number;
  replayDedupeDays:number;
  tombstoneDays:number;
  failedAndDeadLetterRetained:boolean;
}
export const DEFAULT_NOTIFICATION_RETENTION:Readonly<NotificationRetentionPolicy>=Object.freeze({
  inboxDays:90,completedOutboxDays:30,replayDedupeDays:180,
  tombstoneDays:180,failedAndDeadLetterRetained:true,
});
/**
 * Do not start any DB cleanup job without verification and release approval.
 * This validator prevents shortening replay protections below source retention.
 */
export function validateNotificationRetention(policy:NotificationRetentionPolicy):void {
  const durations=[policy.inboxDays,policy.completedOutboxDays,policy.replayDedupeDays,policy.tombstoneDays];
  if(durations.some(value=>!Number.isSafeInteger(value)||value<1||value>3650)||
    policy.replayDedupeDays<policy.completedOutboxDays||
    policy.tombstoneDays<policy.replayDedupeDays||
    !policy.failedAndDeadLetterRetained){
    throw Error("Unsafe notification retention policy");
  }
}
