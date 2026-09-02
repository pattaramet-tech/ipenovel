/**
 * IPE-001-C07 P1: "Invalidate the wallet hash after an integrity mismatch."
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * walletTopupSubmissionService.ts's five SLIP_INTEGRITY_MISMATCH checkpoints
 * (added in C06) all called handlePendingReview/handleOCRError with
 * `extractedData` deliberately `undefined`, meaning "this call has nothing
 * trustworthy to publish". But both handlers only ever WROTE the
 * `extractedData` column when the argument was truthy:
 *
 *   if (extractedData) { updateData.extractedData = JSON.stringify(...); }
 *
 * Passing `undefined` therefore left the key out of `updateData` entirely -
 * the row's PRIOR extractedData (from an earlier automatic attempt, or the
 * deprecated `wallet.uploadTopupSlip` flow) survived untouched. A manual
 * admin approval derives its anti-replay identifiers from whatever is
 * currently persisted (`db.ts`'s `approveWalletTopup`), so it could still
 * claim the STALE hash and credit the wallet while the slip currently
 * displayed at that URL was different, unclaimed bytes.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Two independent layers, either of which alone would close the hole:
 *   1. handlePendingReview/handleOCRError now ALWAYS write the key -
 *      `extractedData ? JSON.stringify(extractedData) : null` - so a mismatch
 *      durably clears any stale extraction, matching the order-side pattern
 *      in slipSubmissionService.ts, which never had this gap.
 *   2. approveWalletTopup (db.ts) independently refuses approval outright
 *      when the row's `reviewReason` is `SLIP_INTEGRITY_MISMATCH`, BEFORE
 *      deriving or claiming any identifier - wallet parity with
 *      orderService.ts's `lockAndRequireReviewablePayment`/
 *      `SLIP_INTEGRITY_BLOCK_REASON` check for order payments.
 *
 * Recovery: a genuine replacement upload (`publishWalletTopupReplacementIfReviewable`)
 * already accepts a "pending_review" row and unconditionally clears
 * `reviewReason` to null as part of its one atomic write, so a customer with
 * a genuinely stable slip is never permanently stuck.
 *
 * Structural, like slipStableFileIntegrity.test.ts: db.ts/walletTopupSubmissionService.ts
 * require a live database transaction to exercise end-to-end (the
 * `.integration.test.ts` project, unavailable in this sandbox).
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

describe("walletTopupSubmissionService.ts: extractedData is always durably written, never left stale", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("handlePendingReview never skips the extractedData write for a falsy value", () => {
    const idx = code.indexOf("async function handlePendingReview(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 2200);
    expect(body).toMatch(
      /updateData\.extractedData = extractedData \? JSON\.stringify\(extractedData\) : null;/
    );
    expect(body).not.toMatch(/if \(extractedData\) \{\s*\n\s*updateData\.extractedData/);
  });

  it("handleOCRError never skips the extractedData write for a falsy value", () => {
    const idx = code.indexOf("async function handleOCRError(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(
      /updateData\.extractedData = extractedData \? JSON\.stringify\(extractedData\) : null;/
    );
    expect(body).not.toMatch(/if \(extractedData\) \{\s*\n\s*updateData\.extractedData/);
  });

  it("every SLIP_INTEGRITY_MISMATCH checkpoint still passes undefined - clearing depends on the handler, not on this caller", () => {
    const mismatchCalls = code.match(
      /"SLIP_INTEGRITY_MISMATCH",\s*\n\s*"ส่งสลิปแล้ว รอแอดมินตรวจสอบ",\s*\n\s*undefined,/g
    );
    expect(mismatchCalls?.length).toBe(5);
  });
});

describe("db.ts approveWalletTopup: durable integrity block, IPE-001-C07", () => {
  const code = readCode("server/db.ts");

  it("refuses approval when reviewReason is SLIP_INTEGRITY_MISMATCH, before deriving or claiming anything", () => {
    const fnIdx = code.indexOf("export async function approveWalletTopup(");
    expect(fnIdx).toBeGreaterThan(-1);
    const guardIdx = code.indexOf('topup.reviewReason === "SLIP_INTEGRITY_MISMATCH"', fnIdx);
    expect(guardIdx).toBeGreaterThan(fnIdx);

    const strongIdentifierIdx = code.indexOf("deriveStrongIdentifiersFromExtractedData", fnIdx);
    const claimIdx = code.indexOf("const claim = await claimSlip(", fnIdx);
    expect(guardIdx).toBeLessThan(strongIdentifierIdx);
    expect(guardIdx).toBeLessThan(claimIdx);

    const guardBody = code.slice(guardIdx, guardIdx + 400);
    expect(guardBody).toMatch(/throw new WalletSlipClaimError\(\s*\n\s*"SLIP_INTEGRITY_MISMATCH_BLOCKED"/);
  });

  it("the block sits before the row is locked's normal strong-identifier gate, not instead of it - both layers run", () => {
    const fnIdx = code.indexOf("export async function approveWalletTopup(");
    const guardIdx = code.indexOf('topup.reviewReason === "SLIP_INTEGRITY_MISMATCH"', fnIdx);
    const hasStrongIdx = code.indexOf("hasStrongIdentifier(identifiers)", fnIdx);
    expect(hasStrongIdx).toBeGreaterThan(guardIdx);
  });
});

describe("walletService.ts: the new block is a precondition, not a conflict, IPE-001-C07", () => {
  const code = readCode("server/services/walletService.ts");

  it("SLIP_INTEGRITY_MISMATCH_BLOCKED is treated the same as NO_STRONG_IDENTIFIER - a precondition the admin must clear", () => {
    expect(code).toMatch(/WALLET_APPROVAL_PRECONDITION_CODES/);
    expect(code).toMatch(/"SLIP_INTEGRITY_MISMATCH_BLOCKED"/);
    expect(code).toMatch(/"NO_STRONG_IDENTIFIER"/);
    expect(code).toMatch(/"PRECONDITION_FAILED"/);
  });
});

describe("db.ts publishWalletTopupReplacementIfReviewable: the recovery path, IPE-001-C07", () => {
  const code = readCode("server/db.ts");

  it("accepts a pending_review row - a customer with a genuinely stable slip is never permanently stuck", () => {
    const idx = code.indexOf("export async function publishWalletTopupReplacementIfReviewable(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(
      /or\(eq\(walletTopups\.status, "pending"\), eq\(walletTopups\.status, "pending_review"\)\)/
    );
  });

  it("unconditionally clears reviewReason as part of the same atomic write that publishes the replacement", () => {
    const idx = code.indexOf("export async function publishWalletTopupReplacementIfReviewable(");
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(/reviewReason: null,/);
  });
});
