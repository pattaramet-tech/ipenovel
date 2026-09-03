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

  it("the approval mode takes the exclusive user/points barrier before payment", () => {
    const start = orderCode.indexOf(
      "export async function lockAndRequireReviewablePayment("
    );
    const body = orderCode.slice(start, start + 3000);
    const exclusive = body.indexOf(
      "await db.assertAccountMergePointsMutationAllowed(ownerOrder.userId, tx)"
    );
    const payment = body.indexOf(
      "await db.lockPaymentForUpdate(paymentId, tx)"
    );

    expect(exclusive).toBeGreaterThan(-1);
    expect(payment).toBeGreaterThan(exclusive);
    expect(dbCode).toMatch(
      /export async function assertAccountMergePointsMutationAllowed\([\s\S]*lockAccountMergeUserRows\(\[userId\], tx\)/
    );
  });

  it("manual and automatic approval explicitly request points-exclusive ordering", () => {
    const manual = orderCode.slice(
      orderCode.indexOf("async function approvePaymentInTx(")
    );
    expect(manual).toMatch(
      /lockAndRequireReviewablePayment\(\s*paymentId,\s*tx,\s*undefined,\s*"points_exclusive"/
    );

    const automatic = submissionCode.slice(
      submissionCode.indexOf(
        "await dbConnection.transaction(async (tx: any) => {"
      )
    );
    expect(automatic).toMatch(
      /lockAndRequireReviewablePayment\(\s*payment\.id,\s*tx,\s*publishedSlipVersion,\s*"points_exclusive"/
    );
  });

  it("OCR Recheck remains on the shared mutation path and never asks for the points lock", () => {
    expect(recheckCode).toContain("updatePaymentIfNotFinalized");
    expect(recheckCode).not.toContain("points_exclusive");
    expect(recheckCode).not.toContain(
      "assertAccountMergePointsMutationAllowed"
    );
  });
});
