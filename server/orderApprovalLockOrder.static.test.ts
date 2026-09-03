import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("IPE-020 order approval lock contract", () => {
  const dbCode = read("server/db.ts");
  const orderCode = read("server/services/orderService.ts");
  const submissionCode = read("server/services/slipSubmissionService.ts");
  const recheckCode = read("server/services/ocrRecheckService.ts");

  it("approval takes only the shared account guard before payment; the points balance mutex is deferred until finalization", () => {
    const start = orderCode.indexOf(
      "export async function lockAndRequireReviewablePayment("
    );
    const body = orderCode.slice(start, start + 3000);
    const accountGuard = body.indexOf(
      "db.assertAccountMergeClassifiedMutationAllowed(ownerOrder.userId, tx)"
    );
    const payment = body.indexOf(
      "db.lockPaymentForUpdate(paymentId, tx)"
    );

    expect(accountGuard).toBeGreaterThan(-1);
    expect(payment).toBeGreaterThan(accountGuard);
    expect(body).not.toContain("assertAccountMergePointsMutationAllowed");
    expect(dbCode).toMatch(
      /export async function assertAccountMergePointsMutationAllowed\([\s\S]*assertAccountMergeClassifiedMutationAllowed\(userId, tx\)[\s\S]*lockPointsAccountRowsForUpdate\(\[userId\], tx\)/
    );
  });

  it("manual and automatic approval use the same shared guard primitive without a points-exclusive mode", () => {
    const manual = orderCode.slice(
      orderCode.indexOf("async function approvePaymentInTx(")
    );
    expect(manual).toMatch(/lockAndRequireReviewablePayment\(paymentId, tx\)/);
    expect(manual).not.toContain("points_exclusive");

    const automatic = submissionCode.slice(
      submissionCode.indexOf(
        "await dbConnection.transaction(async (tx: any) => {"
      )
    );
    expect(automatic).toMatch(
      /lockAndRequireReviewablePayment\(\s*payment\.id,\s*tx,\s*publishedSlipVersion\s*\)/
    );
    expect(automatic).not.toContain("points_exclusive");
  });

  it("OCR Recheck remains on the shared mutation path and never asks for the points lock", () => {
    expect(recheckCode).toContain("updatePaymentIfNotFinalized");
    expect(recheckCode).not.toContain("points_exclusive");
    expect(recheckCode).not.toContain(
      "assertAccountMergePointsMutationAllowed"
    );
  });
});
