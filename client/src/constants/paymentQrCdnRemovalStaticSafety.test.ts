import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Literal source-text assertions proving the payment QR image no longer
 * hotlinks Manus's legacy CloudFront CDN and that CartPage/PaymentPage/
 * WalletPage all share the same canonical QR_PAYMENT_IMAGE constant
 * instead of each hardcoding their own copy of the URL (see
 * server/services/manusRemovalStaticAssertions.test.ts for the equivalent
 * server-side pattern this mirrors).
 */
const MANUS_QR_CDN_HOSTNAME = "d2xsxph8kpxj0f.cloudfront.net";

const PAGES_DIR = join(__dirname, "..", "pages");
const PAYMENT_PAGES = ["CartPage.tsx", "PaymentPage.tsx", "WalletPage.tsx"];

function readPageSource(fileName: string): string {
  return readFileSync(join(PAGES_DIR, fileName), "utf8");
}

describe("Payment QR image - Manus CDN removal static assertions", () => {
  it("constants/payment.ts no longer hardcodes the legacy Manus CloudFront QR URL", () => {
    const source = readFileSync(join(__dirname, "payment.ts"), "utf8");
    expect(source).not.toContain(MANUS_QR_CDN_HOSTNAME);
  });

  it.each(PAYMENT_PAGES)("%s no longer references the legacy Manus CloudFront QR URL", (fileName) => {
    const source = readPageSource(fileName);
    expect(source).not.toContain(MANUS_QR_CDN_HOSTNAME);
  });

  it.each(PAYMENT_PAGES)("%s contains no cloudfront.net reference at all", (fileName) => {
    const source = readPageSource(fileName);
    expect(source).not.toMatch(/cloudfront\.net/i);
  });

  it("PaymentPage.tsx and WalletPage.tsx no longer declare their own local QR_PAYMENT_IMAGE constant", () => {
    for (const fileName of ["PaymentPage.tsx", "WalletPage.tsx"]) {
      const source = readPageSource(fileName);
      expect(source).not.toMatch(/const\s+QR_PAYMENT_IMAGE\s*=/);
    }
  });

  it.each(PAYMENT_PAGES)("%s imports the canonical QR_PAYMENT_IMAGE from constants/payment", (fileName) => {
    const source = readPageSource(fileName);
    expect(source).toMatch(/import\s*\{[^}]*\bQR_PAYMENT_IMAGE\b[^}]*\}\s*from\s+["']@\/constants\/payment["']/);
  });

  it.each(PAYMENT_PAGES)("%s never renders the QR image with an empty-string src (avoids the src=\"\" reload footgun)", (fileName) => {
    const source = readPageSource(fileName);
    expect(source).not.toMatch(/src=\{QR_PAYMENT_IMAGE\}/);
  });

  it("bank account / merchant details in PAYMENT_DETAILS are unchanged by this migration", () => {
    const source = readFileSync(join(__dirname, "payment.ts"), "utf8");
    expect(source).toContain('bankName: "Kasikornbank (KBank)"');
    expect(source).toContain('accountName: "Ipe Novel Co., Ltd."');
    expect(source).toContain('accountNumber: "010-753-600031501"');
    expect(source).toContain('billerId: "010753600031501"');
    expect(source).toContain('merchantCode: "KB000002283068"');
    expect(source).toContain('merchantTransactionCode: "KPS004KB000002283068"');
  });

  it("vite.config.ts wires up the fail-closed production-build gate for the payment QR URL", () => {
    // Static wiring proof - the real end-to-end behavior (a real `vite
    // build` actually failing) is proven by
    // paymentQrImageUrlViteBuildGate.subprocess.test.ts; this just guards
    // against a future refactor silently dropping the import/call and
    // leaving the gate unreachable code.
    const source = readFileSync(join(__dirname, "..", "..", "..", "vite.config.ts"), "utf8");
    expect(source).toMatch(/validatePaymentQrImageUrlForProduction/);
    expect(source).toMatch(/process\.argv\.includes\(\s*["']build["']\s*\)/);
  });
});
