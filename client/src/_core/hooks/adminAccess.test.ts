import { describe, expect, it, vi } from "vitest";
import { resolveAdminAccessState } from "./adminAccess";

describe("resolveAdminAccessState", () => {
  it("loading=true -> 'loading', regardless of user", () => {
    expect(resolveAdminAccessState({ loading: true, user: null })).toBe("loading");
    expect(resolveAdminAccessState({ loading: true, user: { role: "admin" } })).toBe("loading");
    expect(resolveAdminAccessState({ loading: true, user: { role: "user" } })).toBe("loading");
  });

  it("loading=false, user=null -> 'unauthenticated'", () => {
    expect(resolveAdminAccessState({ loading: false, user: null })).toBe("unauthenticated");
  });

  it("loading=false, user=undefined -> 'unauthenticated'", () => {
    expect(resolveAdminAccessState({ loading: false, user: undefined })).toBe("unauthenticated");
  });

  it("a user exists but role !== 'admin' -> 'forbidden'", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: "user" } })).toBe("forbidden");
  });

  it("role is null -> 'forbidden' (not 'allowed')", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: null } })).toBe("forbidden");
  });

  it("role is undefined -> 'forbidden' (not 'allowed')", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: undefined } })).toBe("forbidden");
    expect(resolveAdminAccessState({ loading: false, user: {} })).toBe("forbidden");
  });

  it("role === 'admin' -> 'allowed'", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: "admin" } })).toBe("allowed");
  });

  it("is a pure function: localStorage/window/document are never touched, and the result depends only on its arguments", () => {
    const getItemSpy = vi.fn();
    const originalLocalStorage = globalThis.localStorage;
    // @ts-expect-error - stubbing a browser global for this assertion only.
    globalThis.localStorage = { getItem: getItemSpy, setItem: vi.fn(), removeItem: vi.fn() };

    try {
      const first = resolveAdminAccessState({ loading: false, user: { role: "admin" } });
      const second = resolveAdminAccessState({ loading: false, user: { role: "admin" } });

      expect(first).toBe("allowed");
      expect(second).toBe("allowed");
      expect(getItemSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.localStorage = originalLocalStorage;
    }
  });
});
