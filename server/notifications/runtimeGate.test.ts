import { describe, expect, it, vi } from "vitest";
import { createNotificationDeliveryRunner, readNotificationRuntimeFlags } from "./runtimeGate";
import type { NotificationDeliveryStore } from "./deliveryPolicy";

function mockStore(): NotificationDeliveryStore {
  return {
    claimReadyEvents: vi.fn(async () => []),
    readAudience: vi.fn(async () => ({ userIds: [], nextCursor: null })),
    insertRecipientIfAbsent: vi.fn(async () => "created"),
    checkpointAudience: vi.fn(async () => {}),
    completeEvent: vi.fn(async () => {}),
    scheduleRetry: vi.fn(async () => {}),
    deadLetter: vi.fn(async () => {}),
  };
}
const enabled = {
  notificationsEnabled: true, deliveryEnabled: true,
  checkinRemindersEnabled: false, catalogFanoutEnabled: false,
};

describe("fail-closed notifications runtime gate", () => {
  it("defaults all proposed flags to disabled", () => {
    expect(readNotificationRuntimeFlags({})).toEqual({
      notificationsEnabled: false, deliveryEnabled: false,
      checkinRemindersEnabled: false, catalogFanoutEnabled: false,
    });
  });

  it("does not treat truthy-looking strings as permission", () => {
    const flags = readNotificationRuntimeFlags({
      NOTIFICATIONS_ENABLED: "TRUE",
      NOTIFICATIONS_DELIVERY_ENABLED: "1",
      NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED: "yes",
      NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "on",
    });
    expect(Object.values(flags)).toEqual([false, false, false, false]);
  });

  it("requires both master and delivery gates before touching the DB", async () => {
    const store = mockStore();
    const run = createNotificationDeliveryRunner(store, { ...enabled, deliveryEnabled: false });
    expect(await run()).toEqual({ status: "disabled" });
    expect(store.claimReadyEvents).not.toHaveBeenCalled();
  });

  it("runs one bounded tick when explicitly enabled", async () => {
    const store = mockStore();
    const run = createNotificationDeliveryRunner(store, enabled);
    expect(await run()).toMatchObject({ status: "completed", result: { claimed: 0 } });
    expect(store.claimReadyEvents).toHaveBeenCalledTimes(1);
  });

  it("skips a concurrent tick without a second DB claim", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const store = mockStore();
    store.claimReadyEvents = vi.fn(async () => { await hold; return []; });
    const run = createNotificationDeliveryRunner(store, enabled);
    const first = run();
    expect(await run()).toEqual({ status: "busy" });
    release();
    expect(await first).toMatchObject({ status: "completed" });
    expect(store.claimReadyEvents).toHaveBeenCalledTimes(1);
  });

  it("releases the local busy fence after a failed tick", async () => {
    const store = mockStore();
    store.claimReadyEvents = vi.fn()
      .mockRejectedValueOnce(new Error("temporary DB failure"))
      .mockResolvedValueOnce([]);
    const run = createNotificationDeliveryRunner(store, enabled);
    await expect(run()).rejects.toThrow("temporary DB failure");
    expect(await run()).toMatchObject({ status: "completed" });
    expect(store.claimReadyEvents).toHaveBeenCalledTimes(2);
  });
});
