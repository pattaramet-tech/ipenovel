import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { sdk } from "./_core/sdk";

/**
 * R4/IR-02 — strict ORIGINAL claim-shape validation (tv/sid/exp) BEFORE any
 * normalization/adoption. The v2 protocol is (sid: base64url 16-64, tv: 2)
 * TOGETHER; legacy is (no sid, no tv). Malformed signed shapes — sid of the
 * wrong type/shape, sid without tv, tv without sid, tv !== 2, missing/non-
 * positive exp — must fail structurally (invalid_session_token), never be
 * normalized into the legacy path. Legitimate legacy tokens stay valid.
 *
 * These run against verifySession directly (pure JWT — no DB) and, for the
 * rejection path, through authenticateRequestWithSession.
 */

const SECRET = new TextEncoder().encode("integration-test-only-jwt-secret-0123456789abcdef");
const APP_ID = process.env.VITE_APP_ID ?? "ipenovel-integration-test-app";
const SID_OK = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 chars base64url (generateSid shape)

function mint(claims: Record<string, unknown>, opts?: { noExp?: boolean }) {
  const j = new SignJWT({ openId: "claim-shape-user", appId: APP_ID, ...claims });
  j.setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setIssuer("ipenovel-session").setAudience(APP_ID);
  if (!opts?.noExp) j.setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  return j.sign(SECRET);
}

async function verify(cookieValue: string) {
  return sdk.verifySession(cookieValue);
}

async function authRejects(cookieValue: string) {
  await expect(
    sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${cookieValue}` } } as any),
  ).rejects.toMatchObject({ reason: "invalid_session_token" });
}

beforeAll(() => {
  process.env.READER_SESSION_CONTROLS = "true";
});
afterAll(() => {
  process.env.READER_SESSION_CONTROLS = "false";
});

describe("R4/IR-02 — strict tv/sid/exp claim shapes", () => {
  it("valid v2 (sid + tv:2) verifies and keeps the sid", async () => {
    const s = await verify(await mint({ sid: SID_OK, tv: 2 }));
    expect(s?.sid).toBe(SID_OK);
    expect((s?.expSeconds ?? 0) > 0).toBe(true);
  });

  it("legitimate legacy token (no sid, no tv) still verifies with sid null", async () => {
    const s = await verify(await mint({}));
    expect(s).not.toBeNull();
    expect(s?.sid).toBeNull();
  });

  it("v2 with MISSING tv is rejected (sid without tv)", async () => {
    const t = await mint({ sid: SID_OK });
    expect(await verify(t)).toBeNull();
    await authRejects(t);
  });

  it("tv:2 WITHOUT sid is rejected", async () => {
    const t = await mint({ tv: 2 });
    expect(await verify(t)).toBeNull();
    await authRejects(t);
  });

  it("sid of the WRONG TYPE (number) is rejected — never normalized to null/legacy", async () => {
    const t = await mint({ sid: 12345, tv: 2 });
    expect(await verify(t)).toBeNull();
    await authRejects(t);
  });

  it("EMPTY sid is rejected", async () => {
    const t = await mint({ sid: "", tv: 2 });
    expect(await verify(t)).toBeNull();
    await authRejects(t);
  });

  it("sid in the WRONG SHAPE (too short / bad charset) is rejected", async () => {
    for (const bad of ["short", "has$pecial!!chars", `${SID_OK}!"`]) {
      const t = await mint({ sid: bad, tv: 2 });
      expect(await verify(t)).toBeNull();
      await authRejects(t);
    }
  });

  it("tv !== 2 (1, 3, string '2') is rejected", async () => {
    for (const badTv of [1, 3, "2", null]) {
      const t = await mint({ sid: SID_OK, tv: badTv });
      expect(await verify(t)).toBeNull();
      await authRejects(t);
    }
  });

  it("tv WITHOUT sid is rejected", async () => {
    const t = await mint({ tv: 2 }).valueOf();
    expect(await verify(t)).toBeNull();
  });

  it("MISSING exp is rejected (structural, not a default-TTL inference)", async () => {
    const t = await mint({ sid: SID_OK, tv: 2 }, { noExp: true });
    expect(await verify(t)).toBeNull();
    await authRejects(t);
  });

  it("legacy token with MISSING exp is rejected too (every minted token carries exp)", async () => {
    const t = await mint({}, { noExp: true });
    expect(await verify(t)).toBeNull();
  });
});
