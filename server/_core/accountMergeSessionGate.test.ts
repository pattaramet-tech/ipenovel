import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { isCompletedAccountMergeSource } from "./accountMergeSessionGate";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

describe("completed Account Merge stale-session lookup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true only when a completed merge exists for this Source user", async () => {
    vi.spyOn(db, "getCompletedAccountMergeForSource").mockResolvedValue({
      id: 7,
      sourceUserId: 55,
      targetUserId: 77,
      completedAt: new Date(),
    } as any);
    await expect(
      isCompletedAccountMergeSource({ id: 55, role: "user" })
    ).resolves.toBe(true);
  });

  it("returns false when the user is not a completed merge Source", async () => {
    vi.spyOn(db, "getCompletedAccountMergeForSource").mockResolvedValue(
      undefined
    );
    await expect(
      isCompletedAccountMergeSource({ id: 55, role: "user" })
    ).resolves.toBe(false);
  });

  it("admin sessions bypass the lookup because merge safety forbids admins from being Source/Target", async () => {
    const spy = vi.spyOn(db, "getCompletedAccountMergeForSource");
    await expect(
      isCompletedAccountMergeSource({ id: 1, role: "admin" })
    ).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
