import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as orchestration from "./accountMergeOrchestrationService";
import {
  buildAccountRecoveryLifecycleProjection,
} from "./accountRecoveryLifecycleService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

vi.mock("./accountMergeOrchestrationService", async () => {
  const actual = await vi.importActual<typeof orchestration>("./accountMergeOrchestrationService");
  return { ...actual };
});

const request = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  requesterUserId: 20,
  status: "blocked",
  ...overrides,
});

const completedCase = (overrides: Record<string, unknown> = {}) => ({
  id: 55,
  originAccountRecoveryRequestId: 7,
  sourceUserId: 10,
  targetUserId: 20,
  status: "completed",
  completedAt: new Date("2026-09-09T13:48:07Z"),
  ...overrides,
});

const completedStatus = (overrides: Record<string, unknown> = {}) => ({
  alreadyCompleted: true,
  mergeCaseId: 55,
  requestId: 7,
  sourceUserId: 10,
  targetUserId: 20,
  donorAccountId: 10,
  survivorAccountId: 20,
  status: "completed" as const,
  completedAt: new Date("2026-09-09T13:48:07Z"),
  auditLogId: 123,
  financial: {},
  dataSummary: {},
  tableActions: [],
  identityMoved: false as const,
  identityPreservedOnSurvivor: true as const,
  ...overrides,
});

describe("buildAccountRecoveryLifecycleProjection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes non-blocked lifecycle states through without touching Account Merge", async () => {
    const listSpy = vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest");
    const result = await buildAccountRecoveryLifecycleProjection(request({ status: "approved" }));

    expect(result).toMatchObject({
      persistedStatus: "approved",
      effectiveStatus: "approved",
      integrity: "not_applicable",
      resolutionKind: null,
    });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("keeps an ordinary blocked request unresolved when it has no Advanced Merge case", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([] as any);

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      persistedStatus: "blocked",
      effectiveStatus: "blocked",
      integrity: "unresolved",
      mergeCaseId: null,
    });
  });

  it("keeps an in-progress Advanced Merge as blocked/unresolved", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase({ status: "in_progress", completedAt: null }),
    ] as any);

    const statusSpy = vi.spyOn(orchestration, "getAccountMergeExecutionStatus");
    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      effectiveStatus: "blocked",
      integrity: "unresolved",
      mergeCaseId: 55,
      mergeCaseStatus: "in_progress",
    });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("fails closed when multiple non-cancelled merge cases exist for one recovery request", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase({ id: 55 }),
      completedCase({ id: 56 }),
    ] as any);

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      effectiveStatus: "blocked",
      integrity: "inconsistent",
      integrityIssue: "MULTIPLE_NON_CANCELLED_MERGE_CASES",
    });
  });

  it("fails closed when the merge Survivor does not match the persisted requester role", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase({ targetUserId: 99 }),
    ] as any);

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      effectiveStatus: "blocked",
      integrity: "inconsistent",
      integrityIssue: "MERGE_ROLE_MISMATCH",
      mergeCaseId: 55,
    });
  });

  it("projects a historical reversed-role case as resolved only when a valid compensation receipt exists", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase({ sourceUserId: 20, targetUserId: 10 }),
    ] as any);
    vi.spyOn(db, "getCompletedHistoricalMergeCompensationForCase").mockResolvedValue({
      compensationId: 71,
      receiptId: 81,
      historicalMergeCaseId: 55,
      recoveryRequestId: 7,
      donorUserId: 10,
      survivorUserId: 20,
      googleIdentityId: 900,
      expectedSnapshotDigest: "a".repeat(64),
      completedAt: new Date("2026-09-10T00:00:00Z"),
    } as any);
    const statusSpy = vi.spyOn(orchestration, "getAccountMergeExecutionStatus");

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      persistedStatus: "blocked",
      effectiveStatus: "resolved_via_historical_compensation",
      resolutionKind: "historical_merge_compensation",
      integrity: "verified",
      mergeCaseId: 55,
      compensationId: 71,
      compensationReceiptId: 81,
    });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("keeps a historical reversed-role case fail-closed when compensation evidence is missing", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase({ sourceUserId: 20, targetUserId: 10 }),
    ] as any);
    vi.spyOn(db, "getCompletedHistoricalMergeCompensationForCase").mockResolvedValue(undefined);

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      effectiveStatus: "blocked",
      integrity: "inconsistent",
      integrityIssue: "MERGE_ROLE_MISMATCH",
      compensationId: null,
      compensationReceiptId: null,
    });
  });

  it("projects resolved_via_advanced_merge only after completed receipts/audit/identity are re-proven", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      { ...completedCase(), status: "cancelled", id: 54 },
      completedCase(),
    ] as any);
    vi.spyOn(orchestration, "getAccountMergeExecutionStatus").mockResolvedValue(completedStatus() as any);

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toEqual({
      persistedStatus: "blocked",
      effectiveStatus: "resolved_via_advanced_merge",
      resolutionKind: "advanced_account_merge",
      integrity: "verified",
      integrityIssue: null,
      mergeCaseId: 55,
      mergeCaseStatus: "completed",
      completedAt: new Date("2026-09-09T13:48:07Z"),
      auditLogId: 123,
      compensationId: null,
      compensationReceiptId: null,
    });
  });

  it("fails closed instead of claiming resolution when completed evidence is inconsistent", async () => {
    vi.spyOn(db, "listAccountMergeCasesForRecoveryRequest").mockResolvedValue([
      completedCase(),
    ] as any);
    vi.spyOn(orchestration, "getAccountMergeExecutionStatus").mockRejectedValue(
      new orchestration.AccountMergeOrchestrationError(
        "INCONSISTENT_COMPLETION",
        "missing receipt"
      )
    );

    const result = await buildAccountRecoveryLifecycleProjection(request());

    expect(result).toMatchObject({
      persistedStatus: "blocked",
      effectiveStatus: "blocked",
      integrity: "inconsistent",
      integrityIssue: "COMPLETION_EVIDENCE_INCONSISTENT",
      mergeCaseId: 55,
      mergeCaseStatus: "completed",
    });
  });
});
