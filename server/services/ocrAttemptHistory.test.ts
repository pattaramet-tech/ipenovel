import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Automatic OCR attempt history (Codex P2).
 *
 * The promise was one row per automatic submission AND per admin recheck, but
 * recordOcrAttempt was only ever called from the recheck service - so history
 * began at attempt #2 and never showed the provider failure that caused the
 * review in the first place.
 *
 * These are structural assertions because the guarantee is that a call EXISTS
 * on each automatic path; a behavioral test would need a live database, which
 * this sandbox deliberately does not have.
 */

function readCode(relativePath: string): string {
  const abs = path.resolve(process.cwd(), relativePath);
  return fs
    .readFileSync(abs, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("automatic order OCR records an attempt", () => {
  const code = readCode("server/services/slipSubmissionService.ts");

  it("calls recordOcrAttempt", () => {
    expect(code).toMatch(/recordOcrAttempt\s*\(/);
  });

  it("records it as an automatic trigger, not admin_recheck", () => {
    expect(code).toMatch(/trigger:\s*["']automatic["']/);
    expect(code).not.toMatch(/trigger:\s*["']admin_recheck["']/);
  });

  it("records the subject as order_payment", () => {
    expect(code).toMatch(/subjectType:\s*["']order_payment["']/);
  });

  it("distinguishes technical failure from a data review and an approval", () => {
    expect(code).toMatch(/"technical_failure"/);
    expect(code).toMatch(/"needs_review"/);
    expect(code).toMatch(/"auto_approved"/);
    expect(code).toMatch(/"config_blocked"/);
  });

  it("carries provider HTTP status and attempt count when technical", () => {
    expect(code).toMatch(/providerHttpStatus:/);
    expect(code).toMatch(/providerAttemptCount:/);
  });

  it("records an unknown confidence as null, never as 0", () => {
    expect(code).toMatch(/confidenceKnown === false\s*\n?\s*\?\s*null/);
  });
});

describe("automatic wallet OCR records an attempt", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("calls the attempt recorder", () => {
    expect(code).toMatch(/recordOcrAttempt\s*\(/);
    expect(code).toMatch(/recordWalletAttempt\s*\(/);
  });

  it("records subjectType wallet_topup with an automatic trigger", () => {
    expect(code).toMatch(/subjectType:\s*["']wallet_topup["']/);
    expect(code).toMatch(/trigger:\s*["']automatic["']/);
  });

  it("records the technical-failure path", () => {
    expect(code).toMatch(/recordWalletAttempt\(\s*\n?\s*"technical_failure"/);
  });

  it("records the auto-approved path", () => {
    expect(code).toMatch(/recordWalletAttempt\("auto_approved"/);
  });

  it("records config-blocked when OCR is disabled entirely", () => {
    expect(code).toMatch(/recordWalletAttempt\("config_blocked",\s*"OCR_DISABLED"/);
  });

  it("records each data-review reason rather than one generic entry", () => {
    for (const reason of ["LOW_CONFIDENCE", "AMOUNT_MISMATCH", "MISSING_FIELDS"]) {
      expect(code).toMatch(new RegExp(`recordWalletAttempt\\("needs_review", "${reason}"`));
    }
  });
});

describe("attempt logging can never break money correctness", () => {
  const attemptCode = readCode("server/services/ocrAttemptService.ts");

  it("recordOcrAttempt swallows its own errors", () => {
    expect(attemptCode).toMatch(/catch\s*\(error\)/);
    expect(attemptCode).toMatch(/return 0;/);
  });

  it("history reads never throw either", () => {
    expect(attemptCode).toMatch(/catch\s*\{\s*\n?\s*return \[\];/);
  });
});

describe("the admin panel renders the attempt history", () => {
  const panel = readCode("client/src/components/OCRResultPanel.tsx");

  it("queries admin.orders.ocrAttempts", () => {
    expect(panel).toMatch(/ocrAttempts/);
  });

  it("shows attempt number, trigger, result and timestamp", () => {
    expect(panel).toMatch(/attemptNo/);
    expect(panel).toMatch(/a\.trigger/);
    expect(panel).toMatch(/a\.result/);
    expect(panel).toMatch(/startedAt/);
  });

  it("shows provider HTTP status and attempts only for technical failures", () => {
    expect(panel).toMatch(/reviewCategory === "TECHNICAL"/);
    expect(panel).toMatch(/providerHttpStatus/);
    expect(panel).toMatch(/providerAttemptCount/);
  });

  it("never renders raw OCR text in the history", () => {
    const historyBlock = panel.slice(panel.indexOf("OCR Attempt History"));
    expect(historyBlock).not.toMatch(/rawText/);
  });
});

describe("the router exposes the history admin-only", () => {
  const routers = readCode("server/routers.ts");

  it("ocrAttempts is an adminProcedure", () => {
    const idx = routers.indexOf("ocrAttempts:");
    expect(idx).toBeGreaterThan(-1);
    expect(routers.slice(idx, idx + 120)).toMatch(/adminProcedure/);
  });
});
