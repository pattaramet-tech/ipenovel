import { describe, expect, it } from "vitest";
import { resolveUnauthorizedRedirectPath } from "./unauthorizedRedirect";

const OAUTH_LOGIN_URL = "https://oauth.example.com/app-auth?appId=test";

describe("resolveUnauthorizedRedirectPath", () => {
  it("/admin -> /admin/login", () => {
    expect(resolveUnauthorizedRedirectPath("/admin", OAUTH_LOGIN_URL)).toBe("/admin/login");
  });

  it("any /admin/* subpath -> /admin/login", () => {
    expect(resolveUnauthorizedRedirectPath("/admin/novels", OAUTH_LOGIN_URL)).toBe("/admin/login");
    expect(resolveUnauthorizedRedirectPath("/admin/payments/123", OAUTH_LOGIN_URL)).toBe("/admin/login");
    expect(resolveUnauthorizedRedirectPath("/admin/hybrid-health", OAUTH_LOGIN_URL)).toBe("/admin/login");
  });

  it("/admin/login itself -> null (never redirect-loops back to itself)", () => {
    expect(resolveUnauthorizedRedirectPath("/admin/login", OAUTH_LOGIN_URL)).toBeNull();
  });

  it("every other route -> the OAuth login URL, unchanged", () => {
    expect(resolveUnauthorizedRedirectPath("/", OAUTH_LOGIN_URL)).toBe(OAUTH_LOGIN_URL);
    expect(resolveUnauthorizedRedirectPath("/novels/42", OAUTH_LOGIN_URL)).toBe(OAUTH_LOGIN_URL);
    expect(resolveUnauthorizedRedirectPath("/wallet", OAUTH_LOGIN_URL)).toBe(OAUTH_LOGIN_URL);
    expect(resolveUnauthorizedRedirectPath("/profile", OAUTH_LOGIN_URL)).toBe(OAUTH_LOGIN_URL);
  });

  it("does not treat a path that merely starts with 'admin' (not '/admin') as an admin route", () => {
    expect(resolveUnauthorizedRedirectPath("/administrator", OAUTH_LOGIN_URL)).toBe(OAUTH_LOGIN_URL);
  });

  it("is a pure function - same input always produces the same output, no globals touched", () => {
    const a = resolveUnauthorizedRedirectPath("/admin/orders", OAUTH_LOGIN_URL);
    const b = resolveUnauthorizedRedirectPath("/admin/orders", OAUTH_LOGIN_URL);
    expect(a).toBe(b);
  });
});
