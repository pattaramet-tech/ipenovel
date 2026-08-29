import { describe, expect, it } from "vitest";
import { getAdminUserDeleteAssessment } from "./db";
import {
  adminUserAuditLogs,
  orders,
  accountMergeCases,
  accountMergeAuditLogs,
  accountMergeFinancialReconciliations,
} from "../drizzle/schema";

/**
 * Direct, unmocked test of getAdminUserDeleteAssessment's REAL check list
 * (ADMIN_USER_DELETE_CHECKS in server/db.ts) - not just the classification
 * doc in adminUserDeletionClassification.ts. A fake "database" stands in
 * for the real connection, returning a canned COUNT(*) result per table so
 * this needs no live database - same purpose as
 * accountRecoveryDataClassification.test.ts's cross-check between the
 * classification doc and db.ts's actual query lists, applied here to a
 * single, targeted regression: PR #45's review finding that a FORMER admin
 * (now role="user") who performed a past name/role edit or delete must
 * still be blocked from hard-deletion, because that action's audit trail
 * (adminUserAuditLogs.actorAdminId) would otherwise point at a deleted row.
 */

function fakeCountDatabase(countsByTable: Map<any, number>) {
  return {
    select: () => ({
      from: (table: any) => ({
        where: async () => [{ value: countsByTable.get(table) ?? 0 }],
      }),
    }),
  };
}

describe("getAdminUserDeleteAssessment", () => {
  it("a completely empty account (every check returns 0) -> canDelete true, no blockers", async () => {
    const fakeDb = fakeCountDatabase(new Map());
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);
    expect(result).toEqual({ userId: 2, canDelete: true, blockers: [] });
  });

  it("[review finding on PR #45] a FORMER admin with a prior adminUserAuditLogs.actorAdminId row (they performed a past edit/delete while still role=\"admin\") is reported as an audit_or_actor blocker - the actual check list, not just the classification doc, now protects this", async () => {
    const fakeDb = fakeCountDatabase(new Map([[adminUserAuditLogs, 1]]));
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);

    expect(result.canDelete).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        table: "adminUserAuditLogs",
        reference: "Admin User Audit Log Actor References",
        count: 1,
        category: "audit_or_actor",
      })
    );
  });

  it("an ordinary economic blocker (orders) is still reported alongside the new actor check - the new check is additive, not a replacement", async () => {
    const fakeDb = fakeCountDatabase(new Map([[orders, 3]]));
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);

    expect(result.canDelete).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ table: "orders", category: "economic", count: 3 })
    );
    expect(result.blockers.find((b) => b.table === "adminUserAuditLogs")).toBeUndefined();
  });

  it("[IPE-003] an account referenced by an Advanced Account Merge case (as source, target, or creating admin) is blocked from hard-deletion", async () => {
    const fakeDb = fakeCountDatabase(new Map([[accountMergeCases, 1]]));
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);

    expect(result.canDelete).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        table: "accountMergeCases",
        reference: "Account Merge Cases",
        count: 1,
        category: "audit_or_actor",
      })
    );
  });

  it("[IPE-003] an account referenced by an Advanced Account Merge audit log entry is blocked from hard-deletion", async () => {
    const fakeDb = fakeCountDatabase(new Map([[accountMergeAuditLogs, 2]]));
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);

    expect(result.canDelete).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        table: "accountMergeAuditLogs",
        reference: "Account Merge Audit References",
        count: 2,
        category: "audit_or_actor",
      })
    );
  });

  it("[IPE-006] a user referenced by a durable financial reconciliation receipt is blocked from hard-deletion", async () => {
    const fakeDb = fakeCountDatabase(new Map([[accountMergeFinancialReconciliations, 1]]));
    const result = await getAdminUserDeleteAssessment(2, fakeDb as any);

    expect(result.canDelete).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        table: "accountMergeFinancialReconciliations",
        reference: "Account Merge Financial Receipts",
        count: 1,
        category: "audit_or_actor",
      })
    );
  });
});
