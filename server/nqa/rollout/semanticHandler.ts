import { hashCanonicalJson } from "../core";
import type { NqaCapability } from "../controlPlane";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import { createNqaSemanticQaHandlers } from "../semantic/handlers";
import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import type { NqaRuntimePolicyResolution } from "./contracts";
import {
  buildNqaDualRunMonitoringRecord,
  type NqaDualRunMonitoringStore,
} from "./monitoring";

type SemanticCapability = "nqa.qa.run_semantic";
type SemanticHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  SemanticCapability
>;

type SemanticHandlerInput = Parameters<typeof createNqaSemanticQaHandlers>[0];

type SemanticHandlerResult = {
  row: number;
  chapter: number;
  status: string;
  semantic: NqaSemanticQaStageResult | null;
  [key: string]: unknown;
};

function requiredTarget(context: NqaGatewayHandlerContext): {
  row: number;
  chapter: number;
} {
  const row = context.target.row;
  const chapter = context.target.chapter;
  if (!row || !chapter) {
    throw new Error("M18 controlled semantic QA requires row and chapter.");
  }
  return { row, chapter };
}

function asSemanticResult(value: unknown): SemanticHandlerResult {
  if (!value || typeof value !== "object") {
    throw new Error("M18 semantic handler returned an invalid result.");
  }
  const result = value as Partial<SemanticHandlerResult>;
  if (
    !Number.isSafeInteger(result.row) ||
    !Number.isSafeInteger(result.chapter) ||
    typeof result.status !== "string"
  ) {
    throw new Error("M18 semantic handler result identity is invalid.");
  }
  return value as SemanticHandlerResult;
}

function rolloutMetadata(resolution: NqaRuntimePolicyResolution) {
  return {
    mode: resolution.mode,
    selectedPolicy: resolution.selectedPolicy,
    inScope: resolution.inScope,
    dualRun: resolution.dualRun,
    registryRevision: resolution.registryRevision,
    registryStateFingerprint: resolution.registryStateFingerprint,
    baselinePolicyFingerprint: resolution.baselinePolicyFingerprint,
    candidatePolicyFingerprint: resolution.candidatePolicyFingerprint,
    scopeId: resolution.scopeId,
    scopeFingerprint: resolution.scopeFingerprint,
  };
}

export function createNqaControlledSemanticQaHandlers(input: {
  semantic: Omit<SemanticHandlerInput, "alignmentPolicy">;
  resolveAlignmentPolicy: (target: {
    row: number;
    chapter: number;
  }) => Promise<NqaRuntimePolicyResolution>;
  monitoringStore: NqaDualRunMonitoringStore;
  now: () => string;
}): SemanticHandlerMap {
  return {
    "nqa.qa.run_semantic": async context => {
      const target = requiredTarget(context);
      const resolution = await input.resolveAlignmentPolicy(target);

      const run = async (
        alignmentPolicy: NqaRuntimePolicyResolution["primaryPolicy"]
      ): Promise<SemanticHandlerResult> => {
        const handler = createNqaSemanticQaHandlers({
          ...input.semantic,
          alignmentPolicy,
        })["nqa.qa.run_semantic"];
        return asSemanticResult(await handler(context));
      };

      if (!resolution.dualRun || !resolution.candidatePolicy) {
        const result = await run(resolution.primaryPolicy);
        return {
          ...result,
          rollout: rolloutMetadata(resolution),
        };
      }

      const baseline = await run(resolution.baselinePolicy);
      if (!baseline.semantic?.alignment) {
        return {
          ...baseline,
          rollout: {
            ...rolloutMetadata(resolution),
            selectedPolicy: "BASELINE",
            dualRun: false,
            monitoring: "NOT_APPLICABLE",
          },
        };
      }

      const candidate = await run(resolution.candidatePolicy);
      if (!candidate.semantic?.alignment) {
        throw new Error(
          "M18 candidate dual-run did not produce alignment evidence."
        );
      }

      const record = buildNqaDualRunMonitoringRecord({
        recordId:
          "m18-" +
          hashCanonicalJson({
            requestId: context.requestId,
            scopeFingerprint: resolution.scopeFingerprint,
            row: target.row,
            chapter: target.chapter,
          }).slice(0, 32),
        row: target.row,
        chapter: target.chapter,
        resolution,
        baseline: baseline.semantic,
        candidate: candidate.semantic,
        observedAt: input.now(),
      });
      await input.monitoringStore.append(record);

      return {
        ...candidate,
        rollout: {
          ...rolloutMetadata(resolution),
          monitoring: {
            recordId: record.recordId,
            recordFingerprint: record.recordFingerprint,
            health: record.health,
            comparison: record.comparison,
          },
        },
      };
    },
  };
}
