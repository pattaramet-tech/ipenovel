import { hashCanonicalJson } from "../core";
import type {
  NqaShadowGroundTruth,
  NqaShadowRecord,
} from "../shadow/contracts";
import {
  NQA_REVIEW_ACTION_VERSION,
  NqaReviewActionSchema,
  NqaReviewEvidenceSchema,
  NqaReviewLabelSchema,
  type NqaReviewAction,
  type NqaReviewActionType,
  type NqaReviewEvidence,
  type NqaReviewLabel,
  type NqaReviewState,
} from "./contracts";
import type { NqaReviewJournalStore } from "./store";

function labelsEqual(
  left: NqaReviewLabel | null,
  right: NqaReviewLabel | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    hashCanonicalJson({
      decision: left.decision,
      reasonCodes: [...left.reasonCodes].sort(),
    }) ===
    hashCanonicalJson({
      decision: right.decision,
      reasonCodes: [...right.reasonCodes].sort(),
    })
  );
}

function labelFromGroundTruth(
  value: NqaShadowGroundTruth | null
): NqaReviewLabel | null {
  return value
    ? {
        decision: value.decision,
        reasonCodes: [...value.reasonCodes],
      }
    : null;
}

function humanGroundTruth(input: {
  label: NqaReviewLabel;
  reviewerId: string;
  createdAt: string;
  boundedNote: string | null;
}): NqaShadowGroundTruth {
  return {
    decision: input.label.decision,
    reasonCodes: [...input.label.reasonCodes],
    status: "HUMAN_CONFIRMED",
    labeledBy: input.reviewerId,
    labeledAt: input.createdAt,
    notes: input.boundedNote ? [input.boundedNote] : [],
  };
}

export function buildNqaReviewSubjectFingerprint(
  record: NqaShadowRecord
): string {
  return hashCanonicalJson({
    scope: "nqa:review-subject:v1",
    runId: record.runId,
    batchFingerprint: record.batchFingerprint,
    caseId: record.caseId,
    row: record.row,
    chapter: record.chapter,
    inputFingerprint: record.inputFingerprint,
    baselineGroundTruth: record.groundTruth,
    machine: record.machine,
  });
}

function actionHashPayload(
  action: Omit<NqaReviewAction, "actionHash">
): unknown {
  return {
    scope: "nqa:review-action:v1",
    ...action,
  };
}

function validateEvidence(
  record: NqaShadowRecord,
  evidence: readonly NqaReviewEvidence[]
): void {
  const knownEvidenceIds = new Set(
    record.machine.evidence.map(item => item.evidenceId)
  );

  for (const raw of evidence) {
    const item = NqaReviewEvidenceSchema.parse(raw);
    if (
      item.kind === "M13_EVIDENCE" &&
      !knownEvidenceIds.has(item.evidenceId)
    ) {
      throw new Error(
        "Review action references an evidenceId outside the M13 record."
      );
    }
    if (
      item.kind === "SOURCE_HASH" &&
      (record.machine.sourceHash === null ||
        item.sha256 !== record.machine.sourceHash)
    ) {
      throw new Error(
        "Review action source hash does not match the M13 record."
      );
    }
    if (
      item.kind === "TRANSLATION_HASH" &&
      (record.machine.translationHash === null ||
        item.sha256 !== record.machine.translationHash)
    ) {
      throw new Error(
        "Review action translation hash does not match the M13 record."
      );
    }
  }
}

function recalculateActionHash(action: NqaReviewAction): string {
  const { actionHash: _ignored, ...withoutHash } = action;
  return hashCanonicalJson(actionHashPayload(withoutHash));
}

export function validateNqaReviewJournal(
  record: NqaShadowRecord,
  actions: readonly NqaReviewAction[]
): NqaReviewAction[] {
  const subjectFingerprint = buildNqaReviewSubjectFingerprint(record);
  const sorted = [...actions].sort(
    (left, right) => left.sequence - right.sequence
  );
  let previousHash: string | null = null;
  const actionIds = new Set<string>();

  for (let index = 0; index < sorted.length; index += 1) {
    const action = NqaReviewActionSchema.parse(sorted[index]);
    if (action.sequence !== index + 1) {
      throw new Error("Review journal sequence must be contiguous.");
    }
    if (action.runId !== record.runId || action.caseId !== record.caseId) {
      throw new Error("Review action target does not match the M13 record.");
    }
    if (action.subjectFingerprint !== subjectFingerprint) {
      throw new Error("Review action subject fingerprint is stale.");
    }
    if (action.previousActionHash !== previousHash) {
      throw new Error("Review journal hash chain is invalid.");
    }
    if (action.actionHash !== recalculateActionHash(action)) {
      throw new Error("Review action hash is invalid.");
    }
    if (actionIds.has(action.actionId)) {
      throw new Error("Review journal actionId values must be unique.");
    }
    validateEvidence(record, action.evidence);
    actionIds.add(action.actionId);
    previousHash = action.actionHash;
  }

  return sorted;
}

export function deriveNqaReviewState(
  record: NqaShadowRecord,
  actions: readonly NqaReviewAction[]
): NqaReviewState {
  const validated = validateNqaReviewJournal(record, actions);
  const subjectFingerprint = buildNqaReviewSubjectFingerprint(record);
  let status: NqaReviewState["status"] = "PENDING";
  let candidateLabel: NqaReviewLabel | null = null;
  let finalGroundTruth: NqaShadowGroundTruth | null = null;

  if (record.groundTruth) {
    candidateLabel = labelFromGroundTruth(record.groundTruth);
    if (record.groundTruth.status === "CANDIDATE_PENDING_HUMAN_SIGNOFF") {
      status = "PROPOSED";
    } else {
      status = "CONFIRMED";
      finalGroundTruth = record.groundTruth;
    }
  }

  const reviewers = new Set<string>();
  for (const action of validated) {
    reviewers.add(action.reviewerId);

    if (action.actionType === "PROPOSE") {
      if (status !== "PENDING" && status !== "PROPOSED") {
        throw new Error(
          "PROPOSE is only valid for pending or already-proposed review state."
        );
      }
      candidateLabel = action.label;
      finalGroundTruth = null;
      status = "PROPOSED";
      continue;
    }

    if (action.actionType === "CONFIRM") {
      if (status !== "PROPOSED" || !candidateLabel) {
        throw new Error("CONFIRM requires a proposed label.");
      }
      if (!labelsEqual(candidateLabel, action.label)) {
        throw new Error("CONFIRM label must match the current proposal.");
      }
      finalGroundTruth = humanGroundTruth({
        label: action.label,
        reviewerId: action.reviewerId,
        createdAt: action.createdAt,
        boundedNote: action.boundedNote,
      });
      candidateLabel = action.label;
      status = "CONFIRMED";
      continue;
    }

    if (action.actionType === "DISPUTE") {
      if (
        status !== "PROPOSED" &&
        status !== "CONFIRMED" &&
        status !== "RESOLVED"
      ) {
        throw new Error("DISPUTE requires an existing proposed/final label.");
      }
      candidateLabel = action.label;
      finalGroundTruth = null;
      status = "DISPUTED";
      continue;
    }

    if (action.actionType === "RESOLVE") {
      if (status !== "DISPUTED") {
        throw new Error("RESOLVE requires a disputed label.");
      }
      finalGroundTruth = humanGroundTruth({
        label: action.label,
        reviewerId: action.reviewerId,
        createdAt: action.createdAt,
        boundedNote: action.boundedNote,
      });
      candidateLabel = action.label;
      status = "RESOLVED";
    }
  }

  const last = validated[validated.length - 1] ?? null;
  return {
    runId: record.runId,
    caseId: record.caseId,
    subjectFingerprint,
    status,
    candidateLabel,
    finalGroundTruth,
    actionCount: validated.length,
    lastActionHash: last?.actionHash ?? null,
    lastActionAt: last?.createdAt ?? null,
    reviewers: Array.from(reviewers).sort(),
  };
}

export function createNqaReviewAction(input: {
  record: NqaShadowRecord;
  existingActions: readonly NqaReviewAction[];
  actionId: string;
  actionType: NqaReviewActionType;
  reviewerId: string;
  label: NqaReviewLabel;
  evidence: readonly NqaReviewEvidence[];
  boundedNote?: string | null;
  createdAt: string;
}): NqaReviewAction {
  const existing = validateNqaReviewJournal(
    input.record,
    input.existingActions
  );
  NqaReviewLabelSchema.parse(input.label);
  const evidence = input.evidence.map(item =>
    NqaReviewEvidenceSchema.parse(item)
  );
  validateEvidence(input.record, evidence);

  const previousActionHash = existing[existing.length - 1]?.actionHash ?? null;
  const withoutHash: Omit<NqaReviewAction, "actionHash"> = {
    actionVersion: NQA_REVIEW_ACTION_VERSION,
    actionId: input.actionId,
    runId: input.record.runId,
    caseId: input.record.caseId,
    subjectFingerprint: buildNqaReviewSubjectFingerprint(input.record),
    sequence: existing.length + 1,
    previousActionHash,
    actionType: input.actionType,
    reviewerId: input.reviewerId,
    label: NqaReviewLabelSchema.parse(input.label),
    evidence,
    boundedNote: input.boundedNote ?? null,
    createdAt: input.createdAt,
  };

  const action = NqaReviewActionSchema.parse({
    ...withoutHash,
    actionHash: hashCanonicalJson(actionHashPayload(withoutHash)),
  });

  deriveNqaReviewState(input.record, [...existing, action]);
  return action;
}

export async function appendNqaReviewAction(input: {
  record: NqaShadowRecord;
  store: NqaReviewJournalStore;
  actionId: string;
  actionType: NqaReviewActionType;
  reviewerId: string;
  label: NqaReviewLabel;
  evidence: readonly NqaReviewEvidence[];
  boundedNote?: string | null;
  createdAt: string;
}): Promise<NqaReviewState> {
  const existing = await input.store.listActions(
    input.record.runId,
    input.record.caseId
  );
  const action = createNqaReviewAction({
    record: input.record,
    existingActions: existing,
    actionId: input.actionId,
    actionType: input.actionType,
    reviewerId: input.reviewerId,
    label: input.label,
    evidence: input.evidence,
    boundedNote: input.boundedNote,
    createdAt: input.createdAt,
  });
  await input.store.appendAction(action);
  return deriveNqaReviewState(input.record, [...existing, action]);
}

export function curateNqaShadowRecord(
  record: NqaShadowRecord,
  state: NqaReviewState
): NqaShadowRecord {
  if (
    state.runId !== record.runId ||
    state.caseId !== record.caseId ||
    state.subjectFingerprint !== buildNqaReviewSubjectFingerprint(record)
  ) {
    throw new Error("Review state does not match the M13 record.");
  }

  return {
    ...record,
    tags: [...record.tags],
    machine: structuredClone(record.machine),
    groundTruth: state.finalGroundTruth
      ? structuredClone(state.finalGroundTruth)
      : null,
    updatedAt: record.updatedAt,
  };
}
