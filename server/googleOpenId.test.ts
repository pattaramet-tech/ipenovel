import { describe, expect, it } from "vitest";
import { computeGoogleOpenId } from "./db";

// users.openId is varchar(64) (drizzle/schema.ts) and this feature does
// NOT widen it. Google's `sub` claim can be up to 255 characters, so a
// naive `google:<raw-sub>` openId would silently truncate or fail to
// insert for real accounts with a long sub. computeGoogleOpenId hashes the
// sub instead, producing a fixed-length value regardless of input length.

const SUB_255_CHARS = "9".repeat(255);

describe("computeGoogleOpenId", () => {
  it("a 255-character sub (Google's documented maximum) produces an openId no longer than 64 characters", () => {
    const openId = computeGoogleOpenId(SUB_255_CHARS);
    expect(openId.length).toBeLessThanOrEqual(64);
  });

  it("a typical short numeric sub also produces an openId no longer than 64 characters", () => {
    const openId = computeGoogleOpenId("1234567890");
    expect(openId.length).toBeLessThanOrEqual(64);
  });

  it("is deterministic - the same sub always produces the exact same openId", () => {
    const first = computeGoogleOpenId(SUB_255_CHARS);
    const second = computeGoogleOpenId(SUB_255_CHARS);
    expect(first).toBe(second);
  });

  it("different subs produce different openIds (no accidental collisions from truncation/normalization)", () => {
    const a = computeGoogleOpenId("sub-a");
    const b = computeGoogleOpenId("sub-b");
    expect(a).not.toBe(b);
  });

  it("is prefixed with 'google:' so it is distinct by construction from Manus openIds and the 'admin-<id>' synthetic form", () => {
    const openId = computeGoogleOpenId("1234567890");
    expect(openId.startsWith("google:")).toBe(true);
    expect(openId).not.toMatch(/^admin-/);
  });

  it("depends only on the sub - never derived from an email address", () => {
    // computeGoogleOpenId's signature takes only a sub - there is no email
    // parameter it could even accept. This test exists as an explicit,
    // load-bearing regression guard: if a future edit ever added an email
    // parameter that influenced the hash, two Google accounts that share
    // an email (a real, expected case this app must fail closed on
    // elsewhere - see googleIdentityService.test.ts's ambiguous_email
    // tests) would get suspiciously related openIds. Same sub, called with
    // nothing else varying, must always match.
    const openId1 = computeGoogleOpenId("1234567890");
    const openId2 = computeGoogleOpenId("1234567890");
    expect(openId1).toBe(openId2);
    expect(computeGoogleOpenId.length).toBe(1); // arity check: exactly one parameter
  });

  it("the hash portion is base64url (no '+', '/', or '=' padding characters, which are not URL/cookie-safe)", () => {
    const openId = computeGoogleOpenId(SUB_255_CHARS);
    const hashPart = openId.slice("google:".length);
    expect(hashPart).not.toMatch(/[+/=]/);
  });
});
