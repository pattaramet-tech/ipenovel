import { describe, expect, it } from "vitest";
import { buildManusLoginUrl, resolveLoginUrl } from "./const";

const manus = {
  oauthPortalUrl: "https://portal.example.com",
  appId: "test-app-id",
  redirectUri: "https://ipenovel.example/api/oauth/callback",
};

describe("resolveLoginUrl", () => {
  it("VITE_AUTH_PROVIDER unset (undefined) -> the Manus OAuth URL", () => {
    const url = resolveLoginUrl(undefined, manus);
    expect(url.startsWith(`${manus.oauthPortalUrl}/app-auth?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("appId")).toBe(manus.appId);
    expect(parsed.searchParams.get("redirectUri")).toBe(manus.redirectUri);
    expect(parsed.searchParams.get("type")).toBe("signIn");
  });

  it('VITE_AUTH_PROVIDER="manus" -> the Manus OAuth URL, identical to unset', () => {
    const unset = resolveLoginUrl(undefined, manus);
    const explicit = resolveLoginUrl("manus", manus);
    expect(explicit).toBe(unset);
  });

  it('VITE_AUTH_PROVIDER="google" -> the in-app Google start path, never the Manus URL', () => {
    const url = resolveLoginUrl("google", manus);
    expect(url).toBe("/api/auth/google/start");
  });

  it("any value other than the exact literal \"google\" falls back to Manus (typo/garbage safety)", () => {
    for (const value of ["Google", "GOOGLE", " google", "google ", "manuss", ""]) {
      const url = resolveLoginUrl(value, manus);
      expect(url.startsWith(`${manus.oauthPortalUrl}/app-auth?`)).toBe(true);
    }
  });

  it('VITE_AUTH_PROVIDER="transition" -> the in-app /login page, never the Manus URL and never the bare Google start path', () => {
    const url = resolveLoginUrl("transition", manus);
    expect(url).toBe("/login");
  });

  it("any value other than the exact literals \"google\"/\"transition\" falls back to Manus - including \"manus\" itself, a typo of transition, wrong case, whitespace, and empty string", () => {
    for (const value of ["manus", "Transition", "TRANSITION", " transition", "transition ", "transitionn", "manus,transition", ""]) {
      const url = resolveLoginUrl(value, manus);
      expect(url.startsWith(`${manus.oauthPortalUrl}/app-auth?`)).toBe(true);
    }
  });

  it("the transition branch never touches or requires the Manus portal/appId/redirectUri values at all", () => {
    const url = resolveLoginUrl("transition", { oauthPortalUrl: "", appId: "", redirectUri: "" });
    expect(url).toBe("/login");
  });

  it("the Google branch never touches or requires the Manus portal/appId/redirectUri values at all", () => {
    // Pass obviously-broken Manus params - if the Google branch ever
    // accidentally fell through to building a Manus URL, this would blow
    // up or produce a garbage URL instead of the clean Google path.
    const url = resolveLoginUrl("google", { oauthPortalUrl: "", appId: "", redirectUri: "" });
    expect(url).toBe("/api/auth/google/start");
  });

  it("state is base64 of the redirect URI, matching the pre-existing Manus behavior exactly", () => {
    const url = resolveLoginUrl(undefined, manus);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe(btoa(manus.redirectUri));
  });
});

describe("buildManusLoginUrl", () => {
  it("builds the exact same URL resolveLoginUrl's manus/default branch returns - the in-app /login page's 'sign in the old way' button calls this directly", () => {
    const direct = buildManusLoginUrl(manus);
    const viaResolve = resolveLoginUrl(undefined, manus);
    expect(direct).toBe(viaResolve);
  });

  it("never generates a nonce/PKCE/anything beyond appId/redirectUri/state/type - the client never generates OAuth security parameters itself", () => {
    const url = new URL(buildManusLoginUrl(manus));
    expect([...url.searchParams.keys()].sort()).toEqual(["appId", "redirectUri", "state", "type"].sort());
    expect(url.searchParams.get("type")).toBe("signIn");
  });
});
