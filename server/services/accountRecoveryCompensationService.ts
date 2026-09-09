import { createHash } from "node:crypto";
import * as db from "../db";
import {
  ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION,
  bindAccountRecoveryRoles,
} from "./accountRecoveryRoles";

export type CompensatingRecoveryExpectedRequestStatus = "approved" | "blocked";

export type CompensatingRecoveryRefusalCode =
  | "INVALID_ROLE_BINDING"
  | "REQUEST_NOT_FOUND"
  | "REQUEST_STATUS_DRIFT"
  | "PERSISTED_ROLE_MISMATCH"
  | "ACCOUNT_NOT_FOUND"
  | "ADMIN_ACCOUNT"
  | "IDENTITY_MISSING"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_OWNER_DRIFT"
  | "IDENTITY_ID_DRIFT"
  | "CONFLICTING_RECOVERY_REQUEST"
  | "MERGE_CASE_DRIFT"
  | "ACTIVE_MERGE_CASE"
  | "CONFLICTING_MERGE_CASE"
  | "PARTIAL_RECONCILIATION_STATE";

export type CompensatingRecoveryPlannedMutation =
  | {
      kind: "reconcile_donor_data_to_survivor";
      donorAccountId: number;
      survivorAccountId: number;
      economicFindingCount: number;
      userOwnedFindingCount: number;
    }
  | {
      kind: "move_google_identity_to_survivor";
      donorAccountId: number;
      survivorAccountId: number;
    }
  | {
      kind: "finalize_survivor_login_projection";
      survivorAccountId: number;
    };

export type CompensatingRecoveryPlan = {
  mode: "dry_run_only";
  executionAuthorized: false;
  roleSemanticsVersion: typeof ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION;
  requestId: number;
  donorAccountId: number;
  survivorAccountId: number;
  decision: "READY_FOR_SEPARATE_AUTHORIZATION" | "REFUSE";
  refusalReasons: Array<{ code: CompensatingRecoveryRefusalCode; message: string }>;
  evidence: {
    requestStatus: string | null;
    requesterUserId: number | null;
    currentIdentityOwnerAccountId: number | null;
    expectedCurrentIdentityOwnerAccountId: number;
    currentGoogleIdentityId: number | null;
    expectedGoogleIdentityId: number;
    conflictingRecoveryRequestIds: number[];
    mergeCaseId: number | null;
    mergeCaseStatus: string | null;
    financialReceiptPresent: boolean;
    dataReceiptPresent: boolean;
    completionAuditPresent: boolean;
    economicFindings: Array<{ table: string; count: number }>;
    userOwnedFindings: Array<{ table: string; count: number }>;
  };
  plannedMutations: CompensatingRecoveryPlannedMutation[];
  planDigest: string;
};

function digestPlan(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Read-only compensating-recovery planner.
 *
 * This function deliberately has no transaction, INSERT, UPDATE, DELETE,
 * identity-transfer, reconciliation, or user-finalization call. It only
 * compares an operator-supplied expected state against fresh database reads
 * and returns the mutations a separately-authorized future tool would need.
 * Every output keeps executionAuthorized=false by construction.
 */
export async function buildCompensatingRecoveryPlan(input: {
  requestId: number;
  donorAccountId: number;
  survivorAccountId: number;
  expectedRequestStatus: CompensatingRecoveryExpectedRequestStatus;
  expectedCurrentIdentityOwnerAccountId: number;
  expectedGoogleIdentityId: number;
  expectedMergeCaseId: number | null;
}): Promise<CompensatingRecoveryPlan> {
  const refusalReasons: CompensatingRecoveryPlan["refusalReasons"] = [];
  const addRefusal = (code: CompensatingRecoveryRefusalCode, message: string) => {
    if (!refusalReasons.some(item => item.code === code && item.message === message)) {
      refusalReasons.push({ code, message });
    }
  };

  if (!Number.isInteger(input.requestId) || input.requestId <= 0) {
    addRefusal("REQUEST_NOT_FOUND", "A valid recovery request id is required");
  }
  if (
    !Number.isInteger(input.expectedCurrentIdentityOwnerAccountId) ||
    input.expectedCurrentIdentityOwnerAccountId <= 0 ||
    ![input.donorAccountId, input.survivorAccountId].includes(
      input.expectedCurrentIdentityOwnerAccountId
    )
  ) {
    addRefusal(
      "IDENTITY_OWNER_DRIFT",
      "Expected identity owner must be exactly the explicit Donor or Survivor account"
    );
  }
  if (!Number.isInteger(input.expectedGoogleIdentityId) || input.expectedGoogleIdentityId <= 0) {
    addRefusal("IDENTITY_ID_DRIFT", "A valid expected Google identity id is required");
  }
  if (
    input.expectedMergeCaseId !== null &&
    (!Number.isInteger(input.expectedMergeCaseId) || input.expectedMergeCaseId <= 0)
  ) {
    addRefusal("MERGE_CASE_DRIFT", "Expected merge case id is invalid");
  }

  const request =
    Number.isInteger(input.requestId) && input.requestId > 0
      ? await db.getAccountRecoveryRequestById(input.requestId)
      : undefined;
  if (!request) {
    addRefusal("REQUEST_NOT_FOUND", "Recovery request does not exist");
  }

  const requesterUserId = request ? Number(request.requesterUserId) : null;
  if (request) {
    const roleBinding = bindAccountRecoveryRoles({
      requesterUserId: Number(request.requesterUserId),
      donorAccountId: input.donorAccountId,
      survivorAccountId: input.survivorAccountId,
    });
    if (!roleBinding.valid) {
      addRefusal(
        "INVALID_ROLE_BINDING",
        roleBinding.failure === "DONOR_REQUESTER_MISMATCH"
          ? "Donor does not match the persisted recovery requester"
          : "Donor/Survivor role binding is invalid"
      );
    }
    if (request.status !== input.expectedRequestStatus) {
      addRefusal(
        "REQUEST_STATUS_DRIFT",
        `Recovery request status is ${request.status}, expected ${input.expectedRequestStatus}`
      );
    }
    if (
      request.status === "approved" &&
      (Number(request.sourceUserId) !== input.donorAccountId ||
        Number(request.targetUserId) !== input.survivorAccountId)
    ) {
      addRefusal(
        "PERSISTED_ROLE_MISMATCH",
        "Persisted approved recovery participants do not match the explicit Donor/Survivor pair"
      );
    }
  }

  const validParticipantIds =
    Number.isInteger(input.donorAccountId) &&
    input.donorAccountId > 0 &&
    Number.isInteger(input.survivorAccountId) &&
    input.survivorAccountId > 0 &&
    input.donorAccountId !== input.survivorAccountId;

  const [
    donor,
    survivor,
    donorIdentity,
    survivorIdentity,
    participantCases,
    participantRecoveryRequests,
  ] = validParticipantIds
    ? await Promise.all([
        db.getUserById(input.donorAccountId),
        db.getUserById(input.survivorAccountId),
        db.getAuthIdentityByUserAndProvider(input.donorAccountId, "google"),
        db.getAuthIdentityByUserAndProvider(input.survivorAccountId, "google"),
        db.listAccountMergeCasesForParticipants([
          input.donorAccountId,
          input.survivorAccountId,
        ]),
        db.listAccountRecoveryRequestsForParticipants([
          input.donorAccountId,
          input.survivorAccountId,
        ]),
      ])
    : [undefined, undefined, undefined, undefined, [] as any[], [] as any[]];

  if (!validParticipantIds) {
    addRefusal("INVALID_ROLE_BINDING", "Donor and Survivor must be distinct positive account ids");
  }
  if (!donor || !survivor) {
    addRefusal("ACCOUNT_NOT_FOUND", "Donor and Survivor accounts must both exist");
  }
  if (donor?.role === "admin" || survivor?.role === "admin") {
    addRefusal("ADMIN_ACCOUNT", "Admin accounts cannot participate in recovery or merge repair");
  }

  const identityOwners = [
    donorIdentity ? input.donorAccountId : null,
    survivorIdentity ? input.survivorAccountId : null,
  ].filter((value): value is number => value !== null);
  const currentIdentityOwnerAccountId =
    identityOwners.length === 1 ? identityOwners[0] : null;
  const currentIdentity =
    identityOwners.length === 1
      ? currentIdentityOwnerAccountId === input.donorAccountId
        ? donorIdentity
        : survivorIdentity
      : undefined;
  const currentGoogleIdentityId = currentIdentity ? Number(currentIdentity.id) : null;
  if (identityOwners.length === 0) {
    addRefusal("IDENTITY_MISSING", "Neither explicit account currently owns a Google identity");
  } else if (identityOwners.length > 1) {
    addRefusal("IDENTITY_AMBIGUOUS", "Both explicit accounts currently own Google identities");
  } else {
    if (currentIdentityOwnerAccountId !== input.expectedCurrentIdentityOwnerAccountId) {
      addRefusal(
        "IDENTITY_OWNER_DRIFT",
        `Google identity owner is account ${currentIdentityOwnerAccountId}, expected ${input.expectedCurrentIdentityOwnerAccountId}`
      );
    }
    if (currentGoogleIdentityId !== input.expectedGoogleIdentityId) {
      addRefusal(
        "IDENTITY_ID_DRIFT",
        `Google identity id is ${currentGoogleIdentityId}, expected ${input.expectedGoogleIdentityId}`
      );
    }
  }

  const conflictingRecoveryRequestIds = (participantRecoveryRequests as any[])
    .filter(row => {
      if (Number(row.id) === input.requestId) return false;
      return ["pending", "blocked", "approved"].includes(String(row.status));
    })
    .map(row => Number(row.id))
    .sort((a, b) => a - b);
  if (conflictingRecoveryRequestIds.length > 0) {
    addRefusal(
      "CONFLICTING_RECOVERY_REQUEST",
      `Other unresolved or previously-approved recovery request(s) involve these participants: ${conflictingRecoveryRequestIds.join(",")}`
    );
  }

  const cases = (participantCases as any[]).map(row => ({
    id: Number(row.id),
    sourceUserId: Number(row.sourceUserId),
    targetUserId: Number(row.targetUserId),
    status: String(row.status),
    originAccountRecoveryRequestId: Number(row.originAccountRecoveryRequestId),
  }));
  const expectedCase =
    input.expectedMergeCaseId === null
      ? null
      : cases.find(row => row.id === input.expectedMergeCaseId) ?? null;
  const currentRequestCases = cases.filter(
    row => row.originAccountRecoveryRequestId === input.requestId
  );

  if (input.expectedMergeCaseId === null && currentRequestCases.length > 0) {
    addRefusal(
      "MERGE_CASE_DRIFT",
      "A merge case now exists for this request although the expected snapshot had none"
    );
  } else if (input.expectedMergeCaseId !== null && !expectedCase) {
    addRefusal("MERGE_CASE_DRIFT", "Expected merge case no longer matches current database state");
  }
  if (
    expectedCase &&
    (expectedCase.sourceUserId !== input.donorAccountId ||
      expectedCase.targetUserId !== input.survivorAccountId ||
      expectedCase.originAccountRecoveryRequestId !== input.requestId)
  ) {
    addRefusal(
      "PERSISTED_ROLE_MISMATCH",
      "Persisted merge case participants do not match the explicit Donor/Survivor pair"
    );
  }

  for (const mergeCase of cases) {
    if (mergeCase.status === "cancelled") continue;
    const exactPair =
      mergeCase.sourceUserId === input.donorAccountId &&
      mergeCase.targetUserId === input.survivorAccountId &&
      mergeCase.originAccountRecoveryRequestId === input.requestId;
    if (!exactPair) {
      addRefusal(
        "CONFLICTING_MERGE_CASE",
        `Account Merge case ${mergeCase.id} conflicts with the explicit recovery participants`
      );
      continue;
    }
    if (["pending", "in_progress", "failed"].includes(mergeCase.status)) {
      addRefusal(
        "ACTIVE_MERGE_CASE",
        `Account Merge case ${mergeCase.id} is ${mergeCase.status}; repair planning refuses concurrent or unresolved merge work`
      );
    }
  }

  let financialReceiptPresent = false;
  let dataReceiptPresent = false;
  let completionAuditPresent = false;
  if (expectedCase) {
    const knownStatuses = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);
    if (!knownStatuses.has(expectedCase.status)) {
      addRefusal(
        "MERGE_CASE_DRIFT",
        `Account Merge case ${expectedCase.id} has unrecognized status ${expectedCase.status}`
      );
    }
    const receiptEvidence = await db.getAccountMergeCompensationCaseEvidence(expectedCase.id);
    financialReceiptPresent = receiptEvidence.financialReceiptPresent;
    dataReceiptPresent = receiptEvidence.dataReceiptPresent;
    completionAuditPresent = receiptEvidence.completionAuditPresent;
    const hasAnyCompletionEvidence =
      financialReceiptPresent || dataReceiptPresent || completionAuditPresent;
    const hasCompleteCompletionEvidence =
      financialReceiptPresent && dataReceiptPresent && completionAuditPresent;
    if (
      (expectedCase.status === "completed" && !hasCompleteCompletionEvidence) ||
      (expectedCase.status !== "completed" && hasAnyCompletionEvidence)
    ) {
      addRefusal(
        "PARTIAL_RECONCILIATION_STATE",
        `Account Merge case ${expectedCase.id} status/receipt evidence is inconsistent; compensating planning refuses partial or unrecognized persisted state`
      );
    }
  }

  let economicFindings: Array<{ table: string; count: number }> = [];
  let userOwnedFindings: Array<{ table: string; count: number }> = [];
  if (validParticipantIds && donor && survivor) {
    [economicFindings, userOwnedFindings] = await Promise.all([
      db.findAccountRecoveryEconomicData(input.donorAccountId),
      db.findAccountRecoveryUserOwnedData(input.donorAccountId, input.requestId),
    ]);
    economicFindings = [...economicFindings].sort((a, b) => a.table.localeCompare(b.table));
    userOwnedFindings = [...userOwnedFindings].sort((a, b) => a.table.localeCompare(b.table));
  }

  const plannedMutations: CompensatingRecoveryPlannedMutation[] = [];
  if (refusalReasons.length === 0) {
    if (economicFindings.length > 0 || userOwnedFindings.length > 0) {
      plannedMutations.push({
        kind: "reconcile_donor_data_to_survivor",
        donorAccountId: input.donorAccountId,
        survivorAccountId: input.survivorAccountId,
        economicFindingCount: economicFindings.reduce((sum, row) => sum + row.count, 0),
        userOwnedFindingCount: userOwnedFindings.reduce((sum, row) => sum + row.count, 0),
      });
    }
    if (currentIdentityOwnerAccountId === input.donorAccountId) {
      plannedMutations.push({
        kind: "move_google_identity_to_survivor",
        donorAccountId: input.donorAccountId,
        survivorAccountId: input.survivorAccountId,
      });
      plannedMutations.push({
        kind: "finalize_survivor_login_projection",
        survivorAccountId: input.survivorAccountId,
      });
    }
  }

  const evidence = {
    requestStatus: request?.status ?? null,
    requesterUserId,
    currentIdentityOwnerAccountId,
    expectedCurrentIdentityOwnerAccountId:
      input.expectedCurrentIdentityOwnerAccountId,
    currentGoogleIdentityId,
    expectedGoogleIdentityId: input.expectedGoogleIdentityId,
    conflictingRecoveryRequestIds,
    mergeCaseId: expectedCase?.id ?? null,
    mergeCaseStatus: expectedCase?.status ?? null,
    financialReceiptPresent,
    dataReceiptPresent,
    completionAuditPresent,
    economicFindings,
    userOwnedFindings,
  };
  const decision =
    refusalReasons.length === 0
      ? "READY_FOR_SEPARATE_AUTHORIZATION"
      : "REFUSE";
  const digestPayload = {
    roleSemanticsVersion: ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION,
    requestId: input.requestId,
    donorAccountId: input.donorAccountId,
    survivorAccountId: input.survivorAccountId,
    expectedRequestStatus: input.expectedRequestStatus,
    expectedMergeCaseId: input.expectedMergeCaseId,
    evidence,
    decision,
    refusalReasons,
    plannedMutations,
  };

  return {
    mode: "dry_run_only",
    executionAuthorized: false,
    roleSemanticsVersion: ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION,
    requestId: input.requestId,
    donorAccountId: input.donorAccountId,
    survivorAccountId: input.survivorAccountId,
    decision,
    refusalReasons,
    evidence,
    plannedMutations,
    planDigest: digestPlan(digestPayload),
  };
}
