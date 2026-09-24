import { describe, expect, it } from "vitest";

import { runNqaAlignmentCalibration } from "./evaluator";
import {
  BASELINE_PROFILE,
  TEST_POLICY_VERSION,
  TEST_RERANKER_VERSION,
  makeCuratedCase,
  makeCurationExport,
} from "./testSupport";

describe("NQA M15 alignment calibration evaluator", () => {
  it("uses only settled HUMAN_CONFIRMED cases with replayable matching M10 provenance", () => {
    const exportData = makeCurationExport([
      makeCuratedCase({
        caseId: "eligible-pass",
        row: 1,
        truth: "PASS",
      }),
      makeCuratedCase({
        caseId: "unresolved",
        row: 2,
        truth: null,
        reviewStatus: "DISPUTED",
      }),
      makeCuratedCase({
        caseId: "canonical-not-human",
        row: 3,
        truth: "FAIL",
        truthStatus: "CANONICAL_INCIDENT",
      }),
      makeCuratedCase({
        caseId: "missing-alignment",
        row: 4,
        truth: "PASS",
        meanRerankScore: null,
      }),
      makeCuratedCase({
        caseId: "version-mismatch",
        row: 5,
        truth: "FAIL",
        policyVersion: "nqa-alignment-other",
      }),
    ]);

    const result = runNqaAlignmentCalibration({
      curationExport: exportData,
      profiles: [BASELINE_PROFILE],
    });

    expect(result.requiredSourcePolicyVersion).toBe(TEST_POLICY_VERSION);
    expect(result.requiredRerankerVersion).toBe(TEST_RERANKER_VERSION);
    expect(result.humanConfirmedCaseCount).toBe(3);
    expect(result.eligibleCaseIds).toEqual(["eligible-pass"]);
    expect(result.exclusions).toEqual({
      unresolvedOrUnsettled: 1,
      nonHumanConfirmed: 1,
      missingAlignmentEvidence: 1,
      versionMismatch: 1,
    });
  });

  it("replays M10 PASS, REVIEW, and FAIL decisions from bounded scores", () => {
    const result = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([
        makeCuratedCase({
          caseId: "pass",
          row: 1,
          truth: "PASS",
          meanRerankScore: 0.82,
          sourceCoverage: 0.9,
          translationCoverage: 0.92,
          lowScoreFraction: 0.1,
        }),
        makeCuratedCase({
          caseId: "review",
          row: 2,
          truth: "REVIEW",
          meanRerankScore: 0.6,
          sourceCoverage: 0.75,
          translationCoverage: 0.8,
          lowScoreFraction: 0.35,
          sourceGapFraction: 0.25,
          translationGapFraction: 0.2,
        }),
        makeCuratedCase({
          caseId: "fail",
          row: 3,
          truth: "FAIL",
          meanRerankScore: 0.3,
          sourceCoverage: 0.5,
          translationCoverage: 0.5,
          sourceGapFraction: 0.5,
          translationGapFraction: 0.5,
        }),
      ]),
      profiles: [BASELINE_PROFILE],
    });

    const report = result.profileReports[0];
    expect(report.cases.map(item => item.replayDecision)).toEqual([
      "PASS",
      "REVIEW",
      "FAIL",
    ]);
    expect(report.metrics.exactMatchRate).toBe(1);
    expect(report.metrics.historicalAlignmentMatchRate).toBe(1);
    expect(report.metrics.falsePassRate).toBe(0);
    expect(report.metrics.falseFailRate).toBe(0);
    expect(report.metrics.reviewRate).toBeCloseTo(1 / 3);
  });

  it("computes false PASS, false FAIL, non-PASS pass-through, and review metrics", () => {
    const permissive = {
      ...BASELINE_PROFILE,
      profileId: "permissive",
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

    const result = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([
        makeCuratedCase({
          caseId: "truth-fail",
          row: 1,
          truth: "FAIL",
          meanRerankScore: 0.6,
          sourceCoverage: 0.7,
          translationCoverage: 0.7,
          sourceGapFraction: 0.2,
          translationGapFraction: 0.2,
        }),
        makeCuratedCase({
          caseId: "truth-pass-low",
          row: 2,
          truth: "PASS",
          meanRerankScore: 0.3,
          sourceCoverage: 0.5,
          translationCoverage: 0.5,
          sourceGapFraction: 0.5,
          translationGapFraction: 0.5,
        }),
        makeCuratedCase({
          caseId: "truth-review",
          row: 3,
          truth: "REVIEW",
          meanRerankScore: 0.6,
          sourceCoverage: 0.7,
          translationCoverage: 0.7,
          sourceGapFraction: 0.2,
          translationGapFraction: 0.2,
        }),
      ]),
      profiles: [permissive],
    });

    const metrics = result.profileReports[0].metrics;
    expect(metrics.falsePassCount).toBe(1);
    expect(metrics.falsePassRate).toBe(1);
    expect(metrics.falseFailCount).toBe(1);
    expect(metrics.falseFailRate).toBe(1);
    expect(metrics.passAgainstNonPassCount).toBe(2);
    expect(metrics.passAgainstNonPassRate).toBe(1);
  });

  it("is deterministic across curation case and profile input ordering", () => {
    const a = makeCuratedCase({
      caseId: "case-a",
      row: 2,
      truth: "PASS",
    });
    const b = makeCuratedCase({
      caseId: "case-b",
      row: 1,
      truth: "FAIL",
      meanRerankScore: 0.3,
      sourceCoverage: 0.4,
      translationCoverage: 0.4,
      sourceGapFraction: 0.6,
      translationGapFraction: 0.6,
    });
    const stricter = {
      ...BASELINE_PROFILE,
      profileId: "stricter",
      thresholds: {
        ...BASELINE_PROFILE.thresholds,
        minPassMeanScore: 0.75,
      },
    };

    const first = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([a, b]),
      profiles: [stricter, BASELINE_PROFILE],
    });
    const second = runNqaAlignmentCalibration({
      curationExport: makeCurationExport([b, a]),
      profiles: [BASELINE_PROFILE, stricter],
    });

    expect(first).toEqual(second);
    expect(first.profileReports.map(item => item.profile.profileId)).toEqual([
      "baseline",
      "stricter",
    ]);
    expect(first.eligibleCaseIds).toEqual(["case-b", "case-a"]);
  });

  it("rejects mixed profile provenance and invalid threshold ordering", () => {
    expect(() =>
      runNqaAlignmentCalibration({
        curationExport: makeCurationExport([
          makeCuratedCase({ caseId: "case-a", row: 1 }),
        ]),
        profiles: [
          BASELINE_PROFILE,
          {
            ...BASELINE_PROFILE,
            profileId: "other-model",
            rerankerVersion: "local@other",
          },
        ],
      })
    ).toThrow(
      "All calibration profiles must share one M10 policy/reranker provenance."
    );

    expect(() =>
      runNqaAlignmentCalibration({
        curationExport: makeCurationExport([
          makeCuratedCase({ caseId: "case-a", row: 1 }),
        ]),
        profiles: [
          {
            ...BASELINE_PROFILE,
            thresholds: {
              ...BASELINE_PROFILE.thresholds,
              minPassMeanScore: 0.4,
              minReviewMeanScore: 0.5,
            },
          },
        ],
      })
    ).toThrow("minReviewMeanScore must not exceed minPassMeanScore.");
  });
});
