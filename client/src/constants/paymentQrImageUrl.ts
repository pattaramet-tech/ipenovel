/**
 * Legacy Manus-hosted CDN previously hotlinked for the payment QR image
 * (see PR #39, the Manus/Forge residual dependency audit, and PR #40).
 * Rejecting it here - both at production-build time (vite.config.ts) and
 * in this module's own tests - prevents ever silently reintroducing the
 * exact dependency PR #40 removed.
 */
export const MANUS_LEGACY_QR_CDN_HOSTNAME = "d2xsxph8kpxj0f.cloudfront.net";

export type PaymentQrImageUrlValidationResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "missing" | "not_absolute_https_url" | "legacy_manus_cdn";
      message: string;
    };

/**
 * Validates a payment QR image URL for a production build. Pure - no
 * `import.meta.env`, no Node `process` - so the exact same logic runs from
 * both vite.config.ts (Node context, the actual production-build gate) and
 * client/src/constants/payment.ts (browser context, informational/testing
 * only - see that file for why it does NOT throw at runtime). Every
 * message is fixed, non-secret text; the raw configured value is never
 * echoed back, even in the "not a valid URL" or "points at Manus" cases.
 */
export function validatePaymentQrImageUrlForProduction(
  rawValue: string | undefined
): PaymentQrImageUrlValidationResult {
  const value = (rawValue ?? "").trim();

  if (!value) {
    return {
      ok: false,
      reason: "missing",
      message: "VITE_PAYMENT_QR_IMAGE_URL is required for production builds.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      reason: "not_absolute_https_url",
      message: "VITE_PAYMENT_QR_IMAGE_URL must be an absolute HTTPS URL.",
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "not_absolute_https_url",
      message: "VITE_PAYMENT_QR_IMAGE_URL must be an absolute HTTPS URL.",
    };
  }

  if (parsed.hostname.toLowerCase() === MANUS_LEGACY_QR_CDN_HOSTNAME) {
    return {
      ok: false,
      reason: "legacy_manus_cdn",
      message: `VITE_PAYMENT_QR_IMAGE_URL must not point at the legacy Manus CloudFront CDN (${MANUS_LEGACY_QR_CDN_HOSTNAME}).`,
    };
  }

  return { ok: true, url: value };
}
