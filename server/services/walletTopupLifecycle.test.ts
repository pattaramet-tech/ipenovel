import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R40R54R1 terminal-state protection tripwire for the OCR pending_review
 * branch of approveWalletTopupWithOCR.
 *
 * The ORIGINAL defect: the pending_review UPDATE matched `WHERE id = ?` with
 * NO previous-status restriction, so a LATE/duplicate OCR result could revert
 * an APPROVED (credited), REJECTED, or CANCELLED topup back to
 * pending_review — re-opening a settled financial record.
 *
 * The repair adds a conditional WHERE restricting the (re-)staging to
 * pending/pending_review. Because the UPDATE is guarded at the SQL level,
 * terminal states can never be matched - proven here STRUCTURALLY by
 * asserting the WHERE clause of that exact UPDATE statement.
 *
 * Row-level race timing + managed-transaction rollback remain a
 * disposable-MySQL qualification gap (reported - not provable with mocks).
 *
 * R40R54R2 extends this tripwire to the USER-slip OCR staging helper
 * updateWalletTopupWithOCRApproval (walletTopupSubmissionService):
 * same defect class - an id-only UPDATE reachable seconds after the
 * pending-status precheck (OCR verification latency), able to revert a
 * concurrently APPROVED (credited) topup to pending_review, which a later
 * admin approval could then credit a SECOND time.
 */

const dbSource = readFileSync(
  fileURLToPath(new URL("../db.ts", import.meta.url)),
  "utf8",
);

/** Extract the pending_review UPDATE statement's full text from db.ts. */
function ocrPendingReviewUpdateSection(): string {
  const startMarker = '      // For pending_review: only (re-)stage while the topup is still in a';
  const start = dbSource.indexOf(startMarker);
  expect(start, "pending_review UPDATE section not found in db.ts").toBeGreaterThan(-1);
  const endMarker = "      const updated =";
  const end = dbSource.indexOf(endMarker, start);
  expect(end, "resultHeader anchor not found").toBeGreaterThan(start);
  return dbSource.slice(start, end);
}

describe("R40R54R1 OCR pending_review terminal-state protection (structural)", () => {
  const section = ocrPendingReviewUpdateSection();

  it("updates with a conditional WHERE restricting status to pending/pending_review", () => {
    expect(section).toContain('status: "pending_review" as any,');
    expect(section).toContain('eq(walletTopups.id, topupId)');
    expect(section).toContain('eq(walletTopups.status, "pending" as any)');
    expect(section).toContain('eq(walletTopups.status, "pending_review" as any)');
  });

  it("checks affectedRows and returns the authoritative row on a stale outcome", () => {
    expect(section).toContain("const affectedRows =");
    expect(section).toContain("if (affectedRows === 0)");
    expect(section).toContain("return existing[0]");
  });

  it("the pending_review UPDATE is status-guarded (no bare id-only WHERE)", () => {
    const updateWhere = section.slice(
      section.indexOf(".where(and("),
      section.indexOf(");", section.indexOf(".where(and("))
    );
    expect(updateWhere).toContain("eq(walletTopups.status, \"pending\" as any)");
    expect(updateWhere).toContain("eq(walletTopups.status, \"pending_review\" as any)");
    // The guarded UPDATE must NOT contain a bare id-only WHERE (the original
    // defect). Only the stale-outcome re-read SELECT may use the id-only form.
    const updateWhereOnly = section.slice(
      section.indexOf(".update(walletTopups)"),
      section.indexOf(".where(and(")
    );
    expect(updateWhereOnly + section.slice(section.indexOf(".where(and("), section.indexOf("const resultHeader"))).not.toMatch(
      /\.where\(eq\(walletTopups\.id, topupId\)\)/
    );
  });
});

describe("R40R54R1 late-OCR lifecycle semantics (mirrors real-DB scenarios)", () => {
  // Terminal statuses that a late OCR result must never revert.
  const terminalStates = ["approved", "rejected", "cancelled"] as const;

  it("an APPROVED topup is never re-staged to pending_review by a late OCR result", () => {
    // The guard's WHERE only matches pending/pending_review - an approved row
    // cannot be matched by the pending_review UPDATE (proven via the
    // conditional WHERE in the previous test). This documents the settled
    // state remains intact.
    const guarded = ocrPendingReviewUpdateSection();
    expect(guarded).toContain('"pending"');
    expect(guarded).toContain('"pending_review"');
    expect(guarded).not.toContain('"approved" as any)');
    expect(guarded).not.toContain('"rejected" as any)');
    expect(guarded).not.toContain('"cancelled" as any)');
  });

  it("rejectWalletTopup's conditional UPDATE never matches an approved topup", () => {
    // rejectWalletTopup's WHERE is pending/pending_review - an approved topup
    // cannot be rejected (money already credited stays credited).
    const rejectSection = dbSource.slice(
      dbSource.indexOf("export async function rejectWalletTopup"),
      dbSource.indexOf("/**\n * Repair wallet credit")
    );
    expect(rejectSection).toContain('eq(walletTopups.status, "pending" as any)');
    expect(rejectSection).toContain('eq(walletTopups.status, "pending_review" as any)');
  });
});

/** Extract the user-slip OCR staging helper's full body from db.ts. */
function updateWalletTopupWithOCRApprovalSection(): string {
  const start = dbSource.indexOf("export async function updateWalletTopupWithOCRApproval(");
  expect(start, "updateWalletTopupWithOCRApproval not found in db.ts").toBeGreaterThan(-1);
  const end = dbSource.indexOf("export async function", start + 10);
  expect(end, "function end anchor not found").toBeGreaterThan(start);
  return dbSource.slice(start, end);
}

describe("R40R54R2 user-slip OCR staging terminal-state protection (structural)", () => {
  const section = updateWalletTopupWithOCRApprovalSection();

  it("stages pending_review only while status is still pending/pending_review", () => {
    expect(section).toContain("eq(walletTopups.id, topupId)");
    expect(section).toContain('eq(walletTopups.status, "pending" as any)');
    expect(section).toContain('eq(walletTopups.status, "pending_review" as any)');
  });

  it("checks affectedRows and returns the authoritative row on a stale outcome", () => {
    expect(section).toContain("const resultHeader");
    expect(section).toContain("const affectedRows =");
    expect(section).toContain("if (affectedRows === 0)");
    expect(section).toContain("return { updated: false, topup: existing[0] }");
    expect(section).toContain("return { updated: true, topup: staged }");
  });

  it("R40R54R3: the helper is staging-only - settlement statuses are rejected before any DB access", () => {
    expect(section).toContain('status?: "pending_review";');
    expect(section).toContain(
      'updates.status !== undefined && updates.status !== "pending_review"'
    );
    expect(section).toContain("is OCR staging-only");
  });

  it("R40R54R3: the helper returns a structured {updated, topup} outcome", () => {
    expect(section).toContain("Promise<{ updated: boolean; topup: any }>");
  });

  it("the staging UPDATE is wrapped in and(id, status IN pending/pending_review)", () => {
    // Scope: from the UPDATE through the result read - the only WHERE allowed
    // before the stale-outcome re-read is the guarded and(...) form. A revert
    // to the id-only WHERE (the original defect) fails this assertion.
    const from = section.indexOf(".update(walletTopups)");
    expect(from).toBeGreaterThan(-1);
    const to = section.indexOf("const resultHeader", from);
    expect(to).toBeGreaterThan(from);
    const updateStatement = section.slice(from, to);
    expect(updateStatement).toContain(".where(and(");
    expect(updateStatement).not.toContain(".where(eq(");
    expect(updateStatement).toContain('eq(walletTopups.status, "pending" as any)');
    expect(updateStatement).toContain('eq(walletTopups.status, "pending_review" as any)');
  });

  it("terminal states are unreachable by the staging UPDATE (approved/rejected/cancelled excluded)", () => {
    const from = section.indexOf(".update(walletTopups)");
    const to = section.indexOf("const resultHeader", from);
    const updateStatement = section.slice(from, to);
    expect(updateStatement).not.toContain('"approved" as any)');
    expect(updateStatement).not.toContain('"rejected" as any)');
    expect(updateStatement).not.toContain('"cancelled" as any)');
  });

  it("all three submission-service call sites stage through the guarded helper", () => {
    // The submission service must not grow a parallel unguarded UPDATE path.
    const serviceSource = readFileSync(
      fileURLToPath(new URL("./walletTopupSubmissionService.ts", import.meta.url)),
      "utf8",
    );
    const guardedCalls = serviceSource.split("db.updateWalletTopupWithOCRApproval(").length - 1;
    expect(guardedCalls).toBe(3);
    expect(serviceSource).not.toMatch(/\.update\(walletTopups\)/);
  });
});
