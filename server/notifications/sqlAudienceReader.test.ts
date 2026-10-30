import { describe, expect, it } from "vitest";
import { createQualifiedSqlAudienceReader } from "./sqlAudienceReader";
import type { ClaimedEvent } from "./deliveryPolicy";

const occurredAt = new Date("2026-10-25T00:00:00Z");
const activationAt = new Date("2026-10-24T00:00:00Z");
const before = new Date("2026-10-23T00:00:00Z");
const after = new Date("2026-10-25T01:00:00Z");
const claimed: ClaimedEvent = {
  eventId: "17", eventKey: "notification:v1:order_completed:orders:3:approved",
  kind: "order_completed", leaseToken: "fenced-token", attempt: 1, audienceCursor: null,
};
function dbRows(...pages: any[][]) {
  const queue = [...pages];
  const db: any = {
    select: () => {
      const rows = queue.shift() ?? [];
      const query: any = {
        from: () => query, where: () => query, limit: () => query,
        innerJoin: () => query, leftJoin: () => query, orderBy: () => query,
        then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    },
  };
  return db;
}
function event(kind: string, targetUserId: number | null, sourceType = "orders", sourceId = "3") {
  return {
    eventKey: claimed.eventKey, kind, targetUserId, sourceType, sourceId,
    occurredAt, eligibleAfter: activationAt,
  };
}
function user(userId: number, override: boolean | null = null,
              updatedAt: Date | null = null, role = "user", wishlistCreatedAt: Date | null = null) {
  return {
    userId, role, preferenceOverride: override,
    preferenceUpdatedAt: updatedAt, wishlistCreatedAt,
  };
}

describe("qualified SQL notification audience reader", () => {
  it("delivers a settled direct finance event to its existing recipient by default", async () => {
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("order_completed", 2)], [user(2)],
    ));
    expect(await read(claimed, 100)).toEqual({ userIds: [2], nextCursor: null });
  });

  it("does not deliver a direct event after the user opted out", async () => {
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("order_completed", 2)], [user(2, false, before)],
    ));
    expect(await read(claimed, 100)).toEqual({ userIds: [], nextCursor: null });
  });

  it("never backfills an opt-in-only check-in reminder after late opt-in", async () => {
    const reminder = { ...claimed, kind: "daily_checkin_reminder" as const };
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("daily_checkin_reminder", 2, "checkin_campaign", "daily")],
      [user(2, true, after)],
    ));
    expect(await read(reminder, 100)).toEqual({ userIds: [], nextCursor: null });
  });

  it("rejects forged direct source types and malformed direct source IDs", async () => {
    const invalid = [
      ["wallet_topup_approved", "orders", "3"],
      ["wallet_topup_rejected", "wallet_topups", "not-a-number"],
      ["order_completed", "wallet_topups", "3"],
      ["episode_wallet_purchased", "orders", "3"],
      ["daily_checkin_reminder", "orders", "daily"],
      ["daily_checkin_reminder", "checkin_campaign", "bad key"],
    ] as const;
    for (const [kind, sourceType, sourceId] of invalid) {
      const read = createQualifiedSqlAudienceReader(dbRows([
        event(kind, 2, sourceType, sourceId),
      ]));
      await expect(read({ ...claimed, kind }, 100)).rejects.toThrow("direct source identity");
    }
    const valid = createQualifiedSqlAudienceReader(dbRows(
      [event("wallet_topup_approved", 2, "wallet_topups", "3")], [user(2)],
    ));
    expect(await valid({ ...claimed, kind: "wallet_topup_approved" }, 100))
      .toEqual({ userIds: [2], nextCursor: null });
  });

  it("filters authors, owner and late opt-ins from new-novel fanout", async () => {
    const novel = { ...claimed, kind: "novel_published" as const };
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("novel_published", null, "novels", "10")],
      [{ authorUserId: 5, status: "published" }],
      [user(2, true, before), user(3, true, after), user(4, true, before, "author"),
        user(5, true, before)],
    ));
    expect(await read(novel, 4)).toEqual({ userIds: [2], nextCursor: "5" });
  });

  it("advances across raw wishlist candidates without notifying new followers", async () => {
    const digest = { ...claimed, kind: "wishlist_episodes_published" as const };
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("wishlist_episodes_published", null, "novel_publish_batches", "10_batchA_0")],
      [{ authorUserId: null, status: "published" }],
      [user(2, null, null, "user", after), user(3, null, null, "user", before)],
    ));
    expect(await read(digest, 2)).toEqual({ userIds: [3], nextCursor: "3" });
  });

  it("refuses to promote withdrawn public novels", async () => {
    const novel = { ...claimed, kind: "novel_published" as const };
    const read = createQualifiedSqlAudienceReader(dbRows(
      [event("novel_published", null, "novels", "10")],
      [{ authorUserId: null, status: "archived" }],
    ));
    expect(await read(novel, 100)).toEqual({ userIds: [], nextCursor: null });
  });

  it("rejects events predating activation and mismatched event identity", async () => {
    const read = createQualifiedSqlAudienceReader(dbRows([
      { ...event("order_completed", 2), eligibleAfter: after },
    ]));
    await expect(read(claimed, 100)).rejects.toThrow("identity mismatch");
    const wrong = createQualifiedSqlAudienceReader(dbRows([
      { ...event("order_completed", 2), eventKey: "wrong" },
    ]));
    await expect(wrong(claimed, 100)).rejects.toThrow("identity mismatch");
  });

  it("refuses malformed publication identities and unbounded audience reads", async () => {
    const novel = { ...claimed, kind: "novel_published" as const };
    const read = createQualifiedSqlAudienceReader(dbRows([
      event("novel_published", null, "novels", "bad-source"),
    ]));
    await expect(read(novel, 100)).rejects.toThrow("publication identity");
    await expect(read(novel, 101)).rejects.toThrow("bound");
  });
});
