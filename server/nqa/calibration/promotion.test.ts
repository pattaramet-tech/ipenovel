import { describe, expect, it } from "vitest";

import { runNqaAlignmentCalibration } from "./evaluator";
import { buildNqaPromotionGate } from "./promotion";
import {
  BASELINE_PROFILE,
  makeCuratedCase,
  makeCurationExport,
} from "./testSupport";

function balancedCases() {
  return [
    makeCuratedCase({
      caseId: "pass-a",
      row: 1,
      truth: "PASS",
      meanRerankScore: 0.85,
      sourceCoverage: 0.95,
      translationCoverage: 0.95,
    }),
    makeCuratedCase({
      caseId: "pass-b",
      row: 2,
      truth: "PASS",
      meanRerankScore: 0.82,
      sourceCoverage: 0.9,
      translationCoverage: 0.9,
    }),
    makeCuratedCase({
      caseId: "fail-a",
      row: 3,
      truth: "FAIL",
      meanRerankScore: 0.3,
      sourceCoverage: 0.4,
      translationCoverage: 0.4,
      sourceGapFraction: 0.6,
      translationGapFraction: 0.6,
    }),
    makeCuratedCase({
      caseId: "fail-b",
      row: 4,
      truth: "FAIL",
      meanRerankScore: 0.35,
      sourceCoverage: 0.45,
      translationCoverage: 0.45,
      sourceGapFraction: 0.55,
      translationGapFraction: 0.55,
    }),
  ];
}

const TEST_CRITERIA = {
  minEligibleCases: 4,
  minPassTruthCases: 2,
  minFailTruthCases: 2,
  requireZeroVersionMismatch: true,
  requireBaselineHistoricalReplayMatch: true,
  maxCandidateFalsePassRate: 0,
  maxCandidatePassAgainstNonPassRate: 0,
  maxFalsePassCountIncrease: 0,
  requireNoNewFalsePassCases: true,
  maxCandidateFalseFailRate: 0,
  maxFalseFailCountIncrease: 0,
  maxCandidateReviewRate: 0,
  minCandidateExactMatchRate: 1,
};

describe("NQA M15 promotion gate", () => {
  it("PROMOTEs a compatible candidate only when every explicit criterion passes", () => {
    const candidate = {
      ...BASELINE_PROFILE,
      profileId: "candidate-safe",
      thresholds: {
        ...BASELINE_PROFILE.thresholds,
        minPassMeanScore: 0.75,
      },
    };
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport(balancedCases()),
      profiles: [BASELINE_PROFILE, candidate],
    });

    const gate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate-safe",
      criteria: TEST_CRITERIA,
    });

    expect(gate.decision).toBe("PROMOTE");
    expect(gate.failureReasons).toEqual([]);
    expect(gate.artifactFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("HOLDs a candidate that introduces a new false PASS", () => {
    const risky = {
      ...BASELINE_PROFILE,
      profileId: "candidate-risky",
      thresholds: {
        ...BASELINE_PROFILE.thresholds,
        minPassMeanScore: 0.45,
        minPassTranslationCoverage: 0.55,
        minPassSourceCoverage: 0.55,
        minReviewMeanScore: 0.4,
        minReviewTranslationCoverage: 0.5,
        minReviewSourceCoverage: 0.5,
      },
    };
    const cases = balancedCases();
    cases[2] = makeCuratedCase({
      caseId: "fail-a",
      row: 3,
      truth: "FAIL",
      meanRerankScore: 0.5,
      sourceCoverage: 0.6,
      translationCoverage: 0.6,
      sourceGapFraction: 0.2,
      translationGapFraction: 0.2,
    });

    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport(cases),
      profiles: [BASELINE_PROFILE, risky],
    });
    const gate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate-risky",
      criteria: TEST_CRITERIA,
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.newlyIntroducedFalsePassCaseIds).toEqual(["fail-a"]);
    expect(gate.failureReasons).toContain("CANDIDATE_FALSE_PASS_RATE_EXCEEDED");
    expect(gate.failureReasons).toContain("FALSE_PASS_COUNT_REGRESSION");
    expect(gate.failureReasons).toContain("NEW_FALSE_PASS_CASE_INTRODUCED");
  });

  it("fails closed when labeled evidence is insufficient", () => {
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([
        makeCuratedCase({
          caseId: "only-pass",
          row: 1,
          truth: "PASS",
        }),
      ]),
      profiles: [
        BASELINE_PROFILE,
        { ...BASELINE_PROFILE, profileId: "candidate" },
      ],
    });

    const gate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      criteria: TEST_CRITERIA,
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("INSUFFICIENT_ELIGIBLE_CASES");
    expect(gate.failureReasons).toContain("INSUFFICIENT_PASS_TRUTH_CASES");
    expect(gate.failureReasons).toContain("INSUFFICIENT_FAIL_TRUTH_CASES");
  });

  it("fails closed when otherwise eligible human evidence has version drift", () => {
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([
        ...balancedCases(),
        makeCuratedCase({
          caseId: "drifted",
          row: 5,
          truth: "FAIL",
          policyVersion: "nqa-alignment-old",
        }),
      ]),
      profiles: [
        BASELINE_PROFILE,
        { ...BASELINE_PROFILE, profileId: "candidate" },
      ],
    });

    const gate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      criteria: TEST_CRITERIA,
    });

    expect(calibration.exclusions.versionMismatch).toBe(1);
    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("VERSION_MISMATCH_CASES_PRESENT");
  });

  it("HOLDs when the declared baseline cannot reproduce historical M10 decisions", () => {
    const wrongBaseline = {
      ...BASELINE_PROFILE,
      profileId: "wrong-baseline",
      thresholds: {
        ...BASELINE_PROFILE.thresholds,
        minPassMeanScore: 0.9,
      },
    };
    const candidate = {
      ...wrongBaseline,
      profileId: "candidate",
    };
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport(balancedCases()),
      profiles: [wrongBaseline, candidate],
    });

    const gate = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "wrong-baseline",
      candidateProfileId: "candidate",
      criteria: TEST_CRITERIA,
    });

    expect(
      calibration.profileReports.find(
        item => item.profile.profileId === "wrong-baseline"
      )?.metrics.historicalAlignmentMatchRate
    ).not.toBe(1);
    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("BASELINE_REPLAY_MISMATCH");
  });

  it("rejects a tampered calibration profile fingerprint", () => {
    const candidate = {
      ...BASELINE_PROFILE,
      profileId: "candidate",
    };
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport(balancedCases()),
      profiles: [BASELINE_PROFILE, candidate],
    });
    const tampered = {
      ...calibration,
      profileReports: calibration.profileReports.map(report =>
        report.profile.profileId === "baseline"
          ? { ...report, profileFingerprint: "0".repeat(64) }
          : report
      ),
    };

    expect(() =>
      buildNqaPromotionGate({
        calibration: tampered,
        baselineProfileId: "baseline",
        candidateProfileId: "candidate",
        criteria: TEST_CRITERIA,
      })
    ).toThrow("Calibration profile fingerprint mismatch.");
  });

  it("is deterministic and records baseline/candidate/dataset provenance", () => {
    const candidate = {
      ...BASELINE_PROFILE,
      profileId: "candidate",
    };
    const calibration = runNqaAlignmentCalibration({
      curationExport: makeCurationExport(balancedCases()),
      profiles: [candidate, BASELINE_PROFILE],
    });

    const first = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      criteria: TEST_CRITERIA,
    });
    const second = buildNqaPromotionGate({
      calibration,
      baselineProfileId: "baseline",
      candidateProfileId: "candidate",
      criteria: TEST_CRITERIA,
    });

    expect(first).toEqual(second);
    expect(first.calibrationDatasetFingerprint).toBe(
      calibration.calibrationDatasetFingerprint
    );
    expect(first.sourceDatasetFingerprint).toBe(
      calibration.sourceDatasetFingerprint
    );
    expect(first.baselineProfile).toEqual(BASELINE_PROFILE);
    expect(first.candidateProfile).toEqual(candidate);
    expect(first.baselineProfileFingerprint).not.toBe("");
    expect(first.candidateProfileFingerprint).not.toBe("");
  });
});
