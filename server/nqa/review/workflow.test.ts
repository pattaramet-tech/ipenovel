import { describe, expect, it } from "vitest";

import type { NqaShadowRecord } from "../shadow/contracts";
import type { NqaReviewAction, NqaReviewLabel } from "./contracts";
import { InMemoryNqaReviewJournalStore } from "./store";
import {
  appendNqaReviewAction,
  buildNqaReviewSubjectFingerprint,
  createNqaReviewAction,
  curateNqaShadowRecord,
  deriveNqaReviewState,
  validateNqaReviewJournal,
} from "./workflow";

const SOURCE_HASH = "a".repeat(64);
const TRANSLATION_HASH = "b".repeat(64);

function record(
  input: {
    caseId?: string;
    machineDecision?: "PASS" | "REVIEW" | "FAIL";
    groundTruth?: NqaShadowRecord["groundTruth"];
  } = {}
): NqaShadowRecord {
  const decision = input.machineDecision ?? "REVIEW";
  return {
    recordVersion: "nqa-shadow-record-v1",
    runId: "run-001",
    batchFingerprint: "f".repeat(64),
    caseId: input.caseId ?? "case-001",
    row: 1701,
    chapter: 197,
    inputFingerprint: "c".repeat(64),
    tags: ["real-world"],
    groundTruth: input.groundTruth ?? null,
    machine: {
      decision,
      reasonCodes: decision === "REVIEW" ? ["ALIGNMENT_UNCERTAIN"] : [],
      stageDecisions: {
        deterministic: "PASS",
        globalSearch: "PASS",
        alignment: decision,
        adjudication: null,
        structure: null,
      },
      scores: {
        expectedRank: 1,
        expectedSimilarity: 0.82,
        expectedLeadOverAlternate: 0.08,
        sourceCoverage: 0.92,
        translationCoverage: 0.94,
        meanRerankScore: 0.71,
        minRerankScore: 0.4,
        lowScoreFraction: 0.1,
        sourceGapFraction: 0.08,
        translationGapFraction: 0.06,
        structuredStrongMismatchCount: null,
        structuredStrongMatchCount: null,
      },
      sourceHash: SOURCE_HASH,
      translationHash: TRANSLATION_HASH,
      providerVersions: {
        embedding: "local@bge-m3",
        reranker: "local@bge-reranker-v2-m3",
        adjudication: null,
        structure: null,
      },
      policyVersions: {
        deterministic: "nqa-deterministic-v1",
        semantic: "nqa-semantic-global-v1",
        alignment: "nqa-alignment-v1",
        adjudication: null,
        structure: null,
      },
      evidence: [
        {
          stage: "M10_ALIGNMENT",
          evidenceId: "alignment-1",
          sourceHash: SOURCE_HASH,
          translationHash: TRANSLATION_HASH,
          boundedSummary: "bounded alignment evidence",
        },
      ],
    },
    evaluatedAt: "2026-09-24T20:00:00+07:00",
    updatedAt: "2026-09-24T20:00:00+07:00",
  };
}

const PASS_LABEL: NqaReviewLabel = {
  decision: "PASS",
  reasonCodes: [],
};

const FAIL_LABEL: NqaReviewLabel = {
  decision: "FAIL",
  reasonCodes: ["MEANING_DIVERGENCE"],
};

describe("NQA M14 review workflow", () => {
  it("promotes proposed human evidence to HUMAN_CONFIRMED without mutating machine output", async () => {
    const source = record();
    const machineBefore = JSON.stringify(source.machine);
    const store = new InMemoryNqaReviewJournalStore();

    const proposed = await appendNqaReviewAction({
      record: source,
      store,
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      boundedNote: "Compared the aligned source section.",
      createdAt: "2026-09-24T20:10:00+07:00",
    });
    expect(proposed.status).toBe("PROPOSED");
    expect(proposed.finalGroundTruth).toBeNull();

    const confirmed = await appendNqaReviewAction({
      record: source,
      store,
      actionId: "action-002",
      actionType: "CONFIRM",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [
        {
          kind: "M13_EVIDENCE",
          evidenceId: "alignment-1",
          boundedSummary: "Evidence supports the proposed PASS label.",
        },
      ],
      boundedNote: "Human signoff after source comparison.",
      createdAt: "2026-09-24T20:12:00+07:00",
    });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.finalGroundTruth).toMatchObject({
      decision: "PASS",
      status: "HUMAN_CONFIRMED",
      labeledBy: "reviewer-a",
    });

    const curated = curateNqaShadowRecord(source, confirmed);
    expect(curated.groundTruth?.status).toBe("HUMAN_CONFIRMED");
    expect(JSON.stringify(curated.machine)).toBe(machineBefore);
    expect(source.groundTruth).toBeNull();
    expect(JSON.stringify(source.machine)).toBe(machineBefore);
  });

  it("requires CONFIRM to match the current proposal", () => {
    const source = record();
    const proposed = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:10:00+07:00",
    });

    expect(() =>
      createNqaReviewAction({
        record: source,
        existingActions: [proposed],
        actionId: "action-002",
        actionType: "CONFIRM",
        reviewerId: "reviewer-b",
        label: FAIL_LABEL,
        evidence: [{ kind: "TRANSLATION_HASH", sha256: TRANSLATION_HASH }],
        createdAt: "2026-09-24T20:11:00+07:00",
      })
    ).toThrow("CONFIRM label must match the current proposal.");
  });

  it("supports explicit dispute and adjudicated resolution", () => {
    const source = record({
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "HUMAN_CONFIRMED",
        labeledBy: "reviewer-a",
        labeledAt: "2026-09-24T20:00:00+07:00",
        notes: [],
      },
    });

    const dispute = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-dispute",
      actionType: "DISPUTE",
      reviewerId: "reviewer-b",
      label: FAIL_LABEL,
      evidence: [
        {
          kind: "M13_EVIDENCE",
          evidenceId: "alignment-1",
        },
      ],
      boundedNote: "Meaning divergence requires adjudication.",
      createdAt: "2026-09-24T20:15:00+07:00",
    });
    expect(deriveNqaReviewState(source, [dispute]).status).toBe("DISPUTED");
    expect(deriveNqaReviewState(source, [dispute]).finalGroundTruth).toBeNull();

    const resolve = createNqaReviewAction({
      record: source,
      existingActions: [dispute],
      actionId: "action-resolve",
      actionType: "RESOLVE",
      reviewerId: "reviewer-c",
      label: FAIL_LABEL,
      evidence: [
        { kind: "SOURCE_HASH", sha256: SOURCE_HASH },
        { kind: "TRANSLATION_HASH", sha256: TRANSLATION_HASH },
      ],
      boundedNote: "Adjudicator confirms material divergence.",
      createdAt: "2026-09-24T20:20:00+07:00",
    });

    const resolved = deriveNqaReviewState(source, [dispute, resolve]);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.finalGroundTruth).toMatchObject({
      decision: "FAIL",
      status: "HUMAN_CONFIRMED",
      labeledBy: "reviewer-c",
    });
  });

  it("can confirm an M13 pending-human label directly without rerunning machine QA", () => {
    const source = record({
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
        labeledBy: null,
        labeledAt: null,
        notes: [],
      },
    });
    const action = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-confirm-pending",
      actionType: "CONFIRM",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:09:00+07:00",
    });

    const state = deriveNqaReviewState(source, [action]);
    expect(state.status).toBe("CONFIRMED");
    expect(state.finalGroundTruth?.status).toBe("HUMAN_CONFIRMED");
    expect(state.finalGroundTruth?.decision).toBe("PASS");
  });

  it("rejects evidence references that do not match the M13 record", () => {
    const source = record();
    expect(() =>
      createNqaReviewAction({
        record: source,
        existingActions: [],
        actionId: "action-bad-evidence",
        actionType: "PROPOSE",
        reviewerId: "reviewer-a",
        label: PASS_LABEL,
        evidence: [{ kind: "SOURCE_HASH", sha256: "d".repeat(64) }],
        createdAt: "2026-09-24T20:09:00+07:00",
      })
    ).toThrow("Review action source hash does not match the M13 record.");
  });

  it("rejects journal actions when the M13 machine subject changes", () => {
    const source = record();
    const action = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:10:00+07:00",
    });

    const changed: NqaShadowRecord = {
      ...source,
      machine: {
        ...source.machine,
        decision: "FAIL",
      },
    };

    expect(() => validateNqaReviewJournal(changed, [action])).toThrow(
      "Review action subject fingerprint is stale."
    );
    expect(buildNqaReviewSubjectFingerprint(changed)).not.toBe(
      action.subjectFingerprint
    );
  });

  it("rejects journal reuse when the baseline M13 ground-truth candidate changes", () => {
    const source = record({
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
        labeledBy: null,
        labeledAt: null,
        notes: [],
      },
    });
    const action = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-confirm-pending",
      actionType: "CONFIRM",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:09:00+07:00",
    });

    const changed: NqaShadowRecord = {
      ...source,
      groundTruth: {
        decision: "FAIL",
        reasonCodes: ["MEANING_DIVERGENCE"],
        status: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
        labeledBy: null,
        labeledAt: null,
        notes: [],
      },
    };

    expect(() => validateNqaReviewJournal(changed, [action])).toThrow(
      "Review action subject fingerprint is stale."
    );
  });

  it("rejects a tampered append-only action hash", () => {
    const source = record();
    const action = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: PASS_LABEL,
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:10:00+07:00",
    });

    const tampered: NqaReviewAction = {
      ...action,
      boundedNote: "changed after review",
    };
    expect(() => validateNqaReviewJournal(source, [tampered])).toThrow(
      "Review action hash is invalid."
    );
  });
});
