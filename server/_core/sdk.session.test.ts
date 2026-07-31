import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { SESSION_JWT_ISSUER, SESSION_TTL_SECONDS } from "@shared/const";
import { ENV } from "./env";
import { isSessionIssuedBeforeCutoff, sdk } from "./sdk";

// jose requires an HS256 key of a reasonable length - anything works for a
// test as long as sign and verify use the exact same value.
const TEST_SECRET = "test-only-session-secret-not-a-real-value-0123456789";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(ENV.cookieSecret);
}

describe("session JWT signing and verification", () => {
  const originalSecret = ENV.cookieSecret;
  const originalAppId = ENV.appId;

  beforeEach(() => {
    ENV.cookieSecret = TEST_SECRET;
    ENV.appId = "test-app-id";
  });

  afterEach(() => {
    ENV.cookieSecret = originalSecret;
    ENV.appId = originalAppId;
    vi.restoreAllMocks();
  });

  describe("valid session", () => {
    it("succeeds: a session signed by this server verifies and returns openId/appId/name", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
      const session = await sdk.verifySession(token);

      expect(session).not.toBeNull();
      expect(session?.openId).toBe("user-123");
      expect(session?.appId).toBe("test-app-id");
      expect(session?.name).toBe("Somchai");
    });

    it("embeds iat, exp, iss, aud and appId in the signed token", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
      const claims = decodeJwt(token);

      expect(claims.iat).toBeTypeOf("number");
      expect(claims.exp).toBeTypeOf("number");
      expect(claims.iss).toBe(SESSION_JWT_ISSUER);
      expect(claims.aud).toBe("test-app-id");
      expect((claims as Record<string, unknown>).appId).toBe("test-app-id");
    });
  });

  describe("missing cookie", () => {
    it("resolves to null (anonymous) without warning-logging", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(await sdk.verifySession(undefined)).toBeNull();
      expect(await sdk.verifySession(null)).toBeNull();
      expect(await sdk.verifySession("")).toBeNull();

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("malformed JWT", () => {
    it("is rejected (verifySession returns null)", async () => {
      expect(await sdk.verifySession("not-a-jwt-at-all")).toBeNull();
      expect(await sdk.verifySession("a.b.c")).toBeNull();
    });
  });

  describe("expired JWT", () => {
    it("is rejected", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai", expiresInMs: -1000 });
      expect(await sdk.verifySession(token)).toBeNull();
    });
  });

  describe("wrong appId", () => {
    it("is rejected even with a correct signature/issuer/audience shape", async () => {
      // Hand-craft a token whose `aud` matches ENV.appId (so it passes jose's
      // own audience check) but whose `appId` claim does not - only the
      // application-level exact-match check in verifySession can catch this.
      const token = await new SignJWT({ openId: "user-123", appId: "some-other-app", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("test-app-id")
        .sign(secretKey());

      expect(await sdk.verifySession(token)).toBeNull();
    });
  });

  describe("wrong issuer", () => {
    it("is rejected", async () => {
      const token = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer("some-other-issuer")
        .setAudience("test-app-id")
        .sign(secretKey());

      expect(await sdk.verifySession(token)).toBeNull();
    });
  });

  describe("wrong audience", () => {
    it("is rejected", async () => {
      const token = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("some-other-app")
        .sign(secretKey());

      expect(await sdk.verifySession(token)).toBeNull();
    });
  });

  describe("unsupported algorithm", () => {
    it("rejects an HS384-signed token even with a correct secret/claims", async () => {
      const token = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS384", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("test-app-id")
        .sign(secretKey());

      expect(await sdk.verifySession(token)).toBeNull();
    });
  });

  describe("Apple-style user with no name", () => {
    it("still signs and verifies successfully with name: null - never a fabricated placeholder name", async () => {
      const token = await sdk.createSessionToken("apple-user-1", {});
      const session = await sdk.verifySession(token);

      expect(session).not.toBeNull();
      expect(session?.openId).toBe("apple-user-1");
      expect(session?.name).toBeNull();
    });

    it("also accepts an explicit null/empty/whitespace name the same way", async () => {
      for (const raw of [null, "", "   "]) {
        const token = await sdk.createSessionToken("apple-user-2", { name: raw as any });
        const session = await sdk.verifySession(token);
        expect(session?.name).toBeNull();
      }
    });
  });

  describe("session lifetime", () => {
    it("defaults to ~30 days (SESSION_TTL_SECONDS), not ~1 year", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
      const claims = decodeJwt(token);
      const lifetimeSeconds = (claims.exp as number) - (claims.iat as number);

      expect(lifetimeSeconds).toBeGreaterThanOrEqual(SESSION_TTL_SECONDS - 5);
      expect(lifetimeSeconds).toBeLessThanOrEqual(SESSION_TTL_SECONDS + 5);

      const oneYearSeconds = 60 * 60 * 24 * 365;
      expect(lifetimeSeconds).toBeLessThan(oneYearSeconds / 2);
    });
  });

  describe("configuration error: missing session secret", () => {
    it("throws (does not resolve to anonymous / return null) when JWT_SECRET is unset", async () => {
      ENV.cookieSecret = "";
      await expect(sdk.verifySession("irrelevant-token-value")).rejects.toThrow();
    });

    it("also throws on sign, not just verify", async () => {
      ENV.cookieSecret = "";
      await expect(sdk.createSessionToken("user-123", { name: "Somchai" })).rejects.toThrow();
    });
  });

  describe("configuration error: missing VITE_APP_ID", () => {
    it("throws (does not resolve to anonymous / return null) during verification when appId is empty", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
      ENV.appId = "";
      await expect(sdk.verifySession(token)).rejects.toThrow(/VITE_APP_ID/);
    });

    it("throws (does not resolve to anonymous / return null) during verification when appId is whitespace-only", async () => {
      const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
      ENV.appId = "   ";
      await expect(sdk.verifySession(token)).rejects.toThrow(/VITE_APP_ID/);
    });

    it("also throws on sign, not just verify, and never mints a token with an empty audience", async () => {
      ENV.appId = "";
      await expect(sdk.createSessionToken("user-123", { name: "Somchai" })).rejects.toThrow(/VITE_APP_ID/);
    });

    it("throws for whitespace-only appId on sign too", async () => {
      ENV.appId = "   ";
      await expect(sdk.createSessionToken("user-123", { name: "Somchai" })).rejects.toThrow(/VITE_APP_ID/);
    });
  });

  describe("no log flooding for expected credential rejections", () => {
    it("never warn- or error-logs for malformed, expired, wrong-appId, wrong-issuer, wrong-audience, or wrong-algorithm tokens", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const expiredToken = await sdk.createSessionToken("user-123", { name: "Somchai", expiresInMs: -1000 });
      const wrongAppIdToken = await new SignJWT({ openId: "user-123", appId: "some-other-app", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("test-app-id")
        .sign(secretKey());
      const wrongIssuerToken = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer("some-other-issuer")
        .setAudience("test-app-id")
        .sign(secretKey());
      const wrongAudienceToken = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("some-other-app")
        .sign(secretKey());
      const wrongAlgToken = await new SignJWT({ openId: "user-123", appId: "test-app-id", name: "Somchai" })
        .setProtectedHeader({ alg: "HS384", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience("test-app-id")
        .sign(secretKey());

      await sdk.verifySession("not-a-jwt-at-all");
      await sdk.verifySession(expiredToken);
      await sdk.verifySession(wrongAppIdToken);
      await sdk.verifySession(wrongIssuerToken);
      await sdk.verifySession(wrongAudienceToken);
      await sdk.verifySession(wrongAlgToken);

      // Every currently-logged-in browser sends its now-invalid pre-change
      // cookie on every request until it signs in again - these rejections
      // are expected and high-volume, not a security event worth a log
      // line each time (see server/_core/sdk.ts's verifySession).
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});

describe("isSessionIssuedBeforeCutoff - pure, plain-number tests (no JWT/fake timers needed)", () => {
  it("cutoff is null -> always false, regardless of iat/now", () => {
    expect(isSessionIssuedBeforeCutoff(100, null, 200)).toBe(false);
    expect(isSessionIssuedBeforeCutoff(100, null, 50)).toBe(false);
  });

  it("cutoff is in the future relative to now (now < cutoff) -> false, EVEN IF iat is before the cutoff - a future cutoff is a scheduled activation, not immediate", () => {
    expect(isSessionIssuedBeforeCutoff(/* iat */ 100, /* cutoff */ 1000, /* now */ 500)).toBe(false);
  });

  it("now has reached the cutoff (now >= cutoff) and iat < cutoff -> true", () => {
    expect(isSessionIssuedBeforeCutoff(/* iat */ 100, /* cutoff */ 1000, /* now */ 1000)).toBe(true);
    expect(isSessionIssuedBeforeCutoff(/* iat */ 100, /* cutoff */ 1000, /* now */ 5000)).toBe(true);
  });

  it("iat === cutoff exactly -> false (the boundary is inclusive on the safe/valid side)", () => {
    expect(isSessionIssuedBeforeCutoff(/* iat */ 1000, /* cutoff */ 1000, /* now */ 1000)).toBe(false);
  });

  it("iat > cutoff (issued after the cutoff) -> false, regardless of now", () => {
    expect(isSessionIssuedBeforeCutoff(/* iat */ 2000, /* cutoff */ 1000, /* now */ 5000)).toBe(false);
  });

  it("now === cutoff exactly -> the cutoff counts as active (matches the authenticateRequest boundary test using a real cutoff-instant session)", () => {
    expect(isSessionIssuedBeforeCutoff(/* iat */ 100, /* cutoff */ 1000, /* now */ 1000)).toBe(true);
  });

  it("defaults `now` to the real server clock (Date.now()) when omitted - never undefined/NaN behavior", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    // A cutoff far in the past relative to the real current time, with an
    // iat also far in the past but before the cutoff - proves the default
    // parameter actually evaluates to a real, current epoch-seconds value.
    expect(isSessionIssuedBeforeCutoff(nowSeconds - 10_000, nowSeconds - 5_000)).toBe(true);
    expect(isSessionIssuedBeforeCutoff(nowSeconds - 1_000, nowSeconds + 10_000)).toBe(false);
  });
});
