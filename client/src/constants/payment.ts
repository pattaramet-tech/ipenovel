/**
 * Payment Constants
 * Shared payment-related constants used across multiple pages
 */

/**
 * Pure decision: what QR_PAYMENT_IMAGE resolves to given the raw
 * VITE_PAYMENT_QR_IMAGE_URL build-time value. Extracted so it's testable
 * without stubbing Vite's `import.meta.env` (same pattern as
 * resolveLoginUrl in client/src/const.ts). Deliberately has NO hardcoded
 * fallback URL - the previous value hotlinked Manus's legacy CloudFront
 * CDN (see docs/MANUS_FORGE_RESIDUAL_AUDIT.md), which this project no
 * longer depends on. When unset, callers get an empty string; CartPage/
 * PaymentPage/WalletPage all omit the <img> `src` attribute entirely in
 * that case (never `src=""`, which some browsers treat as a request to
 * the current page URL) rather than silently falling back to a
 * third-party host.
 */
export function resolvePaymentQrImageUrl(rawEnvValue: string | undefined): string {
  return (rawEnvValue ?? "").trim();
}

// Single canonical QR payment image URL - shared by CartPage, PaymentPage,
// and WalletPage. Must point at an IpeNovel-controlled Cloudflare R2
// public object (see docs/MANUS_FORGE_RESIDUAL_AUDIT.md), never a
// third-party hotlink. Set via VITE_PAYMENT_QR_IMAGE_URL at build time.
export const QR_PAYMENT_IMAGE = resolvePaymentQrImageUrl(import.meta.env.VITE_PAYMENT_QR_IMAGE_URL);

export const PAYMENT_DETAILS = {
  bankName: "Kasikornbank (KBank)",
  accountName: "Ipe Novel Co., Ltd.",
  accountNumber: "010-753-600031501",
  billerId: "010753600031501",
  merchantCode: "KB000002283068",
  merchantTransactionCode: "KPS004KB000002283068",
};
