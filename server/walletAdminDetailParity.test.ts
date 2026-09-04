/**
 * IPE-001-C05 P2: "Wallet admin detail must run the same evaluateSlipConflict
 * semantics as order detail before any mutation attempt."
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `wallet.admin.detail` (server/routers.ts) only fetched the raw top-up row,
 * user, and audit logs - it never ran `evaluateSlipConflict`, unlike
 * `admin.orders.detail`. A legacy case ambiguity, an alias-group ambiguity,
 * or an unresolved historical row was therefore invisible on the wallet
 * detail page: normal Approve was the ONLY way an admin discovered the
 * blocker, since it fails server-side with the corresponding reason. The
 * client (client/src/pages/AdminWalletTopupDetailPage.tsx) compounded this by
 * deriving its "show the resolution controls" flag SOLELY from a failed
 * Approve mutation's error string, so the ambiguity was invisible on initial
 * load / refresh even after the router bug is fixed.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * `wallet.admin.detail` now runs the identical evaluateSlipConflict-based
 * classification `admin.orders.detail` already used, with sourceType
 * "wallet_topup", and returns the same `ocrMeta.duplicate`/`reviewReason`
 * shape. The client now builds an `OcrPanelInput` from that `ocrMeta` and
 * uses `requiresLegacyCaseResolution`/`describeDuplicate` (the SAME pure
 * functions the order detail panel already uses) to decide what to show,
 * on the INITIAL load - not only after a failed Approve.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("routers.ts wallet.admin.detail mirrors admin.orders.detail's conflict classification", () => {
  const code = readCode("server/routers.ts");

  function block(): string {
    const start = code.indexOf('detail: adminProcedure\n        .input(z.object({ topupId: z.number() }))');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("approveTopup: adminProcedure", start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end);
  }

  it("runs evaluateSlipConflict with sourceType wallet_topup, not order_payment", () => {
    const body = block();
    expect(body).toMatch(/const conflict = await evaluateSlipConflict\(/);
    expect(body).toMatch(/sourceType: "wallet_topup"/);
    expect(body).not.toMatch(/sourceType: "order_payment"/);
  });

  it("derives identifiers and the raw legacy-lookup reference from the topup's OWN extractedData", () => {
    const body = block();
    expect(body).toMatch(
      /deriveStrongIdentifiersFromExtractedData\(\s*rawTopup\.extractedData as string\s*\)/
    );
    expect(body).toMatch(
      /getRawReferenceForLegacyLookup\(\s*rawTopup\.extractedData as string\s*\)/
    );
  });

  it("covers all four conflict kinds with the identical reviewReason terminology as order detail", () => {
    const body = block();
    expect(body).toMatch(/conflict\.kind === "strong_duplicate"/);
    expect(body).toMatch(/conflict\.kind === "legacy_case_ambiguity"/);
    expect(body).toMatch(/reviewReasonOverride = "LEGACY_REFERENCE_CASE_AMBIGUITY"/);
    expect(body).toMatch(/conflict\.kind === "unresolved"/);
    expect(body).toMatch(/reviewReasonOverride = "LEGACY_APPROVED_SLIP_UNRESOLVED"/);
    expect(body).toMatch(/conflict\.kind === "legacy_case_ambiguity_group"/);
    expect(body).toMatch(/reviewReasonOverride = "LEGACY_ALIAS_GROUP_AMBIGUITY"/);
  });

  it("never grants requiresAdminResolution: true for unresolved or the alias group - only the single-member ambiguity", () => {
    const body = block();
    const unresolvedIdx = body.indexOf('conflict.kind === "unresolved"');
    const unresolvedBlock = body.slice(unresolvedIdx, unresolvedIdx + 500);
    expect(unresolvedBlock).not.toMatch(/requiresAdminResolution: true/);

    const groupIdx = body.indexOf('conflict.kind === "legacy_case_ambiguity_group"');
    const groupBlock = body.slice(groupIdx, groupIdx + 500);
    expect(groupBlock).not.toMatch(/requiresAdminResolution: true/);
  });

  it("resolves matched-source navigation server-side, the same helper order detail uses", () => {
    const body = block();
    expect(body).toMatch(/await resolveMatchedSourceNavigation\(/);
    expect(body).toMatch(/duplicate\.matchedOrderId = nav\.orderId/);
  });

  it("recomputes the recipient verdict from the topup's own stored extraction", () => {
    const body = block();
    expect(body).toMatch(/recipient = verifyRecipient\(parsedExtracted\)/);
  });

  it("returns the SAME ocrMeta shape (effectiveWindowMinutes, duplicate, fileIdentifierStatus, recipient, reviewReason)", () => {
    const body = block();
    expect(body).toMatch(/ocrMeta: \{/);
    expect(body).toMatch(/effectiveWindowMinutes: ocrConfig\.maxTimeWindowMinutes/);
    expect(body).toMatch(/duplicate,/);
    expect(body).toMatch(/fileIdentifierStatus,/);
    expect(body).toMatch(/recipient,/);
    expect(body).toMatch(
      /reviewReason: reviewReasonOverride \?\? \(rawTopup\?\.reviewReason as string \| undefined\)/
    );
  });

  it("this discovery is read-only - the query never mutates the topup or writes a claim", () => {
    const body = block();
    expect(body).not.toMatch(/\.update\(/);
    expect(body).not.toMatch(/\.insert\(/);
    expect(body).not.toMatch(/claimSlip/);
  });
});

describe("AdminWalletTopupDetailPage surfaces the wallet ocrMeta on initial load, not only after a failed Approve", () => {
  const code = readCode("client/src/pages/AdminWalletTopupDetailPage.tsx");

  it("imports the SAME pure presentation functions the order detail panel uses", () => {
    expect(code).toMatch(/import \{[\s\S]*describeDuplicate,[\s\S]*\} from "@\/components\/ocrVerdictModel"/);
    expect(code).toMatch(/requiresLegacyCaseResolution/);
  });

  it("builds the model from data.ocrMeta, not from the approve-error string alone", () => {
    const idx = code.indexOf("const ocrMeta = (data as any).ocrMeta;");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 400);
    expect(body).toMatch(/duplicate: ocrMeta\?\.duplicate \?\? null/);
    expect(body).toMatch(/requiresLegacyCaseResolution\(model\)/);
  });

  it("the resolution-control flag is driven by requiresLegacyCaseResolution OR the legacy approve-error fallback - not the error alone", () => {
    const idx = code.indexOf("const legacyCaseAmbiguity =");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 300);
    // Anchored to the START of the assignment's expression, not merely
    // present somewhere in the block - `false && requiresLegacyCaseResolution(model) ||`
    // would satisfy a loose "contains" check while never actually being true.
    expect(body).toMatch(/const legacyCaseAmbiguity =\s*\n?\s*requiresLegacyCaseResolution\(model\)\s*\|\|/);
    expect(body).not.toMatch(/false\s*&&\s*requiresLegacyCaseResolution/);
  });

  it("a general duplicate banner covers strong/unresolved/group states distinctly from the actionable single-member box", () => {
    expect(code).toMatch(/showGeneralDuplicateBanner/);
    expect(code).toMatch(
      /duplicate\.strength !== "none" && duplicate\.strength !== "legacy_case_ambiguity"/
    );
  });

  it("matched-source navigation is rendered as a real link when the server resolved one", () => {
    const idx = code.indexOf("showGeneralDuplicateBanner &&");
    const body = code.slice(idx, idx + 1500);
    expect(body).toMatch(/duplicate\.matchedHref/);
    expect(body).toMatch(/duplicate\.matchedLabel/);
  });
});
