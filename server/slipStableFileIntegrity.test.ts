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

describe("walletTopupSubmissionService.ts (wallet auto-submission) re-hashes before publishing anything OCR-derived", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("computes the pre-OCR hash from the stored bytes, not from any client input", () => {
    expect(code).toMatch(
      /const walletSlipFileHash = await computeSlipFileHash\(slipImageUrl\);/
    );
  });

  it("re-hashes the SAME slip URL after OCR extraction, before duplicate/confidence/amount checks or auto-approval", () => {
    const rehashIdx = code.indexOf("const walletRehash = await computeSlipFileHash(");
    expect(rehashIdx).toBeGreaterThan(-1);
    expect(code.slice(rehashIdx, rehashIdx + 60)).toMatch(
      /computeSlipFileHash\(slipImageUrl\)/
    );

    const duplicateCheckIdx = code.indexOf('verificationResult.reviewReason?.includes("DUPLICATE")');
    const autoApproveIdx = code.indexOf("await autoApproveWalletTopup(");
    expect(rehashIdx).toBeLessThan(duplicateCheckIdx);
    expect(rehashIdx).toBeLessThan(autoApproveIdx);
  });

  it("a mismatch routes to pending review with NO extraction published - not even the fileHash-only fallback", () => {
    const rehashIdx = code.indexOf("const walletRehash = await computeSlipFileHash(");
    const body = code.slice(rehashIdx, rehashIdx + 1200);
    expect(body).toMatch(/if \(walletRehash !== walletSlipFileHash\) \{/);
    expect(body).toMatch(/"SLIP_INTEGRITY_MISMATCH"/);
    expect(body).toMatch(/return await handlePendingReview\(/);
    // The call must NOT pass extractedData or the fileHash-only fallback -
    // both positional args after the reason/message are undefined.
    const callIdx = body.indexOf("return await handlePendingReview(");
    const callBody = body.slice(callIdx, callIdx + 300);
    // readCode() strips comments, so the arg list is: reason, message, then
    // (blank lines where the comment was) three `undefined,` args in a row -
    // extractedData, fingerprint, verificationResult all deliberately absent.
    expect(callBody).toMatch(
      /"SLIP_INTEGRITY_MISMATCH",[\s\S]*?"ส่งสลิปแล้ว รอแอดมินตรวจสอบ",[\s\S]*?undefined,\s*\n\s*undefined,\s*\n\s*undefined,/
    );
  });

  it("the re-hash only runs when a baseline hash actually exists - never a false mismatch from two absent hashes", () => {
    expect(code).toMatch(/if \(walletSlipFileHash\) \{\s*\n\s*const walletRehash/);
  });

  it("the pre-existing slip-version guard (expectedSlipVersion) is threaded into the integrity-mismatch review write too", () => {
    const rehashIdx = code.indexOf("const walletRehash = await computeSlipFileHash(");
    const body = code.slice(rehashIdx, rehashIdx + 1200);
    expect(body).toMatch(/expectedSlipVersion,/);
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

    const walletMismatchIdx = walletCode.indexOf("if (walletRehash !== walletSlipFileHash) {");
    const walletMismatchEnd = walletCode.indexOf("return await handlePendingReview(", walletMismatchIdx);
    const walletMismatchCallEnd = walletCode.indexOf(");", walletMismatchEnd);
    const walletMismatchBody = walletCode.slice(walletMismatchIdx, walletMismatchCallEnd);
    expect(walletMismatchBody).not.toMatch(/autoApproveWalletTopup/);
  });
});
