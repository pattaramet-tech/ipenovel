import type { NqaDecision } from "../contracts";
import {
  NQA_SHADOW_BATCH_VERSION,
  type NqaShadowConfusionMatrix,
  type NqaShadowDecisionCounts,
  type NqaShadowMetrics,
  type NqaShadowRecord,
  type NqaShadowReasonCounts,
} from "./contracts";

function decisionCounts(): NqaShadowDecisionCounts {
  return { PASS: 0, REVIEW: 0, FAIL: 0 };
}

function confusionMatrix(): NqaShadowConfusionMatrix {
  return {
    PASS: decisionCounts(),
    REVIEW: decisionCounts(),
    FAIL: decisionCounts(),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function isFinalLabel(record: NqaShadowRecord): boolean {
  return (
    record.groundTruth !== null &&
    record.groundTruth.status !== "CANDIDATE_PENDING_HUMAN_SIGNOFF"
  );
}

export function calculateNqaShadowMetrics(input: {
  totalCases: number;
  records: readonly NqaShadowRecord[];
}): NqaShadowMetrics {
  const machineDecisionCounts = decisionCounts();
  const matrix = confusionMatrix();
  const reasonCodeCounts: NqaShadowReasonCounts = {};

  let finalLabeledCases = 0;
  let pendingHumanLabelCases = 0;
  let exactMatchCount = 0;
  let falsePassCount = 0;
  let falsePassEligibleCount = 0;
  let falseFailCount = 0;
  let falseFailEligibleCount = 0;
  let reviewCount = 0;
  let reviewOnFinalLabelCount = 0;

  for (const record of input.records) {
    machineDecisionCounts[record.machine.decision] += 1;
    if (record.machine.decision === "REVIEW") reviewCount += 1;

    for (const reason of record.machine.reasonCodes) {
      reasonCodeCounts[reason] = (reasonCodeCounts[reason] ?? 0) + 1;
    }

    if (record.groundTruth?.status === "CANDIDATE_PENDING_HUMAN_SIGNOFF") {
      pendingHumanLabelCases += 1;
    }

    if (!isFinalLabel(record)) continue;

    const truth = record.groundTruth!.decision;
    const machine = record.machine.decision;
    finalLabeledCases += 1;
    matrix[truth][machine] += 1;

    if (truth === machine) exactMatchCount += 1;

    if (truth === "FAIL") {
      falsePassEligibleCount += 1;
      if (machine === "PASS") falsePassCount += 1;
    }

    if (truth === "PASS") {
      falseFailEligibleCount += 1;
      if (machine === "FAIL") falseFailCount += 1;
    }

    if (machine === "REVIEW") reviewOnFinalLabelCount += 1;
  }

  return {
    batchVersion: NQA_SHADOW_BATCH_VERSION,
    totalCases: input.totalCases,
    completedCases: input.records.length,
    pendingCases: Math.max(0, input.totalCases - input.records.length),
    machineDecisionCounts,
    finalLabeledCases,
    pendingHumanLabelCases,
    exactMatchCount,
    exactMatchRate: rate(exactMatchCount, finalLabeledCases),
    falsePassCount,
    falsePassEligibleCount,
    falsePassRate: rate(falsePassCount, falsePassEligibleCount),
    falseFailCount,
    falseFailEligibleCount,
    falseFailRate: rate(falseFailCount, falseFailEligibleCount),
    reviewCount,
    reviewRate: rate(reviewCount, input.records.length),
    reviewOnFinalLabelCount,
    reviewOnFinalLabelRate: rate(reviewOnFinalLabelCount, finalLabeledCases),
    reasonCodeCounts,
    confusionMatrix: matrix,
  };
}

export function mergeDecisionCounts(
  target: NqaShadowDecisionCounts,
  decision: NqaDecision
): void {
  target[decision] += 1;
}
