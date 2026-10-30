import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  createLazyNotificationsApiStore,
  readCursorSigningKeyFromEnv,
  requireNotificationsEnabled,
} from "./appWiring";
import { readNotificationRuntimeFlags } from "./runtimeGate";

// Top-level vitest hoisting: nested vi.hoisted/vi.mock declarations made the
// transformed module re-declare identifiers after dependency cache invalidation.
const inboxStoreMocks = vi.hoisted(() => ({ createInboxDataStore: vi.fn() }));
vi.mock("./inboxDataStore", () => ({ createInboxDataStore: inboxStoreMocks.createInboxDataStore }));

const ENABLED_FLAGS = readNotificationRuntimeFlags({ NOTIFICATIONS_ENABLED: "true" });
const DISABLED_FLAGS = readNotificationRuntimeFlags({});

describe("notifications fail-closed runtime gate (fixed snapshot)", () => {
  it("throws NOT_FOUND unless the snapshot has NOTIFICATIONS_ENABLED exactly true", () => {
    for (const env of [{}, { NOTIFICATIONS_ENABLED: "" }, { NOTIFICATIONS_ENABLED: "1" }, { NOTIFICATIONS_ENABLED: "TRUE" }, { NOTIFICATIONS_ENABLED: "false" }]) {
      const flags = readNotificationRuntimeFlags(env);
      try {
        requireNotificationsEnabled(flags);
        expect.unreachable("disabled snapshot must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TRPCError);
        expect((error as TRPCError).code).toBe("NOT_FOUND");
      }
    }
    expect(() => requireNotificationsEnabled(ENABLED_FLAGS)).not.toThrow();
  });

  it("is decided by the snapshot, not by a later environment change", () => {
    const env: Record<string, string | undefined> = {};
    const flags = readNotificationRuntimeFlags(env);
    env.NOTIFICATIONS_ENABLED = "true";
    expect(() => requireNotificationsEnabled(flags)).toThrowError(TRPCError);
  });
});

describe("cursor signing key configuration", () => {
  it("fails closed on missing, short, odd-length or non-hex configuration", () => {
    const invalid: Array<Record<string, string | undefined>> = [
      {},
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: "" },
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: "abcd" },
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: "z".repeat(64) },
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: "a".repeat(63) },
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: "a".repeat(65) },
      { NOTIFICATIONS_CURSOR_SIGNING_KEY: Buffer.alloc(31, 7).toString("hex") },
    ];
    for (const env of invalid) {
      expect(() => readCursorSigningKeyFromEnv(env)).toThrowError(/NOTIFICATIONS_CURSOR_SIGNING_KEY/);
    }
  });

  it("accepts even-length hex decoding to at least 32 bytes and never echoes the key in errors", () => {
    const secret = "AB" + "0".repeat(62);
    expect(readCursorSigningKeyFromEnv({ NOTIFICATIONS_CURSOR_SIGNING_KEY: secret }).length).toBe(32);
    expect(readCursorSigningKeyFromEnv({ NOTIFICATIONS_CURSOR_SIGNING_KEY: "f".repeat(96) }).length).toBe(48);
    try {
      readCursorSigningKeyFromEnv({ NOTIFICATIONS_CURSOR_SIGNING_KEY: "deadbeef-secret" });
      expect.unreachable("malformed key must throw");
    } catch (error) {
      expect(String(error)).not.toContain("deadbeef-secret");
    }
  });
});

describe("lazy notification store adapter (snapshot-gated)", () => {
  function fakeStore() {
    return {
      listOwnInbox: vi.fn(async () => []),
      countOwnUnread: vi.fn(async () => 0),
      markOwnRead: vi.fn(async () => true),
      getOwnPreferences: vi.fn(async () => ({})),
      setOwnPreference: vi.fn(async () => {}),
      bulk: { transaction: vi.fn(async (fn: (tx: null) => Promise<number>) => fn(null)) },
    };
  }

  it("when the snapshot is disabled, every call throws NOT_FOUND and the database is never touched", async () => {
    const loadDatabase = vi.fn();
    const store = createLazyNotificationsApiStore(loadDatabase, DISABLED_FLAGS);
    await expect(store.listOwnInbox({ actorUserId: 7, category: "all", unreadOnly: false, beforeSequence: null, limit: 20 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.countOwnUnread(7)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.markOwnRead(7, "11")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.getOwnPreferences(7)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.setOwnPreference(7, "novel_published", false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.bulk.transaction(async () => 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(loadDatabase).not.toHaveBeenCalled();
    expect(inboxStoreMocks.createInboxDataStore).not.toHaveBeenCalled();
  });

  it("an environment flipped to enabled after the snapshot cannot activate the adapter", async () => {
    const loadDatabase = vi.fn();
    const env: Record<string, string | undefined> = {};
    const store = createLazyNotificationsApiStore(loadDatabase, readNotificationRuntimeFlags(env));
    env.NOTIFICATIONS_ENABLED = "true";
    await expect(store.countOwnUnread(7)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it("when enabled, constructs the SQL store exactly once and forwards calls", async () => {
    const store = fakeStore();
    inboxStoreMocks.createInboxDataStore.mockReset().mockReturnValue(store as never);
    const loadDatabase = vi.fn(async () => ({ transaction: async (fn: (tx: null) => Promise<number>) => fn(null) }));
    const adapter = createLazyNotificationsApiStore(loadDatabase, ENABLED_FLAGS);
    await adapter.countOwnUnread(7);
    await adapter.countOwnUnread(7);
    expect(loadDatabase).toHaveBeenCalledTimes(1);
    expect(inboxStoreMocks.createInboxDataStore).toHaveBeenCalledTimes(1);
    expect(store.countOwnUnread).toHaveBeenCalledWith(7);
    await expect(adapter.bulk.transaction(async () => 42)).resolves.toBe(42);
  });

  it("fails closed on a database that is unavailable or lacks transaction support", async () => {
    inboxStoreMocks.createInboxDataStore.mockReset();
    const unavailable = createLazyNotificationsApiStore(async () => null, ENABLED_FLAGS);
    await expect(unavailable.countOwnUnread(7)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(inboxStoreMocks.createInboxDataStore).not.toHaveBeenCalled();

    const malformed = createLazyNotificationsApiStore(async () => ({}), ENABLED_FLAGS);
    await expect(malformed.countOwnUnread(7)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(inboxStoreMocks.createInboxDataStore).not.toHaveBeenCalled();
  });
});

describe("router construction with a lazy signing key provider", () => {
  let routerModule: typeof import("./api");

  it("a disabled deployment constructs the router without any key material and every call fails closed", async () => {
    routerModule = await import("./api");
    const keyProvider = vi.fn(() => { throw new Error("must not resolve a key while disabled"); });
    const store = createLazyNotificationsApiStore(vi.fn(), DISABLED_FLAGS);
    const notifications = routerModule.createNotificationsRouter({
      store,
      cursorSigningKey: keyProvider,
      gate: () => requireNotificationsEnabled(DISABLED_FLAGS),
    });
    const caller = notifications.createCaller({ user: { id: 7, role: "user" } } as never);
    await expect(caller.unreadCount()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.list({ cursor: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(keyProvider).not.toHaveBeenCalled();
  });

  it("an enabled deployment with a missing key fails closed per call while startup construction still succeeds", async () => {
    routerModule = await import("./api");
    const store = createLazyNotificationsApiStore(vi.fn(), ENABLED_FLAGS);
    const keyProvider = vi.fn(() => readCursorSigningKeyFromEnv({}));
    const notifications = routerModule.createNotificationsRouter({
      store,
      cursorSigningKey: keyProvider,
      gate: () => {
        requireNotificationsEnabled(ENABLED_FLAGS);
        keyProvider();
      },
    });
    const caller = notifications.createCaller({ user: { id: 7, role: "user" } } as never);
    await expect(caller.list({})).rejects.toThrowError(/NOTIFICATIONS_CURSOR_SIGNING_KEY/);
    expect(inboxStoreMocks.createInboxDataStore).not.toHaveBeenCalled();
  });
});
