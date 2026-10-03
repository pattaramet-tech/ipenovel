import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computePkceS256Challenge,
  generatePluginOpaqueToken,
  hashPluginSecret,
  hashesEqual,
  verifyPkceS256,
} from "./crypto";

describe("hashPluginSecret", () => {
  it("is sha256 hex", () => {
    // Well-known sha256("abc") vector.
    expect(hashPluginSecret("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(hashPluginSecret("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("is deterministic and length-64", () => {
    expect(hashPluginSecret("x")).toBe(hashPluginSecret("x"));
    expect(hashPluginSecret("x")).toHaveLength(64);
  });
});

describe("hashesEqual", () => {
  it("matches identical digests and rejects different ones", () => {
    const a = hashPluginSecret("token-a");
    const b = hashPluginSecret("token-b");
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, b)).toBe(false);
  });

  it("fails closed on wrong shapes", () => {
    const good = hashPluginSecret("token-a");
    expect(hashesEqual("", good)).toBe(false);
    expect(hashesEqual(good, "short")).toBe(false);
    expect(hashesEqual(good, good.slice(0, 63))).toBe(false);
    expect(hashesEqual(undefined as unknown as string, good)).toBe(false);
  });
});

describe("PKCE S256", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computePkceS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifies the right verifier and rejects wrong/tampered ones", () => {
    const verifier = generatePluginOpaqueToken();
    const challenge = computePkceS256Challenge(verifier);
    expect(verifyPkceS256({ codeVerifier: verifier, codeChallenge: challenge })).toBe(true);
    expect(verifyPkceS256({ codeVerifier: generatePluginOpaqueToken(), codeChallenge: challenge })).toBe(false);
    expect(verifyPkceS256({ codeVerifier: verifier, codeChallenge: challenge.slice(0, -1) + "A" })).toBe(false);
    expect(verifyPkceS256({ codeVerifier: "", codeChallenge: challenge })).toBe(false);
    expect(verifyPkceS256({ codeVerifier: verifier, codeChallenge: "" })).toBe(false);
  });
});

describe("generatePluginOpaqueToken", () => {
  it("produces unguessable URL-safe values with high entropy", () => {
    const a = generatePluginOpaqueToken();
    const b = generatePluginOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});
