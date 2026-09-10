import { createHash } from "node:crypto";
import * as db from "../db";
import { buildCompensatingRecoveryPlan } from "./accountRecoveryCompensationService";
import { buildAccountRecoveryLifecycleProjection } from "./accountRecoveryLifecycleService";

export type AccountRecoveryClosureReadinessInput = {
  duplicateRequestId: number;
  canonicalRequestId: number;
  donorAccountId: number;
  survivorAccountId: number;
  expectedGoogleIdentityId: number;
  expectedMergeCaseId: number;
};

export type AccountRecoveryClosureReadiness = {
  mode: "read_only_closure_verifier";
  executionAuthorized: false;
  decision: "READY_FOR_PREVIEW" | "REFUSE";
  refusalReasons: string[];
  evidence: {
    duplicateStatus: string | null;
    canonicalStatus: string | null;
    sameRequester: boolean;
    duplicateOlderThanCanonical: boolean;
    duplicateSupersedeAuditPresent: boolean;
    duplicateMergeCaseCount: number;
    canonicalLifecycleEffectiveStatus: string | null;
    canonicalLifecycleIntegrity: string | null;
    mergeCaseId: number | null;
    compensationDecision: string | null;
    compensationPlanDigest: string | null;
    compensationPlannedMutationCount: number;
    unresolvedEconomicFindingCount: number;
  };
  readinessDigest: string;
};

function parseSafeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function buildAccountRecoveryClosureReadiness(
  input: AccountRecoveryClosureReadinessInput
): Promise<AccountRecoveryClosureReadiness> {
  const refusalReasons: string[] = [];
  const ids = [
    input.duplicateRequestId,
    input.canonicalRequestId,
    input.donorAccountId,
    input.survivorAccountId,
    input.expectedGoogleIdentityId,
    input.expectedMergeCaseId,
  ];
  if (ids.some(value => !Number.isInteger(value) || value <= 0)) {
    refusalReasons.push("INVALID_INPUT");
  }
  if (input.duplicateRequestId === input.canonicalRequestId) {
    refusalReasons.push("DUPLICATE_EQUALS_CANONICAL");
  }
  if (input.donorAccountId === input.survivorAccountId) {
    refusalReasons.push("DONOR_EQUALS_SURVIVOR");
  }

  const [duplicate, canonical] = await Promise.all([
    db.getAccountRecoveryRequestById(input.duplicateRequestId),
    db.getAccountRecoveryRequestById(input.canonicalRequestId),
  ]);

  if (!duplicate) refusalReasons.push("DUPLICATE_REQUEST_NOT_FOUND");
  if (!canonical) refusalReasons.push("CANONICAL_REQUEST_NOT_FOUND");

  const sameRequester = Boolean(
    duplicate && canonical && Number(duplicate.requesterUserId) === Number(canonical.requesterUserId)
  );
  const duplicateOlderThanCanonical = Boolean(
    duplicate && canonical && new Date(duplicate.createdAt).getTime() < new Date(canonical.createdAt).getTime()
  );

  if (duplicate && String(duplicate.status) !== "cancelled") {
    refusalReasons.push("DUPLICATE_NOT_CANCELLED");
  }
  if (canonical && String(canonical.status) !== "blocked") {
    refusalReasons.push("CANONICAL_NOT_BLOCKED");
  }
  if (!sameRequester) refusalReasons.push("REQUESTER_MISMATCH");
  if (!duplicateOlderThanCanonical) refusalReasons.push("DUPLICATE_NOT_OLDER");
  if (canonical && Number(canonical.requesterUserId) !== input.survivorAccountId) {
    refusalReasons.push("SURVIVOR_ROLE_MISMATCH");
  }

  const [duplicateAudits, duplicateMergeCases] = await Promise.all([
    duplicate ? db.listAccountRecoveryAuditLogsForRequest(input.duplicateRequestId) : Promise.resolve([]),
    duplicate ? db.listAccountMergeCasesForRecoveryRequest(input.duplicateRequestId) : Promise.resolve([]),
  ]);

  const duplicateSupersedeAuditPresent = (duplicateAudits as any[]).some(row => {
    if (String(row.action) !== "cancelled") return false;
    const metadata = parseSafeMetadata(row.safeMetadata);
    return (
      metadata.resolution === "superseded_duplicate" &&
      Number(metadata.supersededByRequestId) === input.canonicalRequestId
    );
  });

  if (!duplicateSupersedeAuditPresent) refusalReasons.push("SUPERSEDE_AUDIT_MISSING");
  if ((duplicateMergeCases as any[]).length !== 0) refusalReasons.push("DUPLICATE_HAS_MERGE_CASE");

  let lifecycle = null as Awaited<ReturnType<typeof buildAccountRecoveryLifecycleProjection>> | null;
  let compensation = null as Awaited<ReturnType<typeof buildCompensatingRecoveryPlan>> | null;

  if (canonical && refusalReasons.length === 0) {
    [lifecycle, compensation] = await Promise.all([
      buildAccountRecoveryLifecycleProjection(canonical as any),
      buildCompensatingRecoveryPlan({
        requestId: input.canonicalRequestId,
        donorAccountId: input.donorAccountId,
        survivorAccountId: input.survivorAccountId,
        expectedRequestStatus: "blocked",
        expectedCurrentIdentityOwnerAccountId: input.survivorAccountId,
        expectedGoogleIdentityId: input.expectedGoogleIdentityId,
        expectedMergeCaseId: input.expectedMergeCaseId,
      }),
    ]);

    if (
      lifecycle.effectiveStatus !== "resolved_via_advanced_merge" ||
      lifecycle.integrity !== "verified" ||
      lifecycle.mergeCaseId !== input.expectedMergeCaseId
    ) {
      refusalReasons.push("LIFECYCLE_NOT_VERIFIED_RESOLVED");
    }
    if (
      compensation.decision !== "NO_REPAIR_REQUIRED" ||
      compensation.plannedMutations.length !== 0 ||
      compensation.refusalReasons.length !== 0 ||
      compensation.evidence.unresolvedEconomicFindings.length !== 0
    ) {
      refusalReasons.push("COMPENSATION_NOT_CLOSED");
    }
  }

  const evidence = {
    duplicateStatus: duplicate ? String(duplicate.status) : null,
    canonicalStatus: canonical ? String(canonical.status) : null,
    sameRequester,
    duplicateOlderThanCanonical,
    duplicateSupersedeAuditPresent,
    duplicateMergeCaseCount: (duplicateMergeCases as any[]).length,
    canonicalLifecycleEffectiveStatus: lifecycle?.effectiveStatus ?? null,
    canonicalLifecycleIntegrity: lifecycle?.integrity ?? null,
    mergeCaseId: lifecycle?.mergeCaseId ?? null,
    compensationDecision: compensation?.decision ?? null,
    compensationPlanDigest: compensation?.planDigest ?? null,
    compensationPlannedMutationCount: compensation?.plannedMutations.length ?? 0,
    unresolvedEconomicFindingCount: compensation?.evidence.unresolvedEconomicFindings.length ?? 0,
  };

  const decision = refusalReasons.length === 0 ? "READY_FOR_PREVIEW" : "REFUSE";
  return {
    mode: "read_only_closure_verifier",
    executionAuthorized: false,
    decision,
    refusalReasons,
    evidence,
    readinessDigest: digest({ input, decision, refusalReasons, evidence }),
  };
}
