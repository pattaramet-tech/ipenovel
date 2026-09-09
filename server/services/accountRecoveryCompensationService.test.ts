import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import {
  buildCompensatingEconomicExecutionGate,
  buildCompensatingRecoveryPlan,
} from "./accountRecoveryCompensationService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

function user(id: number, role: "user" | "admin" = "user") {
  return { id, role, openId: `u-${id}`, name: `User ${id}`, email: null, loginMethod: null } as any;
}

function identity(userId: number, id = 900) {
  return { id, userId, provider: "google", providerSubject: "secret-sub", emailAtLink: "hidden@example.test" } as any;
}

function mockBase(overrides: {
  request?: any;
  donorIdentity?: any;
  survivorIdentity?: any;
  cases?: any[];
  recoveries?: any[];
  caseEvidence?: {
    financialReceiptPresent: boolean;
    dataReceiptPresent: boolean;
    completionAuditPresent: boolean;
  };
  economic?: any[];
  userOwned?: any[];
  walletBalance?: string;
  pointsBalance?: string;
} = {}) {
  vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(
    overrides.request ?? {
      id: 7,
      requesterUserId: 10,
      status: "approved",
      sourceUserId: 10,
      targetUserId: 20,
    } as any
  );
  vi.spyOn(db, "getUserById").mockImplementation(async id => user(id));
  vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockImplementation(async userId => {
    if (userId === 10) return "donorIdentity" in overrides ? overrides.donorIdentity : identity(10);
    if (userId === 20) return "survivorIdentity" in overrides ? overrides.survivorIdentity : undefined;
    return undefined;
  });
  vi.spyOn(db, "listAccountMergeCasesForParticipants").mockResolvedValue((overrides.cases ?? []) as any);
  vi.spyOn(db, "listAccountRecoveryRequestsForParticipants").mockResolvedValue((overrides.recoveries ?? []) as any);
  vi.spyOn(db, "getAccountMergeCompensationCaseEvidence").mockResolvedValue(
    overrides.caseEvidence ?? {
      financialReceiptPresent: false,
      dataReceiptPresent: false,
      completionAuditPresent: false,
    }
  );
  vi.spyOn(db, "findAccountRecoveryEconomicData").mockResolvedValue(overrides.economic ?? []);
  vi.spyOn(db, "findAccountRecoveryUserOwnedData").mockResolvedValue(overrides.userOwned ?? []);
  vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue(overrides.walletBalance ?? "0.00");
  vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue(overrides.pointsBalance ?? "0.00");
}

const baseInput = {
  requestId: 7,
  donorAccountId: 10,
  survivorAccountId: 20,
  expectedRequestStatus: "approved" as const,
  expectedCurrentIdentityOwnerAccountId: 10,
  expectedGoogleIdentityId: 900,
  expectedMergeCaseId: null,
};

describe("buildCompensatingRecoveryPlan", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is deterministic, read-only and always requires separate authorization", async () => {
    mockBase({
      economic: [{ table: "orders", count: 2 }],
      userOwned: [{ table: "carts", count: 1 }],
    });

    const first = await buildCompensatingRecoveryPlan(baseInput);
    const second = await buildCompensatingRecoveryPlan(baseInput);

    expect(first).toEqual(second);
    expect(first.decision).toBe("READY_FOR_SEPARATE_AUTHORIZATION");
    expect(first.mode).toBe("dry_run_only");
    expect(first.executionAuthorized).toBe(false);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.plannedMutations).toEqual([
      expect.objectContaining({ kind: "reconcile_donor_data_to_survivor", donorAccountId: 10, survivorAccountId: 20 }),
      { kind: "move_google_identity_to_survivor", donorAccountId: 10, survivorAccountId: 20 },
      { kind: "finalize_survivor_login_projection", survivorAccountId: 20 },
    ]);
    expect(JSON.stringify(first)).not.toContain("secret-sub");
    expect(JSON.stringify(first)).not.toContain("hidden@example.test");
  });

  it("refuses reversed Donor/Survivor semantics", async () => {
    mockBase();
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      donorAccountId: 20,
      survivorAccountId: 10,
      expectedCurrentIdentityOwnerAccountId: 10,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.executionAuthorized).toBe(false);
    expect(result.refusalReasons.map(r => r.code)).toContain("INVALID_ROLE_BINDING");
    expect(result.plannedMutations).toEqual([]);
  });

  it("refuses Donor and Survivor being the same account", async () => {
    mockBase();
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      survivorAccountId: 10,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.executionAuthorized).toBe(false);
    expect(result.refusalReasons.map(r => r.code)).toContain("INVALID_ROLE_BINDING");
    expect(result.plannedMutations).toEqual([]);
  });

  it("refuses when neither explicit participant currently owns the expected Google identity", async () => {
    mockBase({ donorIdentity: undefined, survivorIdentity: undefined });
    const result = await buildCompensatingRecoveryPlan(baseInput);
    expect(result.decision).toBe("REFUSE");
    expect(result.executionAuthorized).toBe(false);
    expect(result.refusalReasons.map(r => r.code)).toContain("IDENTITY_MISSING");
    expect(result.plannedMutations).toEqual([]);
  });

  it("refuses stale expected identity ownership", async () => {
    mockBase();
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedCurrentIdentityOwnerAccountId: 20,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("IDENTITY_OWNER_DRIFT");
    expect(result.plannedMutations).toEqual([]);
  });

  it("refuses ambiguous identity ownership", async () => {
    mockBase({ survivorIdentity: identity(20, 901) });
    const result = await buildCompensatingRecoveryPlan(baseInput);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("IDENTITY_AMBIGUOUS");
  });

  it("refuses an unresolved active merge case", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      cases: [{
        id: 33,
        sourceUserId: 10,
        targetUserId: 20,
        status: "in_progress",
        originAccountRecoveryRequestId: 7,
      }],
    });
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedRequestStatus: "blocked",
      expectedMergeCaseId: 33,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("ACTIVE_MERGE_CASE");
  });

  it("refuses a conflicting case involving either participant", async () => {
    mockBase({
      cases: [{
        id: 44,
        sourceUserId: 10,
        targetUserId: 99,
        status: "completed",
        originAccountRecoveryRequestId: 6,
      }],
    });
    const result = await buildCompensatingRecoveryPlan(baseInput);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("CONFLICTING_MERGE_CASE");
  });

  it("refuses request/case snapshot drift", async () => {
    mockBase({ cases: [] });
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedMergeCaseId: 999,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("MERGE_CASE_DRIFT");
  });

  it("refuses stale expected Google identity id even when owner is unchanged", async () => {
    mockBase();
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedGoogleIdentityId: 999,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("IDENTITY_ID_DRIFT");
  });

  it("refuses another pending/blocked/approved recovery lifecycle involving either participant", async () => {
    mockBase({
      recoveries: [
        { id: 7, status: "approved" },
        { id: 8, status: "pending" },
      ],
    });
    const result = await buildCompensatingRecoveryPlan(baseInput);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("CONFLICTING_RECOVERY_REQUEST");
    expect(result.evidence.conflictingRecoveryRequestIds).toEqual([8]);
  });

  it("refuses a completed merge case missing any durable completion receipt/audit", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      cases: [{
        id: 55,
        sourceUserId: 10,
        targetUserId: 20,
        status: "completed",
        originAccountRecoveryRequestId: 7,
      }],
      caseEvidence: {
        financialReceiptPresent: true,
        dataReceiptPresent: false,
        completionAuditPresent: true,
      },
    });
    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedRequestStatus: "blocked",
      expectedMergeCaseId: 55,
    });
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(r => r.code)).toContain("PARTIAL_RECONCILIATION_STATE");
  });

  it("treats completed-merge financial history as preserved evidence, not compensating work", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      donorIdentity: undefined,
      survivorIdentity: identity(20),
      cases: [{
        id: 55,
        sourceUserId: 10,
        targetUserId: 20,
        status: "completed",
        originAccountRecoveryRequestId: 7,
      }],
      caseEvidence: {
        financialReceiptPresent: true,
        dataReceiptPresent: true,
        completionAuditPresent: true,
      },
      economic: [
        { table: "walletAccounts", count: 1 },
        { table: "walletTransactions", count: 1 },
        { table: "walletTopups", count: 1 },
        { table: "topupLogs", count: 1 },
        { table: "pointsTransactions", count: 1 },
      ],
      walletBalance: "0.00",
      pointsBalance: "0.00",
    });

    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedRequestStatus: "blocked",
      expectedCurrentIdentityOwnerAccountId: 20,
      expectedMergeCaseId: 55,
    });

    expect(result.decision).toBe("NO_REPAIR_REQUIRED");
    expect(result.refusalReasons).toEqual([]);
    expect(result.plannedMutations).toEqual([]);
    expect(result.evidence.preservedFinancialHistoryFindings.map(row => row.table)).toEqual([
      "pointsTransactions",
      "topupLogs",
      "walletAccounts",
      "walletTopups",
      "walletTransactions",
    ]);
    expect(result.evidence.unresolvedEconomicFindings).toEqual([]);
    expect(result.evidence.donorWalletBalance).toBe("0.00");
    expect(result.evidence.donorPointsBalance).toBe("0.00");
  });

  it("economic execution gate binds the exact current digest and turns a fully reconciled merge into a verified no-write", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      donorIdentity: undefined,
      survivorIdentity: identity(20),
      cases: [{
        id: 55,
        sourceUserId: 10,
        targetUserId: 20,
        status: "completed",
        originAccountRecoveryRequestId: 7,
      }],
      caseEvidence: {
        financialReceiptPresent: true,
        dataReceiptPresent: true,
        completionAuditPresent: true,
      },
      economic: [
        { table: "walletAccounts", count: 1 },
        { table: "pointsTransactions", count: 1 },
      ],
      walletBalance: "0.00",
      pointsBalance: "0.00",
    });
    const input = {
      ...baseInput,
      expectedRequestStatus: "blocked" as const,
      expectedCurrentIdentityOwnerAccountId: 20,
      expectedMergeCaseId: 55,
    };
    const current = await buildCompensatingRecoveryPlan(input);

    const stale = await buildCompensatingEconomicExecutionGate({
      ...input,
      expectedPlanDigest: "0".repeat(64),
    });
    expect(stale.decision).toBe("REFUSE");
    expect(stale.refusalCode).toBe("PLAN_DIGEST_DRIFT");
    expect(stale.executionAuthorized).toBe(false);

    const exact = await buildCompensatingEconomicExecutionGate({
      ...input,
      expectedPlanDigest: current.planDigest,
    });
    expect(exact.decision).toBe("NO_WRITE_REQUIRED");
    expect(exact.refusalCode).toBeNull();
    expect(exact.executionAuthorized).toBe(false);
    expect(exact.currentPlanDigest).toBe(current.planDigest);
    expect(exact.plan.plannedMutations).toEqual([]);
  });

  it("refuses a completed merge whose Donor current wallet or points balance drifted above zero", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      donorIdentity: undefined,
      survivorIdentity: identity(20),
      cases: [{
        id: 55,
        sourceUserId: 10,
        targetUserId: 20,
        status: "completed",
        originAccountRecoveryRequestId: 7,
      }],
      caseEvidence: {
        financialReceiptPresent: true,
        dataReceiptPresent: true,
        completionAuditPresent: true,
      },
      economic: [{ table: "walletAccounts", count: 1 }],
      walletBalance: "1.00",
      pointsBalance: "0.00",
    });

    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedRequestStatus: "blocked",
      expectedCurrentIdentityOwnerAccountId: 20,
      expectedMergeCaseId: 55,
    });

    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(row => row.code)).toContain("POST_MERGE_FINANCIAL_DRIFT");
    expect(result.plannedMutations).toEqual([]);
  });

  it("refuses non-historical Donor rows after a completed merge instead of rewriting them automatically", async () => {
    mockBase({
      request: { id: 7, requesterUserId: 10, status: "blocked", sourceUserId: null, targetUserId: null },
      donorIdentity: undefined,
      survivorIdentity: identity(20),
      cases: [{
        id: 55,
        sourceUserId: 10,
        targetUserId: 20,
        status: "completed",
        originAccountRecoveryRequestId: 7,
      }],
      caseEvidence: {
        financialReceiptPresent: true,
        dataReceiptPresent: true,
        completionAuditPresent: true,
      },
      economic: [{ table: "orders", count: 1 }],
    });

    const result = await buildCompensatingRecoveryPlan({
      ...baseInput,
      expectedRequestStatus: "blocked",
      expectedCurrentIdentityOwnerAccountId: 20,
      expectedMergeCaseId: 55,
    });

    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons.map(row => row.code)).toContain("POST_MERGE_DATA_DRIFT");
    expect(result.plannedMutations).toEqual([]);
    expect(result.evidence.unresolvedEconomicFindings).toEqual([{ table: "orders", count: 1 }]);
  });
});
