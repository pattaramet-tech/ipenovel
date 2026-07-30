import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { COOKIE_NAME } from "@shared/const";
import { createContext } from "./context";
import { getSessionCookieOptions } from "./cookies";
import { AnonymousCredentialError, type AnonymousCredentialReason } from "./authErrors";
import { sdk } from "./sdk";

type ClearCookieCall = { name: string; options: Record<string, unknown> };

function fakeOpts(): { opts: CreateExpressContextOptions; clearedCookies: ClearCookieCall[] } {
  const clearedCookies: ClearCookieCall[] = [];
  const req = { protocol: "https", hostname: "example.com", headers: {} };
  const res = {
    clearCookie: (name: string, options: Record<string, unknown>) => {
      clearedCookies.push({ name, options });
    },
  };
  return {
    opts: { req, res } as unknown as CreateExpressContextOptions,
    clearedCookies,
  };
}

describe("createContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves user: null when authenticateRequest reports an expected anonymous credential error", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new AnonymousCredentialError("no cookie", "no_cookie"));

    const { opts } = fakeOpts();
    const ctx = await createContext(opts);

    expect(ctx.user).toBeNull();
  });

  it("resolves the real user when authenticateRequest succeeds", async () => {
    const user = { id: 1, openId: "user-1", role: "user" } as any;
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue(user);

    const { opts } = fakeOpts();
    const ctx = await createContext(opts);

    expect(ctx.user).toBe(user);
  });

  it("does NOT resolve to anonymous for a database/infrastructure failure - it rethrows", async () => {
    const infraError = new Error("connection refused");
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(infraError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { opts } = fakeOpts();
    await expect(createContext(opts)).rejects.toBe(infraError);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does NOT resolve to anonymous for a missing-session-secret configuration error", async () => {
    const configError = new Error("[Auth] JWT_SECRET is not configured - refusing to sign or verify sessions");
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(configError);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { opts } = fakeOpts();
    await expect(createContext(opts)).rejects.toBe(configError);
  });

  it("does NOT resolve to anonymous for a missing-appId configuration error", async () => {
    const configError = new Error("[Auth] VITE_APP_ID is not configured - refusing to sign or verify sessions");
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(configError);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { opts } = fakeOpts();
    await expect(createContext(opts)).rejects.toBe(configError);
  });

  it("never logs the raw error object for an unexpected failure - only a sanitized summary string", async () => {
    const secretLookingMessage = "password=hunter2 token=abcdef1234567890";
    const infraError = new Error(secretLookingMessage);
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(infraError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { opts } = fakeOpts();
    await expect(createContext(opts)).rejects.toBe(infraError);

    const loggedArgs = errorSpy.mock.calls[0];
    // safeErrorSummary redacts credential-shaped fragments - the raw
    // "password=..."/"token=..." text must never reach the log call as-is.
    expect(JSON.stringify(loggedArgs)).not.toContain("hunter2");
  });

  describe("invalid-cookie clearing", () => {
    it("clears the cookie when a session cookie was present but structurally invalid (malformed/expired/wrong issuer/audience/appId/algorithm all collapse to this reason in authenticateRequest)", async () => {
      vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
        new AnonymousCredentialError("invalid", "invalid_session_token")
      );

      const { opts, clearedCookies } = fakeOpts();
      await createContext(opts);

      expect(clearedCookies).toHaveLength(1);
      expect(clearedCookies[0].name).toBe(COOKIE_NAME);
    });

    it("the clear options match getSessionCookieOptions(req), the same helper logout uses", async () => {
      vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
        new AnonymousCredentialError("invalid", "invalid_session_token")
      );

      const { opts, clearedCookies } = fakeOpts();
      await createContext(opts);

      const expectedOptions = getSessionCookieOptions(opts.req as any);
      expect(clearedCookies[0].options).toMatchObject({ ...expectedOptions, maxAge: -1 });
    });

    it("does NOT clear anything when no cookie was sent at all (nothing to clear, and no unnecessary Set-Cookie)", async () => {
      vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new AnonymousCredentialError("none", "no_cookie"));

      const { opts, clearedCookies } = fakeOpts();
      await createContext(opts);

      expect(clearedCookies).toHaveLength(0);
    });

    it.each(["no_user_record", "admin_session_invalid"] as AnonymousCredentialReason[])(
      "does NOT clear a validly-signed token rejected only for reason=%s (account state, not a broken token)",
      async reason => {
        vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new AnonymousCredentialError("x", reason));

        const { opts, clearedCookies } = fakeOpts();
        await createContext(opts);

        expect(clearedCookies).toHaveLength(0);
      }
    );

    it("DOES clear the cookie for reason=forced_relogin (AUTH_FORCE_RELOGIN_AFTER) - a session predating the cutoff can never become valid again, exactly like invalid_session_token", async () => {
      vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
        new AnonymousCredentialError("Session predates the forced re-login cutoff", "forced_relogin")
      );

      const { opts, clearedCookies } = fakeOpts();
      await createContext(opts);

      expect(clearedCookies).toHaveLength(1);
      expect(clearedCookies[0].name).toBe(COOKIE_NAME);
      const expectedOptions = getSessionCookieOptions(opts.req as any);
      expect(clearedCookies[0].options).toMatchObject({ ...expectedOptions, maxAge: -1 });
    });

    it("does NOT clear the cookie for an infrastructure failure", async () => {
      vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new Error("connection refused"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { opts, clearedCookies } = fakeOpts();
      await expect(createContext(opts)).rejects.toThrow("connection refused");

      expect(clearedCookies).toHaveLength(0);
    });
  });
});
