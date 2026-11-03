import {
  runInAppDeliveryTick, type NotificationDeliveryStore, type TickResult,
  type DeliveryLimits, DEFAULT_DELIVERY_LIMITS,
} from "./deliveryPolicy";

/**
 * Fail-closed feature gates. Reading these values does not connect to a DB,
 * mount a route, start a timer, or perform a historical notification backfill.
 * A deployment must explicitly set both master and delivery gates to "true".
 */
export interface NotificationRuntimeFlags {
  notificationsEnabled: boolean;
  deliveryEnabled: boolean;
  checkinRemindersEnabled: boolean;
  catalogFanoutEnabled: boolean;
}
export function readNotificationRuntimeFlags(
  env: Readonly<Record<string, string | undefined>>,
): NotificationRuntimeFlags {
  return {
    notificationsEnabled: env.NOTIFICATIONS_ENABLED === "true",
    deliveryEnabled: env.NOTIFICATIONS_DELIVERY_ENABLED === "true",
    checkinRemindersEnabled: env.NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED === "true",
    catalogFanoutEnabled: env.NOTIFICATIONS_CATALOG_FANOUT_ENABLED === "true",
  };
}

export type NotificationTickOutcome =
  | { status: "disabled" }
  | { status: "busy" }
  | { status: "completed"; result: TickResult };

/**
 * One in-process runner prevents duplicate local ticks. Cross-process
 * exclusivity is enforced separately by the SQL store's DB-backed leases.
 * No interval is installed here: orchestration must be explicitly wired
 * only after the migration and real-DB/browser qualification pass.
 */
export function createNotificationDeliveryRunner(
  store: NotificationDeliveryStore,
  flags: NotificationRuntimeFlags,
  clock: () => Date = () => new Date(),
  limits: DeliveryLimits = DEFAULT_DELIVERY_LIMITS,
): () => Promise<NotificationTickOutcome> {
  let running = false;
  return async () => {
    if (!flags.notificationsEnabled || !flags.deliveryEnabled) {
      return { status: "disabled" };
    }
    if (running) return { status: "busy" };
    running = true;
    try {
      const result = await runInAppDeliveryTick(store, clock(), limits);
      return { status: "completed", result };
    } finally {
      running = false;
    }
  };
}
