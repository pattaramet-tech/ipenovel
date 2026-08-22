import { describe, expect, it } from "vitest";
import {
  buildChecklist,
  canRecheckOcr,
  compareTransactionTime,
  deriveVerdict,
  describeDuplicate,
  describeRecipient,
  verdictLabel,
  type OcrPanelInput,
} from "./ocrVerdictModel";

/**
 * The Admin OCR panel renders exactly what these functions return, so this
 * IS the test of what an admin sees. No DOM is involved (this repo's unit
 * test project has no jsdom/RTL), matching the existing pure-helper pattern.
 */

function input(overrides: Partial<OcrPanelInput> = {}): OcrPanelInput {
  return {
    ocrDecision: "needs_review",
    ocrConfidence: 99,
    paymentStatus: "pending_review",
    expectedAmount: 100,
    allowedWindowMinutes: 120,
    extracted: {
      amount: 100,
      reference: "016234222922AQR05745",
      referenceRaw: "016234222922AQR05745",
      referenceHash: "a".repeat(64),
      confidenceKnown: true,
      detectedBank: "KBANK",
      merchantCode: "KB000002283068",
    },
    ...overrides,
  };
}

describe("deriveVerdict", () => {
  it("auto_approved", () => {
    expect(deriveVerdict(input({ ocrDecision: "auto_approved" }))).toBe("auto_approved");
  });

  it("a passing recheck reads READY FOR ADMIN APPROVAL, never AUTO APPROVED", () => {
    const v = deriveVerdict(input({ readyForAdminApproval: true }));
    expect(v).toBe("ready_for_admin_approval");
    expect(verdictLabel(v)).toBe("READY FOR ADMIN APPROVAL");
    expect(verdictLabel(v)).not.toContain("AUTO");
  });

  it("needs_review", () => {
    expect(verdictLabel(deriveVerdict(input()))).toBe("NEEDS REVIEW");
  });

  it("ocr disabled", () => {
    expect(deriveVerdict(input({ ocrDecision: "ocr_disabled" }))).toBe("ocr_disabled");
  });
});

describe("compareTransactionTime", () => {
  it("computes the difference in minutes against the ORIGINAL submission time", () => {
    const t = compareTransactionTime(
      input({
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T10:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:30:00Z",
      })
    );
    expect(t.differenceMinutes).toBe(30);
    expect(t.withinWindow).toBe(true);
    expect(t.allowedWindowMinutes).toBe(120);
  });

  it("flags a transaction outside the allowed window", () => {
    const t = compareTransactionTime(
      input({
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T05:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:30:00Z",
      })
    );
    expect(t.withinWindow).toBe(false);
  });

  it("warns about a possible OCR year misread when the gap is a year or more", () => {
    const t = compareTransactionTime(
      input({
        extracted: { ...input().extracted!, transactionDateTime: "2024-08-22T21:03:00Z" },
        slipSubmittedAt: "2026-08-22T22:30:00Z",
      })
    );
    expect(t.possibleMisreadWarning).toBeDefined();
    expect(t.possibleMisreadWarning).toMatch(/misread/i);
    expect(t.possibleMisreadWarning).toMatch(/uncorrected/i);
  });

  it("does NOT warn for an ordinary small gap", () => {
    const t = compareTransactionTime(
      input({
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T10:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:30:00Z",
      })
    );
    expect(t.possibleMisreadWarning).toBeUndefined();
  });

  it("handles a missing date without throwing", () => {
    const t = compareTransactionTime(input({ extracted: { amount: 100 } }));
    expect(t.transactionAt).toBeUndefined();
    expect(t.differenceMinutes).toBeUndefined();
  });
});

describe("describeDuplicate", () => {
  it("a strong match is stated as a confirmed duplicate and links the owner", () => {
    const d = describeDuplicate(
      input({
        duplicate: { strength: "strong", matchedSourceType: "order_payment", matchedSourceId: 123 },
      })
    );
    expect(d.strength).toBe("strong");
    expect(d.headline).toMatch(/Confirmed duplicate/i);
    expect(d.matchedLabel).toBe("Order payment #123");
    expect(d.matchedHref).toContain("123");
  });

  it("links a wallet top-up owner", () => {
    const d = describeDuplicate(
      input({
        duplicate: { strength: "strong", matchedSourceType: "wallet_topup", matchedSourceId: 55 },
      })
    );
    expect(d.matchedLabel).toBe("Wallet top-up #55");
  });

  it("a weak match ALWAYS carries the not-proof caveat", () => {
    const d = describeDuplicate(input({ duplicate: { strength: "weak" } }));
    expect(d.strength).toBe("weak");
    expect(d.headline).toMatch(/Possible duplicate/i);
    expect(d.caveat).toMatch(/not proof/i);
    expect(d.caveat).toMatch(/legitimately/i);
  });

  it("WEAK_DUPLICATE_RISK alone is presented as weak", () => {
    const d = describeDuplicate(input({ reviewReason: "WEAK_DUPLICATE_RISK", duplicate: null }));
    expect(d.strength).toBe("weak");
    expect(d.caveat).toBeDefined();
  });

  it("a legacy fingerprint is shown as LEGACY/WEAK, never as strong proof", () => {
    const d = describeDuplicate(
      input({
        legacyFingerprint: "deadbeef",
        extracted: { amount: 100 },
        duplicate: null,
      })
    );
    expect(d.strength).toBe("legacy");
    expect(d.caveat).toMatch(/NOT proof/i);
  });

  it("no signal reads as none", () => {
    expect(describeDuplicate(input({ duplicate: null })).strength).toBe("none");
  });
});

describe("describeRecipient - graded by evidence strength", () => {
  it("an exact merchant transaction code is the strongest evidence", () => {
    const r = describeRecipient(
      input({
        extracted: { ...input().extracted!, merchantTransactionCode: "KPS004KB000002283068" },
      })
    );
    expect(r.verified).toBe(true);
    expect(r.evidenceType).toBe("merchant_transaction_code");
    expect(r.state).toBe("pass");
  });

  it("an exact merchant code verifies", () => {
    const r = describeRecipient(input());
    expect(r.evidenceType).toBe("merchant_code");
    expect(r.verified).toBe(true);
  });

  it("an exact biller id verifies - bill-payment slips expose this instead", () => {
    const r = describeRecipient(
      input({
        extracted: { amount: 100, receiverAccountOrId: "010753600031501" },
      })
    );
    expect(r.evidenceType).toBe("biller_id");
    expect(r.verified).toBe(true);
  });

  it("a shop-name match verifies but is explicitly weaker than a code match", () => {
    const r = describeRecipient(input({ extracted: { amount: 100, shopName: "Ipe Novel" } }));
    expect(r.verified).toBe(true);
    expect(r.evidenceType).toBe("shop_alias");
    expect(r.state).toBe("warning");
    expect(r.detail).toMatch(/weaker/i);
  });

  it("insufficient evidence is a WARNING routed to review, never a rejection", () => {
    const r = describeRecipient(input({ extracted: { amount: 100 } }));
    expect(r.verified).toBe(false);
    expect(r.evidenceType).toBe("insufficient");
    expect(r.state).toBe("warning");
    expect(r.state).not.toBe("fail");
  });

  it("does not require every bank to print the same field", () => {
    // KBank transfer slip: no merchant code, but a matching receiver name.
    const kbank = describeRecipient(input({ extracted: { amount: 100, receiverName: "Ipenovel" } }));
    expect(kbank.verified).toBe(true);
  });
});

describe("buildChecklist", () => {
  it("covers every required row", () => {
    const keys = buildChecklist(input()).map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "provider",
        "image",
        "amount",
        "recipient",
        "transaction_date",
        "transaction_time",
        "freshness",
        "reference",
        "duplicate_reference",
        "duplicate_file",
        "duplicate_qr",
        "weak_duplicate",
        "confidence",
        "final",
      ])
    );
  });

  it("shows expected vs extracted amount", () => {
    const row = buildChecklist(input()).find((r) => r.key === "amount")!;
    expect(row.state).toBe("pass");
    expect(row.detail).toMatch(/Expected 100/);
    expect(row.detail).toMatch(/extracted 100/);
  });

  it("fails the amount row on a mismatch", () => {
    const row = buildChecklist(
      input({ extracted: { ...input().extracted!, amount: 250 } })
    ).find((r) => r.key === "amount")!;
    expect(row.state).toBe("fail");
  });

  it("a provider outage marks data checks NOT EVALUATED, never FAIL", () => {
    const rows = buildChecklist(
      input({
        category: "TECHNICAL",
        reviewReason: "PROVIDER_RETRY_EXHAUSTED",
        providerDiagnostic: {
          code: "PROVIDER_RETRY_EXHAUSTED",
          providerHttpStatus: 503,
          providerAttemptCount: 3,
          message: "The OCR provider failed with HTTP 503 after 3 attempt(s).",
        },
        extracted: null,
      })
    );

    expect(rows.find((r) => r.key === "provider")!.state).toBe("fail");
    expect(rows.find((r) => r.key === "provider")!.detail).toMatch(/503/);
    // The slip was never fairly evaluated - blaming it would be wrong.
    for (const key of ["amount", "reference", "transaction_date", "confidence"]) {
      expect(rows.find((r) => r.key === key)!.state).toBe("not_evaluated");
    }
  });

  it("an image-preparation failure marks the provider row NOT EVALUATED", () => {
    const rows = buildChecklist(
      input({
        category: "TECHNICAL",
        providerDiagnostic: {
          code: "OCR_IMAGE_PREPARATION_FAILED",
          message: "The slip image could not be prepared for OCR.",
        },
        extracted: null,
      })
    );
    expect(rows.find((r) => r.key === "image")!.state).toBe("fail");
    expect(rows.find((r) => r.key === "provider")!.state).toBe("not_evaluated");
  });

  it("unknown confidence fails the confidence row with a clear reason", () => {
    const row = buildChecklist(
      input({ extracted: { ...input().extracted!, confidenceKnown: false } })
    ).find((r) => r.key === "confidence")!;
    expect(row.state).toBe("fail");
    expect(row.detail).toMatch(/Not reported/i);
  });

  it("a missing reference fails the reference row", () => {
    const row = buildChecklist(
      input({ extracted: { amount: 100, confidenceKnown: true } })
    ).find((r) => r.key === "reference")!;
    expect(row.state).toBe("fail");
  });

  it("the weak-duplicate row warns and carries the caveat", () => {
    const row = buildChecklist(input({ reviewReason: "WEAK_DUPLICATE_RISK" })).find(
      (r) => r.key === "weak_duplicate"
    )!;
    expect(row.state).toBe("warning");
    expect(row.detail).toMatch(/not proof/i);
  });

  it("QR duplicate is NOT EVALUATED while QR decoding is disabled", () => {
    const row = buildChecklist(input()).find((r) => r.key === "duplicate_qr")!;
    expect(row.state).toBe("not_evaluated");
    expect(row.detail).toMatch(/not enabled/i);
  });

  it("final verification passes when the recheck is ready for approval", () => {
    const row = buildChecklist(input({ readyForAdminApproval: true })).find(
      (r) => r.key === "final"
    )!;
    expect(row.state).toBe("pass");
  });
});

describe("canRecheckOcr", () => {
  it("allowed for pending_review", () => {
    expect(canRecheckOcr(input({ paymentStatus: "pending_review" }))).toBe(true);
  });

  it("refused for a finalized payment - recheck cannot change it anyway", () => {
    expect(canRecheckOcr(input({ paymentStatus: "approved" }))).toBe(false);
    expect(canRecheckOcr(input({ paymentStatus: "rejected" }))).toBe(false);
  });
});

describe("backward compatibility with legacy rows", () => {
  it("handles a row with no extracted data at all", () => {
    expect(() => buildChecklist({ extracted: null })).not.toThrow();
    expect(deriveVerdict({})).toBe("unknown");
  });

  it("handles a legacy row with only reference + fingerprint", () => {
    const legacy: OcrPanelInput = {
      ocrDecision: "needs_review",
      legacyFingerprint: "abc123",
      extracted: { amount: 100, reference: "OLDREF123" },
    };
    expect(() => buildChecklist(legacy)).not.toThrow();
    expect(describeDuplicate(legacy).strength).toBe("legacy");
  });

  it("treats a legacy row's missing confidenceKnown as known (not a false failure)", () => {
    const row = buildChecklist({
      ocrConfidence: 90,
      extracted: { amount: 100, reference: "X1234" },
    }).find((r) => r.key === "confidence")!;
    expect(row.state).toBe("pass");
  });
});

// ─── Server-driven fields (correction round) ─────────────────────────────

describe("effective freshness window comes from the server", () => {
  it("uses whatever window the server supplied, not a hard-coded 120", () => {
    const t = compareTransactionTime(
      input({
        allowedWindowMinutes: 30,
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T10:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:45:00Z",
      })
    );
    // 45 min elapsed against a 30 min window -> outside.
    expect(t.allowedWindowMinutes).toBe(30);
    expect(t.differenceMinutes).toBe(45);
    expect(t.withinWindow).toBe(false);
  });

  it("the same slip passes under a larger configured window", () => {
    const t = compareTransactionTime(
      input({
        allowedWindowMinutes: 240,
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T10:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:45:00Z",
      })
    );
    expect(t.withinWindow).toBe(true);
  });

  it("reports NOT EVALUATED when no window was supplied rather than assuming one", () => {
    const row = buildChecklist(
      input({
        allowedWindowMinutes: null,
        extracted: { ...input().extracted!, transactionDateTime: "2026-08-22T10:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:45:00Z",
      })
    ).find((r) => r.key === "freshness")!;
    expect(row.state).toBe("not_evaluated");
  });
});

describe("server recipient verdict is rendered, not re-decided", () => {
  it("renders a strong server verdict as PASS", () => {
    const r = describeRecipient(
      input({
        extracted: { amount: 100 },
        serverRecipient: {
          recipientVerified: true,
          recipientEvidenceType: "merchant_code",
          recipientEvidenceStrength: "strong",
        },
      })
    );
    expect(r.verified).toBe(true);
    expect(r.state).toBe("pass");
    expect(r.detail).toMatch(/server-verified/i);
  });

  it("renders a fallback server verdict as WARNING", () => {
    const r = describeRecipient(
      input({
        extracted: { amount: 100 },
        serverRecipient: {
          recipientVerified: true,
          recipientEvidenceType: "shop_alias",
          recipientEvidenceStrength: "fallback",
        },
      })
    );
    expect(r.state).toBe("warning");
    expect(r.detail).toMatch(/weaker/i);
  });

  it("renders an unverified server verdict without claiming verification", () => {
    const r = describeRecipient(
      input({
        extracted: { amount: 100, merchantCode: "KB000002283068" },
        serverRecipient: {
          recipientVerified: false,
          recipientEvidenceType: "insufficient",
          recipientEvidenceStrength: "none",
        },
      })
    );
    // Server said no; the local fallback must NOT override it to "verified".
    expect(r.verified).toBe(false);
    expect(r.evidenceType).toBe("insufficient");
  });
});

describe("duplicate panel is driven by server data", () => {
  it("a strong server duplicate links the matched wallet top-up", () => {
    const d = describeDuplicate(
      input({
        duplicate: { strength: "strong", matchedSourceType: "wallet_topup", matchedSourceId: 88 },
      })
    );
    expect(d.strength).toBe("strong");
    expect(d.matchedLabel).toBe("Wallet top-up #88");
    expect(d.matchedHref).toContain("88");
  });

  it("a legacy-compatibility match says so explicitly", () => {
    const d = describeDuplicate(
      input({
        duplicate: {
          strength: "strong",
          matchedSourceType: "order_payment",
          matchedSourceId: 12,
          viaLegacyCompatibility: true,
        },
      })
    );
    expect(d.headline).toMatch(/predates the claim registry/i);
  });

  it("an old fingerprint alone is still only LEGACY / WEAK", () => {
    const d = describeDuplicate(
      input({ legacyFingerprint: "abc", extracted: { amount: 100 }, duplicate: null })
    );
    expect(d.strength).toBe("legacy");
    expect(d.strength).not.toBe("strong");
  });
});

describe("exact-file identifier status", () => {
  it("AVAILABLE marks the file row PASS and never shows a hash", () => {
    const row = buildChecklist(input({ fileIdentifierStatus: "AVAILABLE" })).find(
      (r) => r.key === "duplicate_file"
    )!;
    expect(row.state).toBe("pass");
    expect(row.detail).toBe("Exact File Identifier: AVAILABLE");
    expect(row.detail).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("MATCH fails the row", () => {
    const row = buildChecklist(input({ fileIdentifierStatus: "MATCH" })).find(
      (r) => r.key === "duplicate_file"
    )!;
    expect(row.state).toBe("fail");
  });

  it("UNAVAILABLE is NOT EVALUATED, never a false pass", () => {
    const row = buildChecklist(input({ fileIdentifierStatus: "UNAVAILABLE" })).find(
      (r) => r.key === "duplicate_file"
    )!;
    expect(row.state).toBe("not_evaluated");
  });
});

describe("QR stays deferred and never falsely clears anything", () => {
  it("QR row is NOT EVALUATED and says decoding is disabled", () => {
    const row = buildChecklist(input()).find((r) => r.key === "duplicate_qr")!;
    expect(row.state).toBe("not_evaluated");
    expect(row.state).not.toBe("pass");
    expect(row.detail).toMatch(/not enabled/i);
  });

  it("a deferred QR check never turns a failing verdict into a pass", () => {
    const rows = buildChecklist(input({ reviewReason: "MISSING_REFERENCE" }));
    expect(rows.find((r) => r.key === "final")!.state).toBe("fail");
  });
});


// ─── P2: date-only freshness must match the server exactly ───────────────

describe("date-only freshness parity with the server", () => {
  const dateOnly = (transactionDate: string, slipSubmittedAt: string, configured: number) =>
    compareTransactionTime(
      input({
        allowedWindowMinutes: configured,
        // No transactionDateTime - only a calendar date, as OCR often yields.
        extracted: { amount: 100, transactionDate },
        slipSubmittedAt,
      })
    );

  const withTime = (transactionDateTime: string, slipSubmittedAt: string, configured: number) =>
    compareTransactionTime(
      input({
        allowedWindowMinutes: configured,
        extracted: { amount: 100, transactionDateTime },
        slipSubmittedAt,
      })
    );

  it("configured=120, DATE-ONLY, 600 min gap -> PASS (server grants >= 1440)", () => {
    const t = dateOnly("2026-08-22T00:00:00Z", "2026-08-22T10:00:00Z", 120);
    expect(t.differenceMinutes).toBe(600);
    expect(t.allowedWindowMinutes).toBe(1440);
    // Previously this rendered FAIL against the bare 120-minute window while
    // the server had accepted the slip.
    expect(t.withinWindow).toBe(true);
  });

  it("configured=120, WITH TIME, 600 min gap -> FAIL (matches the server)", () => {
    const t = withTime("2026-08-22T00:00:00Z", "2026-08-22T10:00:00Z", 120);
    expect(t.differenceMinutes).toBe(600);
    expect(t.allowedWindowMinutes).toBe(120);
    expect(t.withinWindow).toBe(false);
  });

  it("configured=2000, DATE-ONLY uses 2000, not the 1440 floor", () => {
    const t = dateOnly("2026-08-22T00:00:00Z", "2026-08-22T10:00:00Z", 2000);
    expect(t.allowedWindowMinutes).toBe(2000);
  });

  it("a date-only slip beyond a full day still FAILS", () => {
    const t = dateOnly("2026-08-20T00:00:00Z", "2026-08-22T10:00:00Z", 120);
    expect(t.withinWindow).toBe(false);
  });

  it("missing config still reports NOT EVALUATED, never an assumed window", () => {
    const row = buildChecklist(
      input({
        allowedWindowMinutes: null,
        extracted: { amount: 100, transactionDate: "2026-08-22T00:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:00:00Z",
      })
    ).find((r) => r.key === "freshness")!;
    expect(row.state).toBe("not_evaluated");
  });

  it("the freshness checklist row shows the EFFECTIVE allowance", () => {
    const row = buildChecklist(
      input({
        allowedWindowMinutes: 120,
        extracted: { amount: 100, transactionDate: "2026-08-22T00:00:00Z" },
        slipSubmittedAt: "2026-08-22T10:00:00Z",
      })
    ).find((r) => r.key === "freshness")!;
    expect(row.state).toBe("pass");
    expect(row.detail).toContain("1440");
  });
});
