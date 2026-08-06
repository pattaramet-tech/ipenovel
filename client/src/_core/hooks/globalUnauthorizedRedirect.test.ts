import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG, NOT_ADMIN_ERR_MSG } from "@shared/const";
import { describe, expect, it, vi } from "vitest";
import {
  redirectToLoginIfUnauthorized,
  resolveGlobalUnauthorizedRedirect,
} from "./globalUnauthorizedRedirect";

function unauthorizedError(): TRPCClientError<any> {
  return new TRPCClientError(UNAUTHED_ERR_MSG);
}

function forbiddenError(): TRPCClientError<any> {
  return new TRPCClientError(NOT_ADMIN_ERR_MSG);
}

const OAUTH_LOGIN_URL = "https://oauth.example.com/login";

describe("resolveGlobalUnauthorizedRedirect", () => {
  it("Admin path UNAUTHORIZED -> 'admin_login'", () => {
    expect(resolveGlobalUnauthorizedRedirect(unauthorizedError(), "/admin/novels")).toBe(
      "admin_login"
    );
    expect(resolveGlobalUnauthorizedRedirect(unauthorizedError(), "/admin")).toBe("admin_login");
  });

  it("/login UNAUTHORIZED -> 'none' (no redirect loop)", () => {
    expect(resolveGlobalUnauthorizedRedirect(unauthorizedError(), "/login")).toBe("none");
  });

  it("Public path UNAUTHORIZED -> 'oauth'", () => {
    expect(resolveGlobalUnauthorizedRedirect(unauthorizedError(), "/wallet")).toBe("oauth");
    expect(resolveGlobalUnauthorizedRedirect(unauthorizedError(), "/")).toBe("oauth");
  });

  it("FORBIDDEN (wrong message) -> 'none', on any path, admin or not", () => {
    expect(resolveGlobalUnauthorizedRedirect(forbiddenError(), "/admin/novels")).toBe("none");
    expect(resolveGlobalUnauthorizedRedirect(forbiddenError(), "/wallet")).toBe("none");
  });

  it("network/5xx error (not a TRPCClientError, or a TRPCClientError with an unrelated message) -> 'none'", () => {
    expect(resolveGlobalUnauthorizedRedirect(new Error("Network Error"), "/admin/novels")).toBe(
      "none"
    );
    expect(resolveGlobalUnauthorizedRedirect(new TypeError("fetch failed"), "/wallet")).toBe(
      "none"
    );
    expect(
      resolveGlobalUnauthorizedRedirect(new TRPCClientError("Internal server error"), "/admin")
    ).toBe("none");
  });

  it("null/undefined error -> 'none'", () => {
    expect(resolveGlobalUnauthorizedRedirect(null, "/admin/novels")).toBe("none");
    expect(resolveGlobalUnauthorizedRedirect(undefined, "/wallet")).toBe("none");
  });
});

describe("redirectToLoginIfUnauthorized", () => {
  it("Admin UNAUTHORIZED -> applies '/login' and never calls the OAuth URL factory", () => {
    const applyRedirect = vi.fn();
    const getOauthLoginUrl = vi.fn(() => OAUTH_LOGIN_URL);

    redirectToLoginIfUnauthorized(unauthorizedError(), "/admin/orders", applyRedirect, getOauthLoginUrl);

    expect(applyRedirect).toHaveBeenCalledTimes(1);
    expect(applyRedirect).toHaveBeenCalledWith("/login");
    expect(getOauthLoginUrl).not.toHaveBeenCalled();
  });

  it("/login UNAUTHORIZED -> no redirect loop, no side effects at all", () => {
    const applyRedirect = vi.fn();
    const getOauthLoginUrl = vi.fn(() => OAUTH_LOGIN_URL);

    redirectToLoginIfUnauthorized(unauthorizedError(), "/login", applyRedirect, getOauthLoginUrl);

    expect(applyRedirect).not.toHaveBeenCalled();
    expect(getOauthLoginUrl).not.toHaveBeenCalled();
  });

  it("Public UNAUTHORIZED -> applies the OAuth login URL built by the injected factory", () => {
    const applyRedirect = vi.fn();
    const getOauthLoginUrl = vi.fn(() => OAUTH_LOGIN_URL);

    redirectToLoginIfUnauthorized(unauthorizedError(), "/wallet", applyRedirect, getOauthLoginUrl);

    expect(getOauthLoginUrl).toHaveBeenCalledTimes(1);
    expect(applyRedirect).toHaveBeenCalledTimes(1);
    expect(applyRedirect).toHaveBeenCalledWith(OAUTH_LOGIN_URL);
  });

  it("FORBIDDEN -> no redirect, no factory call, regardless of path", () => {
    const applyRedirect = vi.fn();
    const getOauthLoginUrl = vi.fn(() => OAUTH_LOGIN_URL);

    redirectToLoginIfUnauthorized(forbiddenError(), "/admin/orders", applyRedirect, getOauthLoginUrl);
    redirectToLoginIfUnauthorized(forbiddenError(), "/wallet", applyRedirect, getOauthLoginUrl);

    expect(applyRedirect).not.toHaveBeenCalled();
    expect(getOauthLoginUrl).not.toHaveBeenCalled();
  });

  it("network/5xx error -> no redirect, no factory call", () => {
    const applyRedirect = vi.fn();
    const getOauthLoginUrl = vi.fn(() => OAUTH_LOGIN_URL);

    redirectToLoginIfUnauthorized(new Error("Network Error"), "/admin/orders", applyRedirect, getOauthLoginUrl);
    redirectToLoginIfUnauthorized(new Error("Network Error"), "/wallet", applyRedirect, getOauthLoginUrl);

    expect(applyRedirect).not.toHaveBeenCalled();
    expect(getOauthLoginUrl).not.toHaveBeenCalled();
  });
});
