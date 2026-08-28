import { describe, expect, it } from "vitest";
import {
  buildChecklist,
  canRecheckOcr,
  compareTransactionTime,
  deriveVerdict,
  describeDuplicate,
  describeRecipient,
  requiresLegacyCaseResolution,
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

  // IPE-001-C05: shadow mode's ocrDecision literally reads
  // "shadow_auto_approved" - the server forced isAutoApproved: false for it,
  // so the payment stays pending_review and NO value was created. It must
  // NEVER collapse into the same "auto_approved" verdict as a real approval.
  it("shadow_auto_approved is its own distinct verdict, never auto_approved", () => {
    const v = deriveVerdict(input({ ocrDecision: "shadow_auto_approved" }));
    expect(v).toBe("shadow_auto_approved");
    expect(v).not.toBe("auto_approved");
  });

  it("shadow_auto_approved's label says SIMULATED, never a bare AUTO APPROVED", () => {
    const label = verdictLabel(deriveVerdict(input({ ocrDecision: "shadow_auto_approved" })));
    expect(label).toMatch(/SIMULAT/i);
    expect(label).not.toBe("AUTO APPROVED");
  });

  it("a real auto_approved decision is completely unaffected by the shadow branch", () => {
    const v = deriveVerdict(input({ ocrDecision: "auto_approved" }));
    expect(v).toBe("auto_approved");
    expect(verdictLabel(v)).toBe("AUTO APPROVED");
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
        duplicate: {
          strength: "strong",
          matchedSourceType: "order_payment",
          matchedSourceId: 123,
          // Resolved server-side: a payment id is NOT an order id.
          matchedOrderId: 77,
        },
      })
    );
    expect(d.strength).toBe("strong");
    expect(d.headline).toMatch(/Confirmed duplicate/i);
    expect(d.matchedLabel).toBe("Order payment #123");
    // The real detail route, not a list page that ignores the parameter.
    expect(d.matchedHref).toBe("/admin/orders/77");
  });

  it("an order payment with no resolved order id gets NO link", () => {
    // A wrong link is worse than none: the admin would land confidently on
    // the wrong order while comparing evidence.
    const d = describeDuplicate(
      input({
        duplicate: { strength: "strong", matchedSourceType: "order_payment", matchedSourceId: 123 },
      })
    );
    expect(d.matchedLabel).toBe("Order payment #123");
    expect(d.matchedHref).toBeUndefined();
  });

  it("links a wallet top-up owner to its detail route", () => {
    const d = describeDuplicate(
      input({
        duplicate: { strength: "strong", matchedSourceType: "wallet_topup", matchedSourceId: 55 },
      })
    );
    expect(d.matchedLabel).toBe("Wallet top-up #55");
    expect(d.matchedHref).toBe("/admin/wallet-topups/55");
  });

  it("a legacy case ambiguity navigates the same correct way", () => {
    const d = describeDuplicate(
      input({
        duplicate: {
          strength: "legacy_case_ambiguity",
          matchedSourceType: "order_payment",
          matchedSourceId: 123,
          matchedOrderId: 77,
        },
      })
    );
    expect(d.strength).toBe("legacy_case_ambiguity");
    expect(d.matchedHref).toBe("/admin/orders/77");
  });

  it("no link is ever built from a list-page query parameter", () => {
    for (const dup of [
      { strength: "strong" as const, matchedSourceType: "order_payment" as const, matchedSourceId: 1, matchedOrderId: 2 },
      { strength: "strong" as const, matchedSourceType: "wallet_topup" as const, matchedSourceId: 3 },
    ]) {
      const d = describeDuplicate(input({ duplicate: dup }));
      expect(d.matchedHref).not.toContain("?paymentId=");
      expect(d.matchedHref).not.toContain("?topupId=");
      expect(d.matchedHref).not.toContain("topup-logs");
    }
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

  // IPE-001-C02: the server can now emit two more blocker states -
  // "unresolved" and "legacy_case_ambiguity_group" - that previously had no
  // branch here and silently fell through to "No duplicate signal", hiding a
  // real blocker (Approve refuses server-side either way).

  it("an unresolved legacy record is presented as a distinct blocker, never 'No duplicate signal'", () => {
    const d = describeDuplicate(
      input({
        duplicate: {
          strength: "unresolved",
          matchedSourceType: "wallet_topup",
          matchedSourceId: 44,
        },
      })
    );
    expect(d.strength).toBe("unresolved");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
    expect(d.headline).toMatch(/could not be verified/i);
    expect(d.caveat).toMatch(/NOT a proven duplicate/i);
    expect(d.matchedLabel).toBe("Wallet top-up #44");
    expect(d.matchedHref).toBe("/admin/wallet-topups/44");
  });

  it("LEGACY_APPROVED_SLIP_UNRESOLVED alone (no duplicate object) still renders the unresolved state", () => {
    const d = describeDuplicate(
      input({ reviewReason: "LEGACY_APPROVED_SLIP_UNRESOLVED", duplicate: null })
    );
    expect(d.strength).toBe("unresolved");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
  });

  it("a legacy alias group ambiguity is presented as a distinct blocker, never 'No duplicate signal'", () => {
    const d = describeDuplicate(
      input({
        duplicate: {
          strength: "legacy_case_ambiguity_group",
          matchedSourceType: "order_payment",
          matchedSourceId: 91,
          matchedOrderId: 12,
        },
      })
    );
    expect(d.strength).toBe("legacy_case_ambiguity_group");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
    expect(d.headline).toMatch(/multiple historical records/i);
    expect(d.caveat).toMatch(/NOT proof of a duplicate/i);
    expect(d.caveat).toMatch(/complete.*group/i);
    expect(d.matchedLabel).toBe("Order payment #91");
    expect(d.matchedHref).toBe("/admin/orders/12");
  });

  it("LEGACY_ALIAS_GROUP_AMBIGUITY alone (no duplicate object) still renders the group state", () => {
    const d = describeDuplicate(
      input({ reviewReason: "LEGACY_ALIAS_GROUP_AMBIGUITY", duplicate: null })
    );
    expect(d.strength).toBe("legacy_case_ambiguity_group");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
  });

  it("unresolved and group states are checked ahead of strong/weak, so they can never be masked", () => {
    // Server states are mutually exclusive in practice, but the branch order
    // itself is what guarantees neither can ever read as a confident match.
    const unresolved = describeDuplicate(
      input({ duplicate: { strength: "unresolved" } })
    );
    const group = describeDuplicate(
      input({ duplicate: { strength: "legacy_case_ambiguity_group" } })
    );
    expect(unresolved.strength).not.toBe("strong");
    expect(unresolved.strength).not.toBe("weak");
    expect(group.strength).not.toBe("strong");
    expect(group.strength).not.toBe("weak");
  });

  // IPE-004-C07: the server has been able to emit `known_collision` since
  // C02 (Approve refuses with LEGACY_KNOWN_COLLISION), but this model had no
  // branch for it, so the value fell through to
  // {strength:"none", headline:"No duplicate signal"} - telling the admin
  // there was nothing to look at while Approve was guaranteed to refuse.

  it("a known historical collision is presented as a distinct blocker, never 'No duplicate signal'", () => {
    const d = describeDuplicate(
      input({
        duplicate: {
          strength: "known_collision",
          matchedSourceType: "order_payment",
          matchedSourceId: 77,
          matchedOrderId: 21,
        },
      })
    );
    expect(d.strength).toBe("known_collision");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
    expect(d.headline).toMatch(/multiple approved records/i);
    expect(d.matchedLabel).toBe("Order payment #77");
    expect(d.matchedHref).toBe("/admin/orders/21");
  });

  it("the known-collision caveat never claims a proven duplicate or a proven owner", () => {
    const d = describeDuplicate(
      input({ duplicate: { strength: "known_collision", matchedSourceType: "wallet_topup", matchedSourceId: 5 } })
    );
    // No winner was ever picked among the colliding historical rows, so the
    // matched row is context only - the wording must say so explicitly.
    expect(d.caveat).toMatch(/NOT proof/i);
    expect(d.caveat).toMatch(/NOT its proven owner/i);
    expect(d.caveat).toMatch(/context only/i);
    expect(d.caveat).toMatch(/manually investigate/i);
    expect(d.headline).not.toMatch(/confirmed duplicate/i);
  });

  it("LEGACY_KNOWN_COLLISION alone (no duplicate object) still renders the known-collision state", () => {
    const d = describeDuplicate(
      input({ reviewReason: "LEGACY_KNOWN_COLLISION", duplicate: null })
    );
    expect(d.strength).toBe("known_collision");
    expect(d.headline).not.toMatch(/no duplicate signal/i);
  });

  it("known_collision is checked ahead of strong/weak, so it can never be masked", () => {
    const kc = describeDuplicate(input({ duplicate: { strength: "known_collision" } }));
    expect(kc.strength).not.toBe("strong");
    expect(kc.strength).not.toBe("weak");
    expect(kc.strength).not.toBe("none");
  });

  it("known_collision is safe to render with no matched source at all", () => {
    const d = describeDuplicate(input({ duplicate: { strength: "known_collision" } }));
    expect(d.strength).toBe("known_collision");
    expect(d.matchedLabel).toBeUndefined();
    expect(d.matchedHref).toBeUndefined();
  });
});

describe("requiresLegacyCaseResolution never fires for unresolved or group ambiguity", () => {
  // Both states need manual investigation, not the single-member "confirm
  // distinct" resolution flow built specifically for the lossy case fold -
  // offering that action here would let an admin waive a state it was never
  // designed to adjudicate.
  it("an unresolved legacy record does not trigger the resolution flow", () => {
    expect(
      requiresLegacyCaseResolution(
        input({
          reviewReason: "LEGACY_APPROVED_SLIP_UNRESOLVED",
          duplicate: { strength: "unresolved" },
        })
      )
    ).toBe(false);
  });

  it("a legacy alias group ambiguity does not trigger the resolution flow", () => {
    expect(
      requiresLegacyCaseResolution(
        input({
          reviewReason: "LEGACY_ALIAS_GROUP_AMBIGUITY",
          duplicate: { strength: "legacy_case_ambiguity_group" },
        })
      )
    ).toBe(false);
  });

  it("the genuine single-member case ambiguity still does trigger it", () => {
    expect(
      requiresLegacyCaseResolution(
        input({
          reviewReason: "LEGACY_REFERENCE_CASE_AMBIGUITY",
          duplicate: { strength: "legacy_case_ambiguity" },
        })
      )
    ).toBe(true);
  });

  it("a known historical collision does not trigger the resolution flow", () => {
    // IPE-004-C07: no single-member "confirm distinct" waiver exists for a
    // collision group - the server consults none, so offering the control
    // would let an admin waive a state it was never designed to adjudicate.
    expect(
      requiresLegacyCaseResolution(
        input({
          reviewReason: "LEGACY_KNOWN_COLLISION",
          duplicate: { strength: "known_collision" },
        })
      )
    ).toBe(false);
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

  it("final verification WARNS (never passes or fails) for a shadow-mode decision - no value was created", () => {
    const row = buildChecklist(input({ ocrDecision: "shadow_auto_approved" })).find(
      (r) => r.key === "final"
    )!;
    expect(row.state).toBe("warning");
    expect(row.state).not.toBe("pass");
    expect(row.detail).toMatch(/shadow mode/i);
    expect(row.detail).toMatch(/nothing was approved|no value/i);
  });

  it("the legacy-unresolved row warns explicitly and is not_evaluated otherwise", () => {
    const warned = buildChecklist(
      input({ duplicate: { strength: "unresolved" } })
    ).find((r) => r.key === "legacy_unresolved")!;
    expect(warned.state).toBe("warning");
    expect(warned.detail).toMatch(/could not be verified/i);

    const clear = buildChecklist(input()).find((r) => r.key === "legacy_unresolved")!;
    expect(clear.state).toBe("not_evaluated");
    expect(clear.detail).toBeUndefined();
  });

  it("the legacy-alias-group row warns explicitly and is not_evaluated otherwise", () => {
    const warned = buildChecklist(
      input({ duplicate: { strength: "legacy_case_ambiguity_group" } })
    ).find((r) => r.key === "legacy_alias_group")!;
    expect(warned.state).toBe("warning");
    expect(warned.detail).toMatch(/MORE THAN ONE/i);

    const clear = buildChecklist(input()).find((r) => r.key === "legacy_alias_group")!;
    expect(clear.state).toBe("not_evaluated");
    expect(clear.detail).toBeUndefined();
  });

  it("the known-collision row warns explicitly and is not_evaluated otherwise", () => {
    // IPE-004-C07: WARNING, never FAIL (nothing is proven about THIS
    // submission) and never a silent PASS (Approve refuses server-side with
    // LEGACY_KNOWN_COLLISION until the group is investigated).
    const warned = buildChecklist(
      input({ duplicate: { strength: "known_collision" } })
    ).find((r) => r.key === "known_collision")!;
    expect(warned.state).toBe("warning");
    expect(warned.detail).toMatch(/MORE THAN ONE/i);
    expect(warned.detail).toMatch(/no owner was ever established/i);

    const clear = buildChecklist(input()).find((r) => r.key === "known_collision")!;
    expect(clear.state).toBe("not_evaluated");
    expect(clear.detail).toBeUndefined();
  });

  it("the known-collision row never reports pass, which would read as cleared", () => {
    const row = buildChecklist(
      input({ duplicate: { strength: "known_collision" } })
    ).find((r) => r.key === "known_collision")!;
    expect(row.state).not.toBe("pass");
    expect(row.state).not.toBe("fail");
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
    expect(d.matchedHref).toBe("/admin/wallet-topups/88");
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
