import { z } from "zod";

import { hashCanonicalJson } from "../core";

export const NQA_RELEASE_CLOSURE_GATE_VERSION =
  "nqa-release-closure-gate-v1" as const;

const TestRunSchema = z
  .object({
    testFilesPassed: z.number().int().nonnegative(),
    testsPassed: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
  })
  .strict();

export const NqaReleaseClosureEvidenceSchema = z
  .object({
    branchName: z.string().min(1).max(200),
    headCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    boundary: TestRunSchema,
    fullRegression: TestRunSchema,
    typecheckPass: z.boolean(),
    formattingPass: z.boolean(),
    runtimeAdoptionPass: z.boolean(),
    restartRecoveryPass: z.boolean(),
    isolationPass: z.boolean(),
    stagedDiffCheckPass: z.boolean(),
    secretScanPass: z.boolean(),
    debugScanPass: z.boolean(),
    indexClean: z.boolean(),
    onlyAllowedUntrackedArtifacts: z.boolean(),
    activeThresholdPolicyChanged: z.boolean(),
    m17ActivationHistoryChanged: z.boolean(),
    productionMutationDefaultEnabled: z.boolean(),
    pushPerformed: z.boolean(),
    prCreated: z.boolean(),
    mergePerformed: z.boolean(),
  })
  .strict();

export type NqaReleaseClosureEvidence = z.infer<
  typeof NqaReleaseClosureEvidenceSchema
>;

export type NqaReleaseClosureFailureReason =
  | "WRONG_BRANCH"
  | "BOUNDARY_REGRESSION_FAILED"
  | "FULL_REGRESSION_FAILED"
  | "TYPECHECK_FAILED"
  | "FORMATTING_FAILED"
  | "RUNTIME_ADOPTION_NOT_VERIFIED"
  | "RESTART_RECOVERY_NOT_VERIFIED"
  | "ISOLATION_FAILED"
  | "STAGED_DIFF_CHECK_FAILED"
  | "SECRET_SCAN_FAILED"
  | "DEBUG_SCAN_FAILED"
  | "INDEX_NOT_CLEAN"
  | "UNEXPECTED_UNTRACKED_ARTIFACTS"
  | "ACTIVE_THRESHOLD_POLICY_CHANGED"
  | "M17_HISTORY_CHANGED"
  | "PRODUCTION_MUTATION_DEFAULT_ENABLED"
  | "PUSH_ALREADY_PERFORMED"
  | "PR_ALREADY_CREATED"
  | "MERGE_ALREADY_PERFORMED";

export type NqaReleaseClosureGate = {
  gateVersion: typeof NQA_RELEASE_CLOSURE_GATE_VERSION;
  evidence: NqaReleaseClosureEvidence;
  failureReasons: NqaReleaseClosureFailureReason[];
  decision: "HOLD" | "READY_FOR_PUSH_PR_REVIEW";
  artifactFingerprint: string;
};

export function buildNqaReleaseClosureGate(
  rawEvidence: NqaReleaseClosureEvidence
): NqaReleaseClosureGate {
  const evidence = NqaReleaseClosureEvidenceSchema.parse(rawEvidence);
  const failureReasons: NqaReleaseClosureFailureReason[] = [];

  if (evidence.branchName !== "feat/nqa-foundation") {
    failureReasons.push("WRONG_BRANCH");
  }
  if (
    evidence.boundary.failures !== 0 ||
    evidence.boundary.testFilesPassed <= 0 ||
    evidence.boundary.testsPassed <= 0
  ) {
    failureReasons.push("BOUNDARY_REGRESSION_FAILED");
  }
  if (
    evidence.fullRegression.failures !== 0 ||
    evidence.fullRegression.testFilesPassed <= 0 ||
    evidence.fullRegression.testsPassed <= 0
  ) {
    failureReasons.push("FULL_REGRESSION_FAILED");
  }
  if (!evidence.typecheckPass) failureReasons.push("TYPECHECK_FAILED");
  if (!evidence.formattingPass) failureReasons.push("FORMATTING_FAILED");
  if (!evidence.runtimeAdoptionPass) {
    failureReasons.push("RUNTIME_ADOPTION_NOT_VERIFIED");
  }
  if (!evidence.restartRecoveryPass) {
    failureReasons.push("RESTART_RECOVERY_NOT_VERIFIED");
  }
  if (!evidence.isolationPass) failureReasons.push("ISOLATION_FAILED");
  if (!evidence.stagedDiffCheckPass) {
    failureReasons.push("STAGED_DIFF_CHECK_FAILED");
  }
  if (!evidence.secretScanPass) failureReasons.push("SECRET_SCAN_FAILED");
  if (!evidence.debugScanPass) failureReasons.push("DEBUG_SCAN_FAILED");
  if (!evidence.indexClean) failureReasons.push("INDEX_NOT_CLEAN");
  if (!evidence.onlyAllowedUntrackedArtifacts) {
    failureReasons.push("UNEXPECTED_UNTRACKED_ARTIFACTS");
  }
  if (evidence.activeThresholdPolicyChanged) {
    failureReasons.push("ACTIVE_THRESHOLD_POLICY_CHANGED");
  }
  if (evidence.m17ActivationHistoryChanged) {
    failureReasons.push("M17_HISTORY_CHANGED");
  }
  if (evidence.productionMutationDefaultEnabled) {
    failureReasons.push("PRODUCTION_MUTATION_DEFAULT_ENABLED");
  }
  if (evidence.pushPerformed) failureReasons.push("PUSH_ALREADY_PERFORMED");
  if (evidence.prCreated) failureReasons.push("PR_ALREADY_CREATED");
  if (evidence.mergePerformed) failureReasons.push("MERGE_ALREADY_PERFORMED");

  const withoutFingerprint = {
    gateVersion: NQA_RELEASE_CLOSURE_GATE_VERSION,
    evidence,
    failureReasons,
    decision:
      failureReasons.length === 0
        ? ("READY_FOR_PUSH_PR_REVIEW" as const)
        : ("HOLD" as const),
  };

  return {
    ...withoutFingerprint,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:release-closure-gate:v1",
      ...withoutFingerprint,
    }),
  };
}

export function verifyNqaReleaseClosureGate(
  gate: NqaReleaseClosureGate
): NqaReleaseClosureGate {
  const rebuilt = buildNqaReleaseClosureGate(gate.evidence);
  if (
    gate.gateVersion !== rebuilt.gateVersion ||
    gate.decision !== rebuilt.decision ||
    JSON.stringify(gate.failureReasons) !==
      JSON.stringify(rebuilt.failureReasons) ||
    gate.artifactFingerprint !== rebuilt.artifactFingerprint
  ) {
    throw new Error("M21 release closure gate integrity mismatch.");
  }
  return gate;
}
