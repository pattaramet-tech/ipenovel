import { describe, expect, it } from "vitest";
import {
  isRootRenderable,
  projectVisibleThread,
  MAX_THREAD_PAGE_SIZE,
  type CommentRecord,
} from "./commentVisibility";

const rec = (overrides: Partial<CommentRecord> & Pick<CommentRecord, "id">): CommentRecord => ({
  parentCommentId: null,
  authorUserId: 7,
  message: "msg",
  status: "visible",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("isRootRenderable", () => {
  it("visible roots render; hidden/deleted render only with a surviving visible reply; pending never", () => {
    expect(isRootRenderable(rec({ id: 1, status: "visible" }), false)).toBe(true);
    expect(isRootRenderable(rec({ id: 2, status: "hidden" }), true)).toBe(true);
    expect(isRootRenderable(rec({ id: 3, status: "deleted" }), true)).toBe(true);
    expect(isRootRenderable(rec({ id: 4, status: "hidden" }), false)).toBe(false);
    expect(isRootRenderable(rec({ id: 5, status: "deleted" }), false)).toBe(false);
    expect(isRootRenderable(rec({ id: 6, status: "pending" }), true)).toBe(false);
  });
  it("replies are not roots", () => {
    expect(isRootRenderable(rec({ id: 7, parentCommentId: 1 }), true)).toBe(false);
  });
});

describe("projectVisibleThread", () => {
  const page = (records: CommentRecord[], cursor?: number | null, limit = 10) =>
    projectVisibleThread(records, { cursor: cursor ?? null, limit });

  it("renders visible roots and their visible replies in deterministic order", () => {
    const records = [
      rec({ id: 2 }),
      rec({ id: 1 }),
      rec({ id: 21, parentCommentId: 2, message: "r2b" }),
      rec({ id: 20, parentCommentId: 2, message: "r2a" }),
      rec({ id: 10, parentCommentId: 1, message: "r1" }),
    ];
    const result = page(records);
    expect(result.roots.map((r) => r.id)).toEqual([2, 1]); // id DESC
    expect(result.repliesByRootId[2].map((r) => r.id)).toEqual([20, 21]); // id ASC
    expect(result.repliesByRootId[1].map((r) => r.id)).toEqual([10]);
    expect(result.nextCursor).toBeNull();
  });

  it("hidden/deleted parents render as MINIMAL placeholders only while a VISIBLE reply survives", () => {
    const records = [
      rec({ id: 5, status: "hidden", authorUserId: 99, message: "secret", createdAt: "2099-01-01T00:00:00.000Z" }),
      rec({ id: 6, status: "deleted", message: "gone" }),
      rec({ id: 51, parentCommentId: 5, message: "still here" }),
      rec({ id: 61, parentCommentId: 6, status: "deleted", message: "gone reply" }),
      rec({ id: 7, status: "hidden" }), // no surviving reply -> must NOT appear
    ];
    const result = page(records);
    // root 6's only reply is deleted -> root 6 does not render at all;
    // root 5 keeps its placeholder because reply 51 is still visible
    expect(result.roots.map((r) => r.id)).toEqual([5]);

    const hidden = result.roots.find((r) => r.id === 5)!;
    expect(hidden.placeholder).toBe(true);
    expect(hidden.status).toBe("hidden");
    // V2 privacy contract: placeholder JSON carries NO content fields at all.
    expect(Object.keys(hidden).sort()).toEqual(["id", "parentCommentId", "placeholder", "status"]);
    expect(JSON.stringify(hidden)).not.toContain("secret");
    expect(JSON.stringify(hidden)).not.toContain("99");
    expect(JSON.stringify(hidden)).not.toContain("2099");
    expect(JSON.stringify(result)).not.toContain("gone");

    expect(result.repliesByRootId[5].map((r) => r.id)).toEqual([51]);
  });

  it("negative: hidden/deleted comments and pending rows never appear as visible views anywhere", () => {
    const records = [
      rec({ id: 1, status: "hidden", message: "h" }),
      rec({ id: 2, status: "deleted", message: "d" }),
      rec({ id: 3, status: "pending", message: "p" }),
      rec({ id: 4 }),
      rec({ id: 41, parentCommentId: 4, status: "hidden", message: "hr" }),
    ];
    const result = page(records);
    const all = [...result.roots, ...Object.values(result.repliesByRootId).flat()];
    expect(all.map((c) => c.id)).toEqual([4]);
    expect(JSON.stringify(result)).not.toContain('"h"');
    expect(JSON.stringify(result)).not.toContain("hr");
  });

  it("pagination is deterministic and cursor-exclusive (id DESC, id < cursor)", () => {
    const records = [1, 2, 3, 4, 5].map((id) => rec({ id }));
    const first = page(records, null, 2);
    expect(first.roots.map((r) => r.id)).toEqual([5, 4]);
    expect(first.nextCursor).toBe(4);
    const second = page(records, first.nextCursor, 2);
    expect(second.roots.map((r) => r.id)).toEqual([3, 2]);
    expect(second.nextCursor).toBe(2);
    const third = page(records, second.nextCursor, 2);
    expect(third.roots.map((r) => r.id)).toEqual([1]);
    expect(third.nextCursor).toBeNull(); // short page = exhausted
  });

  it("a deleted root mid-thread stays anchored while any page still renders its visible reply", () => {
    const records = [
      rec({ id: 1, status: "visible" }),
      rec({ id: 2, status: "deleted" }),
      rec({ id: 21, parentCommentId: 2, message: "reply lives on" }),
      rec({ id: 11, parentCommentId: 1 }),
    ];
    const result = page(records, null, 1);
    expect(result.roots.map((r) => r.id)).toEqual([2]); // newest renderable root
    expect(result.roots[0].placeholder).toBe(true);
    expect(result.repliesByRootId[2].map((r) => r.message)).toEqual(["reply lives on"]);
  });

  it("replies whose parent is off-page are out of scope for that page", () => {
    const records = [
      rec({ id: 1 }),
      rec({ id: 2 }),
      rec({ id: 11, parentCommentId: 1 }),
      rec({ id: 21, parentCommentId: 2 }),
    ];
    const result = page(records, null, 1);
    expect(result.roots.map((r) => r.id)).toEqual([2]);
    expect(result.repliesByRootId[2].map((r) => r.id)).toEqual([21]);
    expect(result.repliesByRootId[1]).toBeUndefined();
  });

  it("rejects non-positive limits", () => {
    expect(() => page([rec({ id: 1 })], null, 0)).toThrow();
    expect(() => page([rec({ id: 1 })], null, -1)).toThrow();
  });

  it("REGRESSION (R1): limit must be a positive safe integer within MAX_THREAD_PAGE_SIZE", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 1, "10" as unknown as number]) {
      expect(() => page([rec({ id: 1 })], null, bad)).toThrow(/limit/);
    }
    expect(() => page([rec({ id: 1 })], null, MAX_THREAD_PAGE_SIZE)).not.toThrow();
    expect(() => page([rec({ id: 1 })], null, MAX_THREAD_PAGE_SIZE + 1)).toThrow(/MAX_THREAD_PAGE_SIZE/);
    // the cap is explicit and bounded
    expect(MAX_THREAD_PAGE_SIZE).toBe(50);
  });

  it("REGRESSION (R1): cursor must be a positive safe integer or null/undefined", () => {
    for (const bad of [0, -5, 2.5, NaN, Infinity, 2 ** 53 + 2, "7" as unknown as number]) {
      expect(() => page([rec({ id: 1 })], bad)).toThrow(/cursor/);
    }
    expect(() => page([rec({ id: 1 })], null)).not.toThrow();
    expect(() => page([rec({ id: 1 })], undefined)).not.toThrow();
    expect(() => page([rec({ id: 1 })], 1)).not.toThrow();
  });
});
