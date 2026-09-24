import { hashCanonicalJson } from "../core";
import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import {
  NQA_SHADOW_CHECKPOINT_VERSION,
  NQA_SHADOW_RECORD_VERSION,
  NqaShadowCaseSchema,
  NqaShadowCheckpointSchema,
  NqaShadowRecordSchema,
  NqaShadowRunIdSchema,
  type NqaShadowBatchResult,
  type NqaShadowCase,
  type NqaShadowCheckpoint,
  type NqaShadowMachineResult,
  type NqaShadowRecord,
} from "./contracts";
import { buildNqaShadowMachineResult } from "./evidence";
import { calculateNqaShadowMetrics } from "./metrics";
import type { NqaShadowStore } from "./store";

export interface NqaShadowEvaluator {
  evaluate(input: {
    row: number;
    chapter: number;
    inputFingerprint: string | null;
  }): Promise<NqaShadowMachineResult>;
}

export function semanticShadowEvaluator(
  evaluate: (input: {
    row: number;
    chapter: number;
    inputFingerprint: string | null;
  }) => Promise<NqaSemanticQaStageResult>
): NqaShadowEvaluator {
  return {
    async evaluate(input) {
      return buildNqaShadowMachineResult(await evaluate(input));
    },
  };
}

export function buildNqaShadowBatchFingerprint(
  cases: readonly NqaShadowCase[]
): string {
  return hashCanonicalJson({
    scope: "nqa:shadow-batch:v1",
    cases: cases.map(item => ({
      caseId: item.caseId,
      row: item.row,
      chapter: item.chapter,
      inputFingerprint: item.inputFingerprint,
    })),
  });
}

function uniqueCases(input: readonly NqaShadowCase[]): NqaShadowCase[] {
  const parsed = input.map(item => NqaShadowCaseSchema.parse(item));
  const ids = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.caseId)) {
      throw new Error("Shadow batch caseId values must be unique.");
    }
    ids.add(item.caseId);
  }
  return parsed;
}

function newCheckpoint(input: {
  runId: string;
  batchFingerprint: string;
  now: string;
}): NqaShadowCheckpoint {
  return {
    checkpointVersion: NQA_SHADOW_CHECKPOINT_VERSION,
    runId: input.runId,
    batchFingerprint: input.batchFingerprint,
    completedCaseIds: [],
    updatedAt: input.now,
  };
}

export async function runNqaShadowBatch(input: {
  runId: string;
  cases: readonly NqaShadowCase[];
  evaluator: NqaShadowEvaluator;
  store: NqaShadowStore;
  maxCasesPerInvocation?: number;
  now?: () => string;
}): Promise<NqaShadowBatchResult> {
  const runId = NqaShadowRunIdSchema.parse(input.runId);
  const cases = uniqueCases(input.cases);
  if (cases.length === 0 || cases.length > 500) {
    throw new Error("Shadow batch must contain between 1 and 500 cases.");
  }

  const maxCases = input.maxCasesPerInvocation ?? 20;
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 100) {
    throw new Error("maxCasesPerInvocation must be between 1 and 100.");
  }

  const now = input.now ?? (() => new Date().toISOString());
  const batchFingerprint = buildNqaShadowBatchFingerprint(cases);
  let checkpoint =
    (await input.store.loadCheckpoint(runId)) ??
    newCheckpoint({ runId, batchFingerprint, now: now() });

  checkpoint = NqaShadowCheckpointSchema.parse(checkpoint);
  if (checkpoint.batchFingerprint !== batchFingerprint) {
    throw new Error(
      "Shadow batch fingerprint does not match the existing checkpoint."
    );
  }

  const caseById = new Map(cases.map(item => [item.caseId, item]));
  for (const completedCaseId of checkpoint.completedCaseIds) {
    if (!caseById.has(completedCaseId)) {
      throw new Error("Checkpoint contains a case outside the current batch.");
    }
    const record = await input.store.getRecord(runId, completedCaseId);
    if (!record) {
      throw new Error(
        "Checkpoint references a completed case without a stored record."
      );
    }
  }

  const reusedCaseIds: string[] = [];
  for (const item of cases) {
    if (!checkpoint.completedCaseIds.includes(item.caseId)) continue;
    const existing = await input.store.getRecord(runId, item.caseId);
    if (!existing) continue;

    const refreshed: NqaShadowRecord = {
      ...existing,
      tags: [...item.tags],
      groundTruth: item.groundTruth,
      updatedAt: now(),
    };
    await input.store.putRecord(NqaShadowRecordSchema.parse(refreshed));
    reusedCaseIds.push(item.caseId);
  }

  const processedCaseIds: string[] = [];
  const completed = new Set(checkpoint.completedCaseIds);
  const pending = cases.filter(item => !completed.has(item.caseId));

  for (const item of pending.slice(0, maxCases)) {
    const machine = await input.evaluator.evaluate({
      row: item.row,
      chapter: item.chapter,
      inputFingerprint: item.inputFingerprint,
    });
    const timestamp = now();
    const record = NqaShadowRecordSchema.parse({
      recordVersion: NQA_SHADOW_RECORD_VERSION,
      runId,
      batchFingerprint,
      caseId: item.caseId,
      row: item.row,
      chapter: item.chapter,
      inputFingerprint: item.inputFingerprint,
      tags: item.tags,
      groundTruth: item.groundTruth,
      machine,
      evaluatedAt: timestamp,
      updatedAt: timestamp,
    });
    await input.store.putRecord(record);

    checkpoint = NqaShadowCheckpointSchema.parse({
      ...checkpoint,
      completedCaseIds: [...checkpoint.completedCaseIds, item.caseId],
      updatedAt: now(),
    });
    await input.store.saveCheckpoint(checkpoint);
    processedCaseIds.push(item.caseId);
  }

  if (processedCaseIds.length === 0 && checkpoint.completedCaseIds.length > 0) {
    checkpoint = NqaShadowCheckpointSchema.parse({
      ...checkpoint,
      updatedAt: now(),
    });
    await input.store.saveCheckpoint(checkpoint);
  }

  const currentIds = new Set(cases.map(item => item.caseId));
  const records = (await input.store.listRecords(runId)).filter(record =>
    currentIds.has(record.caseId)
  );
  const metrics = calculateNqaShadowMetrics({
    totalCases: cases.length,
    records,
  });
  await input.store.saveMetrics(runId, metrics);

  const completedIds = new Set(checkpoint.completedCaseIds);
  return {
    runId,
    batchFingerprint,
    processedCaseIds,
    reusedCaseIds,
    remainingCaseIds: cases
      .filter(item => !completedIds.has(item.caseId))
      .map(item => item.caseId),
    checkpoint,
    metrics,
  };
}
