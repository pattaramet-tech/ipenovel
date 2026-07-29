import { describe, expect, it } from "vitest";
import { resolveUnauthorizedRedirectTarget } from "./unauthorizedRedirect";

describe("resolveUnauthorizedRedirectTarget", () => {
  it("/admin -> 'admin_login'", () => {
    expect(resolveUnauthorizedRedirectTarget("/admin")).toBe("admin_login");
  });

  it("any /admin/* subpath -> 'admin_login'", () => {
    expect(resolveUnauthorizedRedirectTarget("/admin/novels")).toBe("admin_login");
    expect(resolveUnauthorizedRedirectTarget("/admin/payments/123")).toBe("admin_login");
    expect(resolveUnauthorizedRedirectTarget("/admin/hybrid-health")).toBe("admin_login");
  });

  it("/admin/login itself -> 'none' (never redirect-loops back to itself)", () => {
    expect(resolveUnauthorizedRedirectTarget("/admin/login")).toBe("none");
  });

  it("every other route -> 'oauth'", () => {
    expect(resolveUnauthorizedRedirectTarget("/")).toBe("oauth");
    expect(resolveUnauthorizedRedirectTarget("/novels/42")).toBe("oauth");
    expect(resolveUnauthorizedRedirectTarget("/wallet")).toBe("oauth");
    expect(resolveUnauthorizedRedirectTarget("/profile")).toBe("oauth");
  });

  it("does not treat a path that merely starts with 'admin' (not '/admin') as an admin route", () => {
    expect(resolveUnauthorizedRedirectTarget("/administrator")).toBe("oauth");
  });

  it("is a pure function - same input always produces the same output, no globals touched, no URL ever built", () => {
    const a = resolveUnauthorizedRedirectTarget("/admin/orders");
    const b = resolveUnauthorizedRedirectTarget("/admin/orders");
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    // Never a URL - a bare target label. Callers decide what to build.
    expect(a).not.toMatch(/^https?:\/\//);
    expect(a).not.toMatch(/^\//);
  });
});
