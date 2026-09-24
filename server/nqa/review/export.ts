import { hashCanonicalJson } from "../core";
import type { NqaShadowRecord } from "../shadow/contracts";
import {
  NQA_CURATION_EXPORT_VERSION,
  NqaCurationExportSchema,
  type NqaCurationExport,
  type NqaCuratedCase,
  type NqaReviewAction,
} from "./contracts";
import {
  buildNqaReviewSubjectFingerprint,
  deriveNqaReviewState,
  validateNqaReviewJournal,
} from "./workflow";

export function buildNqaCurationExport(input: {
  records: readonly NqaShadowRecord[];
  actionsByCaseId?: ReadonlyMap<string, readonly NqaReviewAction[]>;
}): NqaCurationExport {
  if (input.records.length === 0) {
    throw new Error("Curation export requires at least one M13 record.");
  }

  const runId = input.records[0].runId;
  const batchFingerprint = input.records[0].batchFingerprint;
  const caseIds = new Set<string>();
  const cases: NqaCuratedCase[] = [];

  for (const record of input.records) {
    if (
      record.runId !== runId ||
      record.batchFingerprint !== batchFingerprint
    ) {
      throw new Error("Curation export records must belong to one M13 batch.");
    }
    if (caseIds.has(record.caseId)) {
      throw new Error("Curation export caseId values must be unique.");
    }
    caseIds.add(record.caseId);

    const actions = validateNqaReviewJournal(
      record,
      input.actionsByCaseId?.get(record.caseId) ?? []
    );
    const state = deriveNqaReviewState(record, actions);

    cases.push({
      caseId: record.caseId,
      row: record.row,
      chapter: record.chapter,
      inputFingerprint: record.inputFingerprint,
      subjectFingerprint: buildNqaReviewSubjectFingerprint(record),
      baselineGroundTruth: record.groundTruth
        ? structuredClone(record.groundTruth)
        : null,
      machineSnapshot: structuredClone(record.machine),
      reviewStatus: state.status,
      candidateLabel: state.candidateLabel
        ? structuredClone(state.candidateLabel)
        : null,
      finalGroundTruth: state.finalGroundTruth
        ? structuredClone(state.finalGroundTruth)
        : null,
      actionTrail: actions.map(action => ({
        sequence: action.sequence,
        actionHash: action.actionHash,
        previousActionHash: action.previousActionHash,
        actionType: action.actionType,
        reviewerId: action.reviewerId,
        label: structuredClone(action.label),
        evidence: structuredClone(action.evidence),
        boundedNote: action.boundedNote,
        createdAt: action.createdAt,
      })),
    });
  }

  cases.sort(
    (left, right) =>
      left.row - right.row ||
      left.chapter - right.chapter ||
      left.caseId.localeCompare(right.caseId)
  );

  const finalLabelCount = cases.filter(
    item => item.finalGroundTruth !== null
  ).length;
  const unresolvedCount = cases.length - finalLabelCount;
  const payload = {
    exportVersion: NQA_CURATION_EXPORT_VERSION,
    runId,
    batchFingerprint,
    caseCount: cases.length,
    finalLabelCount,
    unresolvedCount,
    cases,
  };

  return NqaCurationExportSchema.parse({
    ...payload,
    datasetFingerprint: hashCanonicalJson({
      scope: "nqa:curation-export:v1",
      ...payload,
    }),
  });
}
