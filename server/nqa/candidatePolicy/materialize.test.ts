import { describe, expect, it } from "vitest";

import {
  buildNqaPromotionGate,
  runNqaAlignmentCalibration,
} from "../calibration";
import { materializeNqaCandidatePolicy } from "./materialize";
import {
  BASELINE_PROFILE,
  BASE_POLICY,
  SAFE_CANDIDATE_PROFILE,
  STRICT_TEST_CRITERIA,
  buildPromotedFixture,
  makeCuratedCase,
  makeSignedCurationExport,
} from "./testSupport";

describe("NQA M16 candidate policy materialization", () => {
  it("materializes an M15-promoted profile as a new deterministic inactive full policy", () => {
    const { promotionGate } = buildPromotedFixture();
    const first = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const second = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });

    expect(first).toEqual(second);
    expect(first.state).toBe("INACTIVE");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(first.candidatePolicyVersion).not.toBe(BASE_POLICY.version);
    expect(first.policy.version).toBe(first.candidatePolicyVersion);
    expect(first.policy.minPassMeanScore).toBe(0.75);
    expect(first.policy.lowScoreThreshold).toBe(BASE_POLICY.lowScoreThreshold);
    expect(first.policy.targetChunkChars).toBe(BASE_POLICY.targetChunkChars);
    expect(BASE_POLICY.minPassMeanScore).toBe(0.7);
    expect(first.artifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an M15 HOLD artifact", () => {
    const insufficient = makeSignedCurationExport({
      runId: "hold-source",
      cases: [
        makeCuratedCase({
          caseId: "only-pass",
          row: 1,
          truth: "PASS",
        }),
      ],
    });
    const calibration = runNqaAlignmentCalibration({
      curationExport: insufficient,
      profiles: [BASELINE_PROFILE, SAFE_CANDIDATE_PROFILE],
    });
    const holdGate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: BASELINE_PROFILE.profileId,
      candidateProfileId: SAFE_CANDIDATE_PROFILE.profileId,
      criteria: STRICT_TEST_CRITERIA,
    });
    expect(holdGate.decision).toBe("HOLD");

    expect(() =>
      materializeNqaCandidatePolicy({
        promotionGate: holdGate,
        basePolicy: BASE_POLICY,
      })
    ).toThrow("M16 requires an M15 PROMOTE artifact.");
  });

  it("rejects a tampered M15 promotion artifact", () => {
    const { promotionGate } = buildPromotedFixture();
    expect(() =>
      materializeNqaCandidatePolicy({
        promotionGate: {
          ...promotionGate,
          artifactFingerprint: "0".repeat(64),
        },
        basePolicy: BASE_POLICY,
      })
    ).toThrow("M15 promotion artifact fingerprint mismatch.");
  });

  it("rejects a base policy whose version or replayable thresholds do not match M15 baseline", () => {
    const { promotionGate } = buildPromotedFixture();

    expect(() =>
      materializeNqaCandidatePolicy({
        promotionGate,
        basePolicy: { ...BASE_POLICY, version: "nqa-alignment-other" },
      })
    ).toThrow("M16 base policy version does not match M15 provenance.");

    expect(() =>
      materializeNqaCandidatePolicy({
        promotionGate,
        basePolicy: { ...BASE_POLICY, minPassMeanScore: 0.71 },
      })
    ).toThrow(
      "M16 base policy thresholds do not match the M15 baseline profile."
    );
  });

  it("requires a new candidate version when explicitly provided", () => {
    const { promotionGate } = buildPromotedFixture();
    expect(() =>
      materializeNqaCandidatePolicy({
        promotionGate,
        basePolicy: BASE_POLICY,
        candidatePolicyVersion: BASE_POLICY.version,
      })
    ).toThrow("M16 candidate policy version must be new.");
  });
});
