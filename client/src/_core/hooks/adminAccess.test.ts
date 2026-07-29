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

  it("authMeError (truthy) -> 'error', even for an admin user or no user at all", () => {
    const error = new Error("database unavailable");
    expect(resolveAdminAccessState({ loading: false, user: null, authMeError: error })).toBe("error");
    expect(resolveAdminAccessState({ loading: false, user: { role: "admin" }, authMeError: error })).toBe("error");
    expect(resolveAdminAccessState({ loading: false, user: { role: "user" }, authMeError: error })).toBe("error");
  });

  it("authMeError does not override 'loading' - loading takes priority", () => {
    expect(resolveAdminAccessState({ loading: true, user: null, authMeError: new Error("x") })).toBe("loading");
  });

  it("a falsy authMeError (undefined/null) never triggers 'error'", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: "admin" }, authMeError: undefined })).toBe("allowed");
    expect(resolveAdminAccessState({ loading: false, user: { role: "admin" }, authMeError: null })).toBe("allowed");
    expect(resolveAdminAccessState({ loading: false, user: null, authMeError: undefined })).toBe("unauthenticated");
  });

  it("omitting authMeError entirely behaves the same as not having one (backward compatible)", () => {
    expect(resolveAdminAccessState({ loading: false, user: { role: "admin" } })).toBe("allowed");
    expect(resolveAdminAccessState({ loading: false, user: null })).toBe("unauthenticated");
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
