/**
 * IPE-001-C05 P2: "Bind automatic order/wallet file identity to stable bytes
 * before any claim or value creation."
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * Both slipSubmissionService.ts and walletTopupSubmissionService.ts compute
 * an exact-file identifier ONCE, from the stored bytes, BEFORE OCR runs.
 * OCR itself independently re-fetches the SAME stored object
 * (prepareSlipImageForOcr), sometimes seconds later, through a completely
 * separate code path. If the object behind that URL/key was mutated in
 * between - same key, different bytes - every downstream artifact (the
 * atomic claim, auto-approval, or even the metadata persisted for a LATER
 * manual admin approval to trust) would still be keyed to the ORIGINAL,
 * now-stale hash, letting a swapped-in image evade the exact-file identity
 * check it was supposed to be bound to.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Both services re-hash the SAME published/expected slip URL immediately
 * after OCR completes, before anything OCR-derived is published. A mismatch
 * fails closed: no claim attempt, no auto-approval, no wallet credit, and
 * the extraction itself is never published (not even as a fileHash-only
 * fallback) - a distinct SLIP_INTEGRITY_MISMATCH review state is recorded
 * instead, using the existing pending_review schema and the pre-existing
 * slip-version guards (`publishedSlipVersion`/`expectedSlipVersion`), which
 * this fix does not touch.
 *
 * These services require a live database transaction to run end-to-end
 * (they are covered by the `.integration.test.ts` project, which needs
 * TEST_DATABASE_URL and is unavailable in this sandbox - see
 * vitest.config.ts's exclusion of *.integration.test.ts from the unit
 * project). This file therefore pins the SOURCE behavior directly, matching
 * the established pattern for this codebase's other DB-transaction-heavy
 * files (e.g. unresolvedLegacyProtectionParity.test.ts's routers.ts pins).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("slipSubmissionService.ts (order auto-submission) re-hashes before publishing anything OCR-derived", () => {
  const code = readCode("server/services/slipSubmissionService.ts");

  it("computes the pre-OCR hash from the stored bytes, not from any client input", () => {
    expect(code).toMatch(
      /const slipFileHash = await computeSlipFileHash\(input\.slipImageUrl\);/
    );
  });

  it("re-hashes the SAME published slip after OCR, before the auto-approval transaction or the manual-review write", () => {
    const rehashIdx = code.indexOf("const rehash = await computeSlipFileHash(");
    expect(rehashIdx).toBeGreaterThan(-1);
    expect(code.slice(rehashIdx, rehashIdx + 90)).toMatch(
      /computeSlipFileHash\(publishedSlipVersion\.slipImageUrl\)/
    );

    // Placed BEFORE the auto-approval transaction (claimSlip) and BEFORE the
    // manual-review publish (sendToReview) - both must see the outcome.
    const transactionIdx = code.indexOf("await dbConnection.transaction(");
    const sendToReviewIdx = code.indexOf("await ApprovalService.sendToReview(");
    expect(rehashIdx).toBeLessThan(transactionIdx);
    expect(rehashIdx).toBeLessThan(sendToReviewIdx);
  });

  it("a mismatch forces shouldApprove closed and clears the extraction - never a stale claim", () => {
    const rehashIdx = code.indexOf("const rehash = await computeSlipFileHash(");
    const body = code.slice(rehashIdx, rehashIdx + 900);
    expect(body).toMatch(/if \(rehash !== slipFileHash\) \{/);
    expect(body).toMatch(/shouldApprove = false;/);
    expect(body).toMatch(/reviewReason: "SLIP_INTEGRITY_MISMATCH"/);
    expect(body).toMatch(/extractedData: null/);
  });

  it("the re-hash only runs when a baseline hash actually exists - never a false mismatch from two absent hashes", () => {
    const idx = code.indexOf(
      "if (slipFileHash) {\n    const rehash = await computeSlipFileHash("
    );
    expect(idx).toBeGreaterThan(-1);
  });

  it("the pre-existing slip-version guards (publishedSlipVersion / lockAndRequireReviewablePayment) are untouched", () => {
    expect(code).toMatch(/orderService\.lockAndRequireReviewablePayment\(payment\.id, tx, publishedSlipVersion\)/);
  });
});

describe("walletTopupSubmissionService.ts (wallet auto-submission): class-wide stable-file verification, IPE-001-C06", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("computes the pre-OCR hash from the stored bytes, not from any client input", () => {
    expect(code).toMatch(
      /const walletSlipFileHash = await computeSlipFileHash\(slipImageUrl\);/
    );
  });

  it("defines ONE shared stability check, reused at every terminal path - not five independent copies", () => {
    const idx = code.indexOf("async function verifyWalletSlipStillStable(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 400);
    expect(body).toMatch(/if \(!baselineHash\) return true;/);
    expect(body).toMatch(/const rehash = await computeSlipFileHash\(slipImageUrl\);/);
    expect(body).toMatch(/return rehash === baselineHash;/);
  });

  it("is called at all FIVE terminal paths that could otherwise publish a stale baseline hash", () => {
    const calls = code.match(/await verifyWalletSlipStillStable\(slipImageUrl, walletSlipFileHash\)/g);
    // OCR disabled, technical error, shadow mode, post-extraction (the
    // original C05 checkpoint), and the outer catch.
    expect(calls?.length).toBe(5);
  });

  it("OCR-disabled path: mismatch is checked before the OCR_DISABLED write", () => {
    const gateIdx = code.indexOf("if (!ocrConfig.enabled) {");
    const checkIdx = code.indexOf("verifyWalletSlipStillStable(slipImageUrl, walletSlipFileHash)", gateIdx);
    const ocrDisabledIdx = code.indexOf('"OCR_DISABLED"', gateIdx);
    expect(checkIdx).toBeGreaterThan(gateIdx);
    expect(checkIdx).toBeLessThan(ocrDisabledIdx);
    const mismatchBody = code.slice(checkIdx, ocrDisabledIdx);
    expect(mismatchBody).toMatch(/"SLIP_INTEGRITY_MISMATCH"/);
  });

  it("technical-error path: mismatch is checked before handleOCRError persists the stale fallback", () => {
    const gateIdx = code.indexOf("if (parseResult.technicalError) {");
    const checkIdx = code.indexOf("verifyWalletSlipStillStable(slipImageUrl, walletSlipFileHash)", gateIdx);
    const handleOCRErrorIdx = code.indexOf("return await handleOCRError(", gateIdx);
    expect(checkIdx).toBeGreaterThan(gateIdx);
    expect(checkIdx).toBeLessThan(handleOCRErrorIdx);
    const mismatchBody = code.slice(checkIdx, handleOCRErrorIdx);
    expect(mismatchBody).toMatch(/"SLIP_INTEGRITY_MISMATCH"/);
  });

  it("shadow-mode path: mismatch is checked before the SHADOW_MODE write", () => {
    const gateIdx = code.indexOf("if (ocrConfig.shadowModeEnabled) {");
    const checkIdx = code.indexOf("verifyWalletSlipStillStable(slipImageUrl, walletSlipFileHash)", gateIdx);
    const shadowIdx = code.indexOf('"SHADOW_MODE"', gateIdx);
    expect(checkIdx).toBeGreaterThan(gateIdx);
    expect(checkIdx).toBeLessThan(shadowIdx);
    const mismatchBody = code.slice(checkIdx, shadowIdx);
    expect(mismatchBody).toMatch(/"SLIP_INTEGRITY_MISMATCH"/);
  });

  it("post-extraction path (the original checkpoint): still runs before duplicate/confidence/amount checks or auto-approval", () => {
    const checkIdx = code.indexOf(
      'if (!(await verifyWalletSlipStillStable(slipImageUrl, walletSlipFileHash))) {\n      console.error(\n        `[OCR] slip integrity mismatch for wallet top-up ${topupId}: stored bytes changed during OCR processing`'
    );
    expect(checkIdx).toBeGreaterThan(-1);
    const duplicateCheckIdx = code.indexOf('verificationResult.reviewReason?.includes("DUPLICATE")');
    const autoApproveIdx = code.indexOf("await autoApproveWalletTopup(");
    expect(checkIdx).toBeLessThan(duplicateCheckIdx);
    expect(checkIdx).toBeLessThan(autoApproveIdx);
  });

  it("outer-catch path: mismatch is checked before handleOCRError persists the stale fallback, regardless of what threw", () => {
    const gateIdx = code.indexOf("} catch (error: any) {");
    expect(gateIdx).toBeGreaterThan(-1);
    const checkIdx = code.indexOf("verifyWalletSlipStillStable(slipImageUrl, walletSlipFileHash)", gateIdx);
    const handleOCRErrorIdx = code.indexOf("return await handleOCRError(", gateIdx);
    expect(checkIdx).toBeGreaterThan(gateIdx);
    expect(checkIdx).toBeLessThan(handleOCRErrorIdx);
    const mismatchBody = code.slice(checkIdx, handleOCRErrorIdx);
    expect(mismatchBody).toMatch(/"SLIP_INTEGRITY_MISMATCH"/);
  });

  it("every mismatch branch routes through handlePendingReview with NO extraction published - not even the fileHash-only fallback", () => {
    let searchFrom = 0;
    let occurrences = 0;
    for (;;) {
      const reasonIdx = code.indexOf('"SLIP_INTEGRITY_MISMATCH"', searchFrom);
      if (reasonIdx === -1) break;
      occurrences += 1;
      // handlePendingReview( must open shortly BEFORE this reason string.
      const callOpenIdx = code.lastIndexOf("return await handlePendingReview(", reasonIdx);
      expect(reasonIdx - callOpenIdx).toBeLessThan(120);
      // Every SLIP_INTEGRITY_MISMATCH call passes undefined for
      // extractedData/fingerprint/verificationResult - never
      // fileHashOnlyExtraction or a partial extraction.
      const argsBody = code.slice(reasonIdx, reasonIdx + 300);
      expect(argsBody).toMatch(/undefined,\s*\n\s*undefined,\s*\n\s*undefined,/);
      expect(argsBody).not.toMatch(/fileHashOnlyExtraction/);
      searchFrom = reasonIdx + 1;
    }
    expect(occurrences).toBe(5);
  });

  it("every mismatch branch threads the pre-existing expectedSlipVersion guard", () => {
    const mismatchBlocks = code.split('"SLIP_INTEGRITY_MISMATCH"').slice(1);
    for (const block of mismatchBlocks) {
      expect(block.slice(0, 500)).toMatch(/expectedSlipVersion,/);
    }
  });

  it("the shared check only runs when a baseline hash actually exists - never a false mismatch from two absent hashes", () => {
    const idx = code.indexOf("async function verifyWalletSlipStillStable(");
    const body = code.slice(idx, idx + 200);
    expect(body).toMatch(/if \(!baselineHash\) return true;/);
  });
});

describe("both services fail closed identically - same reviewReason, same 'never publish stale extraction' rule", () => {
  const orderCode = readCode("server/services/slipSubmissionService.ts");
  const walletCode = readCode("server/services/walletTopupSubmissionService.ts");

  it("both name the SAME SLIP_INTEGRITY_MISMATCH reason", () => {
    expect(orderCode).toMatch(/SLIP_INTEGRITY_MISMATCH/);
    expect(walletCode).toMatch(/SLIP_INTEGRITY_MISMATCH/);
  });

  it("neither ever attempts a claim after a detected mismatch - the mismatch branch never reaches claimSlip / autoApproveWalletTopup", () => {
    const orderMismatchIdx = orderCode.indexOf("if (rehash !== slipFileHash) {");
    const orderMismatchEnd = orderCode.indexOf("}", orderCode.indexOf("extractedData: null", orderMismatchIdx));
    const orderMismatchBody = orderCode.slice(orderMismatchIdx, orderMismatchEnd + 40);
    expect(orderMismatchBody).not.toMatch(/claimSlip/);

    // None of the wallet service's five SLIP_INTEGRITY_MISMATCH call sites
    // ever reach autoApproveWalletTopup - each is a `return` before it.
    const walletMismatchBlocks = walletCode.split('"SLIP_INTEGRITY_MISMATCH"').slice(1);
    expect(walletMismatchBlocks.length).toBe(5);
    for (const block of walletMismatchBlocks) {
      expect(block.slice(0, 400)).not.toMatch(/autoApproveWalletTopup/);
    }
  });

  it("both services define exactly one shared stability-check function - not one copy per call site", () => {
    expect(orderCode.match(/computeSlipFileHash\(publishedSlipVersion\.slipImageUrl\)/g)?.length).toBe(1);
    expect(walletCode.match(/async function verifyWalletSlipStillStable\(/g)?.length).toBe(1);
  });
});
