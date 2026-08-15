import { describe, expect, it } from "vitest";
import { resolvePaymentQrImageUrl } from "./payment";

describe("resolvePaymentQrImageUrl", () => {
  it("trims and returns a configured URL", () => {
    expect(resolvePaymentQrImageUrl("  https://assets.example.com/qr.jpg  ")).toBe(
      "https://assets.example.com/qr.jpg"
    );
  });

  it("returns an empty string when unset (undefined) - never falls back to a hardcoded URL", () => {
    expect(resolvePaymentQrImageUrl(undefined)).toBe("");
  });

  it("returns an empty string for an empty/whitespace-only value", () => {
    expect(resolvePaymentQrImageUrl("")).toBe("");
    expect(resolvePaymentQrImageUrl("   ")).toBe("");
  });

  it("never falls back to a third-party CDN, no matter the input", () => {
    // Guards against a future edit accidentally reintroducing a hardcoded
    // fallback (Manus's CloudFront CDN or otherwise) when the env var is
    // unset - the unset case must stay a plain empty string.
    expect(resolvePaymentQrImageUrl(undefined)).not.toMatch(/cloudfront\.net/i);
    expect(resolvePaymentQrImageUrl(undefined)).not.toMatch(/manus/i);
  });
});
