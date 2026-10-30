import {
  DEFAULT_DELIVERY_LIMITS,
  type DeliveryLimits,
  type NotificationDeliveryStore,
} from "./deliveryPolicy";
import { createQualifiedSqlAudienceReader } from "./sqlAudienceReader";
import { createSqlNotificationDeliveryStore } from "./sqlDeliveryStore";
import {
  createNotificationDeliveryRunner,
  type NotificationTickOutcome,
  type NotificationRuntimeFlags,
} from "./runtimeGate";

/**
 * R40R57 CONTROLLED RUNTIME COMPOSITION - the ONLY sanctioned way to
 * assemble the notification delivery pipeline:
 *
 *   business event -> outbox -> [this runtime] -> qualified audience
 *   -> recipient -> inbox
 *
 * It wires the EXISTING pieces together (qualified SQL audience reader ->
 * fenced SQL delivery store -> in-app one-shot runner) and deliberately adds
 * nothing else:
 *   - NO timer, interval, cron or background polling is ever installed. The
 *     runtime only acts on an EXPLICIT `tick()` call (one-shot invocation by
 *     the qualification harness or a future, separately-gated scheduler).
 *   - NO HTTP endpoint, no server-startup hook, no import-time side effect:
 *     importing this module and calling the factory connect to nothing.
 *   - KILL SWITCH FIRST: when either NOTIFICATIONS_ENABLED (master) or
 *     NOTIFICATIONS_DELIVERY_ENABLED is not exactly "true" in the FIXED
 *     flags snapshot, `tick()` resolves {status:"disabled"} without ever
 *     calling `loadDatabase` - a disabled runtime cannot touch the database
 *     even while outbox rows are pending.
 *   - FAIL CLOSED on invalid dependencies: a database without transaction
 *     support, or malformed delivery limits, throws instead of degrading.
 *   - The catalog-fanout and check-in-reminder feature gates pass through
 *     the SAME snapshot to the store's claim gate; both default to OFF.
 *   - The production clock is the real `new Date()` unless a clock is
 *     explicitly injected (test-only knob); the disposable-database test
 *     allowance (+5s) lives in the test harness, never here.
 *   - One composition is ONE worker: the runner's in-process busy guard
 *     collapses overlapping `tick()` calls; cross-process exclusivity stays
 *     with the store's DB lease fencing.
 */
export interface ControlledNotificationRuntimeOptions {
  /** FIXED snapshot - decided once, never re-read from the environment. */
  flags: NotificationRuntimeFlags;
  /** Production wiring passes the lazy getDb(); tests pass the test db. */
  loadDatabase: () => Promise<unknown>;
  /** Defaults to the real production clock. Test-only override. */
  clock?: () => Date;
  /** Defaults to the existing production delivery limits. */
  limits?: DeliveryLimits;
}

export interface ControlledNotificationRuntime {
  readonly flags: NotificationRuntimeFlags;
  /** Explicit one-shot delivery attempt. Never self-scheduled. */
  tick(): Promise<NotificationTickOutcome>;
}

export function createControlledNotificationRuntime(
  options: ControlledNotificationRuntimeOptions,
): ControlledNotificationRuntime {
  const flags = options.flags;
  const clock = options.clock ?? (() => new Date());
  const limits = options.limits ?? DEFAULT_DELIVERY_LIMITS;

  // Kill switch BEFORE any database dependency exists or is requested.
  if (!flags.notificationsEnabled || !flags.deliveryEnabled) {
    return {
      flags,
      tick: async () => ({ status: "disabled" }),
    };
  }

  let store: NotificationDeliveryStore | null = null;
  const loadStore = async (): Promise<NotificationDeliveryStore> => {
    if (store) return store;
    const database = await options.loadDatabase();
    if (!database || typeof (database as { transaction?: unknown }).transaction !== "function") {
      throw new Error("Notification runtime database unavailable");
    }
    store = createSqlNotificationDeliveryStore(
      database,
      createQualifiedSqlAudienceReader(database),
      {
        catalogFanoutEnabled: flags.catalogFanoutEnabled,
        checkinRemindersEnabled: flags.checkinRemindersEnabled,
      },
    );
    return store;
  };

  // Lazy facade: the runner holds the store contract from construction, but
  // no connection is opened until the first enabled tick actually claims.
  const lazyStore: NotificationDeliveryStore = {
    claimReadyEvents: async (now, limit) => (await loadStore()).claimReadyEvents(now, limit),
    readAudience: async (event, limit) => (await loadStore()).readAudience(event, limit),
    insertRecipientIfAbsent: async (event, userId) =>
      (await loadStore()).insertRecipientIfAbsent(event, userId),
    checkpointAudience: async (event, nextCursor) =>
      (await loadStore()).checkpointAudience(event, nextCursor),
    completeEvent: async (event) => (await loadStore()).completeEvent(event),
    scheduleRetry: async (event, retryAt, failureCode) =>
      (await loadStore()).scheduleRetry(event, retryAt, failureCode),
    deadLetter: async (event, failureCode) => (await loadStore()).deadLetter(event, failureCode),
  };

  const runOnce = createNotificationDeliveryRunner(lazyStore, flags, clock, limits);
  return {
    flags,
    tick: runOnce,
  };
}
