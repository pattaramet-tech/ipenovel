import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as lifecycleService from "./accountRecoveryLifecycleService";
import * as compensationService from "./accountRecoveryCompensationService";
import { buildAccountRecoveryClosureReadiness } from "./accountRecoveryClosureReadinessService";

vi.mock("../db", async () => ({ ...(await vi.importActual<typeof db>("../db")) }));
vi.mock("./accountRecoveryLifecycleService", async () => ({ ...(await vi.importActual<typeof lifecycleService>("./accountRecoveryLifecycleService")) }));
vi.mock("./accountRecoveryCompensationService", async () => ({ ...(await vi.importActual<typeof compensationService>("./accountRecoveryCompensationService")) }));

const input = {
  duplicateRequestId: 90003,
  canonicalRequestId: 90007,
  donorAccountId: 21960193,
  survivorAccountId: 763680006,
  expectedGoogleIdentityId: 5370059,
  expectedMergeCaseId: 1,
};

function mockReady() {
  vi.spyOn(db, "getAccountRecoveryRequestById")
    .mockResolvedValueOnce({ id: 90003, requesterUserId: 763680006, status: "cancelled", createdAt: new Date("2026-08-23") } as any)
    .mockResolvedValueOnce({ id: 90007, requesterUserId: 763680006, status: "blocked", createdAt: new Date("2026-09-09") } as any);
  vi.spyOn(db, "listAccountRecoveryAuditLogsForRequest").mockResolvedValue([
    { action: "cancelled", safeMetadata: JSON.stringify({ resolution: "superseded_duplicate", supersededByRequestId: 90007 }) },
  ] as any);
  vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([] as any);
  vi.spyOn(lifecycleService, "buildAccountRecoveryLifecycleProjection").mockResolvedValue({
    persistedStatus: "blocked",
    effectiveStatus: "resolved_via_advanced_merge",
    resolutionKind: "advanced_account_merge",
    integrity: "verified",
    integrityIssue: null,
    mergeCaseId: 1,
    mergeCaseStatus: "completed",
    completedAt: new Date(),
    auditLogId: 5,
  });
  vi.spyOn(compensationService, "buildCompensatingRecoveryPlan").mockResolvedValue({
    mode: "dry_run_only",
    executionAuthorized: false,
    roleSemanticsVersion: "requester-survivor-v2",
    requestId: 90007,
    donorAccountId: 21960193,
    survivorAccountId: 763680006,
    decision: "NO_REPAIR_REQUIRED",
    refusalReasons: [],
    evidence: { unresolvedEconomicFindings: [] },
    plannedMutations: [],
    planDigest: "a".repeat(64),
  } as any);
}

describe("buildAccountRecoveryClosureReadiness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns READY_FOR_PREVIEW only when duplicate, merge, compensation, and lifecycle closure all verify", async () => {
    mockReady();
    const first = await buildAccountRecoveryClosureReadiness(input);
    vi.restoreAllMocks();
    mockReady();
    const second = await buildAccountRecoveryClosureReadiness(input);
    expect(first.decision).toBe("READY_FOR_PREVIEW");
    expect(first.executionAuthorized).toBe(false);
    expect(first.refusalReasons).toEqual([]);
    expect(first.evidence.compensationDecision).toBe("NO_REPAIR_REQUIRED");
    expect(first.readinessDigest).toBe(second.readinessDigest);
  });

  it("fails closed when the supersede audit provenance is missing", async () => {
    mockReady();
    vi.mocked(db.listAccountRecoveryAuditLogsForRequest).mockResolvedValue([] as any);
    const result = await buildAccountRecoveryClosureReadiness(input);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons).toContain("SUPERSEDE_AUDIT_MISSING");
    expect(lifecycleService.buildAccountRecoveryLifecycleProjection).not.toHaveBeenCalled();
  });

  it("fails closed if the duplicate owns any merge case", async () => {
    mockReady();
    vi.mocked(db.listAccountMergeCasesForRecoveryRequest).mockResolvedValue([{ id: 99 }] as any);
    const result = await buildAccountRecoveryClosureReadiness(input);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons).toContain("DUPLICATE_HAS_MERGE_CASE");
  });

  it("fails closed when compensation still requires any mutation", async () => {
    mockReady();
    vi.mocked(compensationService.buildCompensatingRecoveryPlan).mockResolvedValue({
      decision: "READY_FOR_SEPARATE_AUTHORIZATION",
      refusalReasons: [],
      plannedMutations: [{ kind: "reconcile_donor_data_to_survivor" }],
      evidence: { unresolvedEconomicFindings: [{ table: "orders", count: 1 }] },
      planDigest: "b".repeat(64),
    } as any);
    const result = await buildAccountRecoveryClosureReadiness(input);
    expect(result.decision).toBe("REFUSE");
    expect(result.refusalReasons).toContain("COMPENSATION_NOT_CLOSED");
  });
});
