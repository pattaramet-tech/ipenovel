import { describe, expect, it } from "vitest";
import {
  MANUS_LEGACY_QR_CDN_HOSTNAME,
  validatePaymentQrImageUrlForProduction,
} from "./paymentQrImageUrl";

describe("configured payment QR image environment", () => {
  it("uses a valid, reachable HTTPS image endpoint without exposing its configured value", async () => {
    const validation = validatePaymentQrImageUrlForProduction(process.env.VITE_PAYMENT_QR_IMAGE_URL);

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const parsed = new URL(validation.url);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname.toLowerCase()).not.toBe(MANUS_LEGACY_QR_CDN_HOSTNAME);

    let response: Response;
    try {
      response = await fetch(validation.url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Payment QR image endpoint could not be reached.");
    }

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type") ?? "").toMatch(/^image\//i);
  }, 15_000);
});
