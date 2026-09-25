import { describe, expect, it } from "vitest";

import {
  buildNqaReleaseClosureGate,
  verifyNqaReleaseClosureGate,
  type NqaReleaseClosureEvidence,
} from "./releaseGate";

function passingEvidence(
  override: Partial<NqaReleaseClosureEvidence> = {}
): NqaReleaseClosureEvidence {
  return {
    branchName: "feat/nqa-foundation",
    headCommitSha: "a".repeat(40),
    boundary: {
      testFilesPassed: 20,
      testsPassed: 100,
      failures: 0,
    },
    fullRegression: {
      testFilesPassed: 80,
      testsPassed: 400,
      failures: 0,
    },
    typecheckPass: true,
    formattingPass: true,
    runtimeAdoptionPass: true,
    restartRecoveryPass: true,
    isolationPass: true,
    stagedDiffCheckPass: true,
    secretScanPass: true,
    debugScanPass: true,
    indexClean: true,
    onlyAllowedUntrackedArtifacts: true,
    activeThresholdPolicyChanged: false,
    m17ActivationHistoryChanged: false,
    productionMutationDefaultEnabled: false,
    pushPerformed: false,
    prCreated: false,
    mergePerformed: false,
    ...override,
  };
}

describe("NQA M21 release/closure gate", () => {
  it("becomes ready for push/PR review only after all closure evidence passes", () => {
    const gate = buildNqaReleaseClosureGate(passingEvidence());

    expect(gate).toMatchObject({
      decision: "READY_FOR_PUSH_PR_REVIEW",
      failureReasons: [],
    });
    expect(gate.artifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a tampered closure artifact", () => {
    const gate = buildNqaReleaseClosureGate(passingEvidence());
    expect(() =>
      verifyNqaReleaseClosureGate({
        ...gate,
        decision: "HOLD",
      })
    ).toThrow("release closure gate integrity mismatch");
  });

  it("holds if runtime restart/recovery was not verified", () => {
    const gate = buildNqaReleaseClosureGate(
      passingEvidence({ restartRecoveryPass: false })
    );

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("RESTART_RECOVERY_NOT_VERIFIED");
  });

  it("holds if push, PR or merge happened before closure review", () => {
    const gate = buildNqaReleaseClosureGate(
      passingEvidence({
        pushPerformed: true,
        prCreated: true,
        mergePerformed: true,
      })
    );

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toEqual(
      expect.arrayContaining([
        "PUSH_ALREADY_PERFORMED",
        "PR_ALREADY_CREATED",
        "MERGE_ALREADY_PERFORMED",
      ])
    );
  });

  it("holds on repository, policy-safety or regression failures", () => {
    const gate = buildNqaReleaseClosureGate(
      passingEvidence({
        branchName: "main",
        fullRegression: {
          testFilesPassed: 80,
          testsPassed: 399,
          failures: 1,
        },
        indexClean: false,
        onlyAllowedUntrackedArtifacts: false,
        activeThresholdPolicyChanged: true,
        m17ActivationHistoryChanged: true,
        productionMutationDefaultEnabled: true,
      })
    );

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toEqual(
      expect.arrayContaining([
        "WRONG_BRANCH",
        "FULL_REGRESSION_FAILED",
        "INDEX_NOT_CLEAN",
        "UNEXPECTED_UNTRACKED_ARTIFACTS",
        "ACTIVE_THRESHOLD_POLICY_CHANGED",
        "M17_HISTORY_CHANGED",
        "PRODUCTION_MUTATION_DEFAULT_ENABLED",
      ])
    );
  });
});
