import { describe, expect, it } from "vitest";
import { MANUS_LEGACY_QR_CDN_HOSTNAME, validatePaymentQrImageUrlForProduction } from "./paymentQrImageUrl";

const REQUIRED_MESSAGE = "VITE_PAYMENT_QR_IMAGE_URL is required for production builds.";
const HTTPS_ONLY_MESSAGE = "VITE_PAYMENT_QR_IMAGE_URL must be an absolute HTTPS URL.";
const MANUS_CDN_MESSAGE = `VITE_PAYMENT_QR_IMAGE_URL must not point at the legacy Manus CloudFront CDN (${MANUS_LEGACY_QR_CDN_HOSTNAME}).`;

describe("validatePaymentQrImageUrlForProduction", () => {
  it("missing (undefined) -> rejected with the exact required-value message", () => {
    const result = validatePaymentQrImageUrlForProduction(undefined);
    expect(result).toEqual({ ok: false, reason: "missing", message: REQUIRED_MESSAGE });
  });

  it("blank (empty string) -> rejected, same as missing", () => {
    const result = validatePaymentQrImageUrlForProduction("");
    expect(result).toEqual({ ok: false, reason: "missing", message: REQUIRED_MESSAGE });
  });

  it("whitespace-only -> rejected, same as missing", () => {
    const result = validatePaymentQrImageUrlForProduction("   \t  ");
    expect(result).toEqual({ ok: false, reason: "missing", message: REQUIRED_MESSAGE });
  });

  it("http:// -> rejected, must be HTTPS", () => {
    const result = validatePaymentQrImageUrlForProduction("http://assets.example.com/qr.jpg");
    expect(result).toEqual({ ok: false, reason: "not_absolute_https_url", message: HTTPS_ONLY_MESSAGE });
  });

  it("a relative path -> rejected, must be an absolute URL", () => {
    const result = validatePaymentQrImageUrlForProduction("/assets/qr.jpg");
    expect(result).toEqual({ ok: false, reason: "not_absolute_https_url", message: HTTPS_ONLY_MESSAGE });
  });

  it("not a URL at all -> rejected, must be an absolute URL", () => {
    const result = validatePaymentQrImageUrlForProduction("not a url");
    expect(result).toEqual({ ok: false, reason: "not_absolute_https_url", message: HTTPS_ONLY_MESSAGE });
  });

  it("other non-http(s) schemes (e.g. ftp://) -> rejected, must be HTTPS", () => {
    const result = validatePaymentQrImageUrlForProduction("ftp://assets.example.com/qr.jpg");
    expect(result).toEqual({ ok: false, reason: "not_absolute_https_url", message: HTTPS_ONLY_MESSAGE });
  });

  it("the legacy Manus CloudFront hostname -> rejected, even over HTTPS", () => {
    const result = validatePaymentQrImageUrlForProduction(
      `https://${MANUS_LEGACY_QR_CDN_HOSTNAME}/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_8beb9f9a.jpeg`
    );
    expect(result).toEqual({ ok: false, reason: "legacy_manus_cdn", message: MANUS_CDN_MESSAGE });
  });

  it("the legacy Manus CloudFront hostname in a different case -> still rejected", () => {
    const result = validatePaymentQrImageUrlForProduction(
      `https://${MANUS_LEGACY_QR_CDN_HOSTNAME.toUpperCase()}/foo.jpg`
    );
    expect(result).toEqual({ ok: false, reason: "legacy_manus_cdn", message: MANUS_CDN_MESSAGE });
  });

  it("a valid HTTPS owned/public URL -> accepted, trimmed value returned", () => {
    const result = validatePaymentQrImageUrlForProduction("  https://pub-example.r2.dev/payment/qr.jpg  ");
    expect(result).toEqual({ ok: true, url: "https://pub-example.r2.dev/payment/qr.jpg" });
  });

  it("never echoes the raw configured value in a rejection message", () => {
    const secretLookingUrl = "https://d2xsxph8kpxj0f.cloudfront.net/some/very/specific/leaked/path.jpg";
    const result = validatePaymentQrImageUrlForProduction(secretLookingUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("/some/very/specific/leaked/path.jpg");
    }
  });
});
