import type { NqaShadowRecord } from "../shadow/contracts";
import {
  type NqaReviewAction,
  type NqaReviewQueueItem,
  type NqaReviewQueueReason,
} from "./contracts";
import {
  buildNqaReviewSubjectFingerprint,
  deriveNqaReviewState,
} from "./workflow";

function queueReason(input: {
  record: NqaShadowRecord;
  status: ReturnType<typeof deriveNqaReviewState>["status"];
}): { reason: NqaReviewQueueReason; priority: number } | null {
  if (input.status === "DISPUTED") {
    return { reason: "DISPUTED_LABEL", priority: 400 };
  }
  if (input.status === "PROPOSED") {
    return { reason: "PENDING_CONFIRMATION", priority: 300 };
  }
  if (
    input.status === "PENDING" &&
    input.record.machine.decision === "REVIEW"
  ) {
    return { reason: "MACHINE_REVIEW", priority: 200 };
  }
  if (input.status === "PENDING") {
    return { reason: "UNLABELED", priority: 100 };
  }
  return null;
}

export function buildNqaReviewQueue(input: {
  records: readonly NqaShadowRecord[];
  actionsByCaseId?: ReadonlyMap<string, readonly NqaReviewAction[]>;
  limit?: number;
}): NqaReviewQueueItem[] {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Review queue limit must be between 1 and 500.");
  }
  if (input.records.length === 0) return [];

  const runId = input.records[0].runId;
  const batchFingerprint = input.records[0].batchFingerprint;
  const caseIds = new Set<string>();
  const items: NqaReviewQueueItem[] = [];

  for (const record of input.records) {
    if (
      record.runId !== runId ||
      record.batchFingerprint !== batchFingerprint
    ) {
      throw new Error("Review queue records must belong to one M13 batch.");
    }
    if (caseIds.has(record.caseId)) {
      throw new Error("Review queue caseId values must be unique.");
    }
    caseIds.add(record.caseId);

    const actions = input.actionsByCaseId?.get(record.caseId) ?? [];
    const state = deriveNqaReviewState(record, actions);
    const queue = queueReason({ record, status: state.status });
    if (!queue) continue;

    items.push({
      runId: record.runId,
      caseId: record.caseId,
      row: record.row,
      chapter: record.chapter,
      inputFingerprint: record.inputFingerprint,
      subjectFingerprint: buildNqaReviewSubjectFingerprint(record),
      status: state.status,
      queueReason: queue.reason,
      priority: queue.priority,
      machineDecision: record.machine.decision,
      machineReasonCodes: [...record.machine.reasonCodes],
      candidateLabel: state.candidateLabel
        ? structuredClone(state.candidateLabel)
        : null,
      finalGroundTruth: state.finalGroundTruth
        ? structuredClone(state.finalGroundTruth)
        : null,
      actionCount: state.actionCount,
      evidence: record.machine.evidence.slice(0, 12).map(item => ({
        stage: item.stage,
        evidenceId: item.evidenceId,
        sourceHash: item.sourceHash,
        translationHash: item.translationHash,
        boundedSummary: item.boundedSummary,
      })),
    });
  }

  return items
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.row - right.row ||
        left.chapter - right.chapter ||
        left.caseId.localeCompare(right.caseId)
    )
    .slice(0, limit);
}
