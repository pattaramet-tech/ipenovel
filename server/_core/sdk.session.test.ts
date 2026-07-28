import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { SESSION_JWT_ISSUER, SESSION_TTL_SECONDS } from "@shared/const";
import { ENV } from "./env";
import { sdk } from "./sdk";

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
});
