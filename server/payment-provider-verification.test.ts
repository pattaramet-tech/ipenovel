import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { __test } from "./services/paymentProviderVerificationService";

describe("provider-only payment verification", () => {
  it("treats a Slip2Go 200200 response as verified only when amount and receiver checks are satisfied", () => {
    const raw = {
      code: "200200",
      data: {
        referenceId: "provider-ref-1",
        transRef: "bank-ref-1",
        amount: 125.5,
        dateTime: "2026-09-06T12:00:00.000Z",
      },
    };

    expect(__test.normalizeSlip2GoResponse(raw, 200, "125.50", true)).toMatchObject({
      provider: "slip2go",
      outcome: "VERIFIED",
      amount: "125.50",
      amountMatches: true,
      recipientCheckApplied: true,
    });

    expect(__test.normalizeSlip2GoResponse(raw, 200, "125.50", false).outcome).toBe("REVIEW_REQUIRED");
    expect(__test.normalizeSlip2GoResponse(raw, 200, "125.51", true).outcome).toBe("REVIEW_REQUIRED");
  });

  it("does not promote found-only or provider errors to verified", () => {
    expect(__test.normalizeSlip2GoResponse({ code: "200000", data: { amount: 10 } }, 200, "10.00", true).outcome).toBe("REVIEW_REQUIRED");
    expect(__test.normalizeSlip2GoResponse({ code: "500500" }, 500, "10.00", true).outcome).toBe("ERROR");
  });

  it("contains no Payment V2 evidence/hash/private-R2 verification dependency", () => {
    const path = fileURLToPath(new URL("./services/paymentProviderVerificationService.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    for (const forbidden of [
      "slipEvidenceBindings",
      "slipEvidenceUploads",
      "evidenceVersion",
      "fileHash",
      "hashSlipFileBytes",
      "isPrivateObjectRef",
      "extractPrivateObjectKey",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
