import { TRPCError } from "@trpc/server";
import type { NotificationApiStore } from "./api";
import { createInboxDataStore } from "./inboxDataStore";
import { readNotificationRuntimeFlags, type NotificationRuntimeFlags } from "./runtimeGate";

/**
 * Application wiring helpers for mounting the notifications router in
 * server/routers.ts. Kept out of the router file so the fail-closed gate,
 * key parsing and lazy database adapter are unit-testable without
 * importing the whole app router.
 *
 * Configuration snapshot discipline: callers read the runtime flags ONCE
 * (readNotificationRuntimeFlags) and pass the same snapshot to the gate and
 * the store adapter, so the disabled/enabled decision cannot drift between
 * the two for the lifetime of the process. The cursor signing key is never
 * materialised as a placeholder - it is resolved from the environment on
 * first gated use and cached.
 *
 * Deployment ordering: the account lifecycle assessments in server/db.ts
 * (account recovery / admin user deletion / account merge) query the
 * notification tables, so this code requires migration
 * 0067_notifications_engagement to be applied to the target database
 * BEFORE (or together with) the application release - never the reverse.
 * Release remains HOLD until the disposable-DB and staging-first
 * qualification in docs/IPE-NOTIFICATIONS-ROLL-OUT-PLAN.md pass.
 */

export type NotificationsEnv = Readonly<Record<string, string | undefined>>;

/**
 * Fail-closed master gate over a FIXED flags snapshot: throws NOT_FOUND
 * unless the snapshot has notificationsEnabled === true. Intended as the
 * router's procedure gate so a disabled deployment rejects every
 * notification endpoint before any cursor validation, key material use or
 * database access.
 */
export function requireNotificationsEnabled(flags: NotificationRuntimeFlags): void {
  if (!flags.notificationsEnabled) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Notifications are not available" });
  }
}

/**
 * Parses NOTIFICATIONS_CURSOR_SIGNING_KEY as an EVEN number of hex
 * characters decoding to >=32 raw bytes (zod-independent mirror of the
 * >=32-byte secret rule). Throws loudly when missing, malformed, or of odd
 * length; the key value itself is never logged.
 */
export function readCursorSigningKeyFromEnv(env: NotificationsEnv): Buffer {
  const raw = env.NOTIFICATIONS_CURSOR_SIGNING_KEY ?? "";
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) {
    throw new Error(
      "NOTIFICATIONS_CURSOR_SIGNING_KEY must be configured as at least 64 hex characters (an even-length hex string decoding to >=32 bytes)",
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * NotificationApiStore adapter whose first action on EVERY call is the
 * enabled gate over the CALLER'S flags snapshot, so a disabled deployment
 * can never reach the notification schema and a mid-process environment
 * change cannot activate it either. The real SQL store is constructed
 * lazily from the application's lazy getDb() (importing this module never
 * connects; the store is created once per adapter after the first gated
 * call succeeds).
 */
export function createLazyNotificationsApiStore(
  loadDatabase: () => Promise<unknown>,
  flags: NotificationRuntimeFlags,
): NotificationApiStore {
  let cached: NotificationApiStore | null = null;
  const load = async (): Promise<NotificationApiStore> => {
    requireNotificationsEnabled(flags);
    if (cached === null) {
      const dbConnection = await loadDatabase();
      if (!dbConnection || typeof (dbConnection as { transaction?: unknown }).transaction !== "function") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
      cached = createInboxDataStore(dbConnection);
    }
    return cached;
  };
  return {
    listOwnInbox: async (query) => (await load()).listOwnInbox(query),
    countOwnUnread: async (actorUserId) => (await load()).countOwnUnread(actorUserId),
    markOwnRead: async (actorUserId, notificationId) =>
      (await load()).markOwnRead(actorUserId, notificationId),
    getOwnPreferences: async (actorUserId) => (await load()).getOwnPreferences(actorUserId),
    setOwnPreference: async (actorUserId, kind, enabled) =>
      (await load()).setOwnPreference(actorUserId, kind, enabled),
    bulk: {
      transaction: async (fn) => (await load()).bulk.transaction(fn),
    },
  };
}
