/**
 * R40R54R3 runtime contract: updateWalletTopupWithOCRApproval is
 * staging-only.
 *
 * REAL-IMPLEMENTATION PROOF (no module mocks): these tests import the real
 * server/db.ts and call the real helper. The settlement-status rejection
 * runs BEFORE any database access, so it is provable without a live DB.
 * Calls that clear the contract gate then fail with the standard
 * "Database not available" sentinel - which here is the positive proof that
 * the staging call got PAST the staging-only contract check.
 *
 * The SQL-level CAS guard (affectedRows under a concurrent settlement)
 * remains an S6 disposable-MySQL proof - see walletTopupLifecycle.test.ts
 * (structural) and walletTopupOcrStaleOutcome.test.ts (handler-level).
 */
import { describe, expect, it } from "vitest";
import * as db from "../db";

const STAGING_ONLY_ERROR = /OCR staging-only/;

describe("R40R54R3 updateWalletTopupWithOCRApproval staging-only contract (real implementation)", () => {
  it("scenario 8a: rejects status 'approved' - approval requires the credited authoritative transaction", async () => {
    await expect(
      db.updateWalletTopupWithOCRApproval(1, { status: "approved" as never })
    ).rejects.toThrowError(STAGING_ONLY_ERROR);
  });

  it("scenario 8b: rejects status 'rejected' - rejection belongs to the review endpoint", async () => {
    await expect(
      db.updateWalletTopupWithOCRApproval(1, { status: "rejected" as never })
    ).rejects.toThrowError(STAGING_ONLY_ERROR);
  });

  it("scenario 8c: rejects status 'cancelled' - cancellation belongs to the review endpoint", async () => {
    await expect(
      db.updateWalletTopupWithOCRApproval(1, { status: "cancelled" as never })
    ).rejects.toThrowError(STAGING_ONLY_ERROR);
  });

  it("a valid staging status passes the contract gate (fails later only on DB availability)", async () => {
    await expect(
      db.updateWalletTopupWithOCRApproval(1, { status: "pending_review" })
    ).rejects.toThrowError(/Database not available/);
  });

  it("metadata-only staging (no status) also passes the contract gate", async () => {
    await expect(
      db.updateWalletTopupWithOCRApproval(1, {
        ocrConfidence: 95,
        reviewReason: "LOW_CONFIDENCE",
      })
    ).rejects.toThrowError(/Database not available/);
  });
});
