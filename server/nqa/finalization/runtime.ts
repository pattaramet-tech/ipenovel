import { hashCanonicalJson } from "../core";
import {
  InMemoryNqaPolicyActivationStore,
  JsonFileNqaPolicyActivationStore,
} from "../activation/store";
import { NqaFullAlignmentPolicySchema } from "../candidatePolicy/contracts";
import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  verifyNqaBaselineFinalizationEvent,
  verifyNqaBaselineLineageState,
} from "./integrity";
import type { NqaBaselineLineageStore } from "./store";

export const NQA_FINALIZED_BASELINE_RUNTIME_VERSION =
  "nqa-finalized-baseline-runtime-v1" as const;

export type NqaFinalizedBaselineRuntimeResolution = {
  runtimeVersion: typeof NQA_FINALIZED_BASELINE_RUNTIME_VERSION;
  source: "M20_FINALIZED_BASELINE_LINEAGE";
  lineageRevision: number;
  lineageStateFingerprint: string;
  baselinePolicyVersion: string;
  baselinePolicyFingerprint: string;
  baselinePolicy: NqaAlignmentPolicy;
  predecessorBaselinePolicyFingerprint: string;
  sourceFinalizationTransactionId: string;
  sourceFinalizationEventFingerprint: string;
  sourceCompletionArtifactFingerprint: string;
  provenanceFingerprint: string;
};

export async function resolveNqaFinalizedBaselineRuntime(input: {
  lineageStore: NqaBaselineLineageStore;
}): Promise<NqaFinalizedBaselineRuntimeResolution> {
  const state = verifyNqaBaselineLineageState(
    await input.lineageStore.readState()
  );

  if (
    state.revision <= 0 ||
    !state.sourceFinalizationTransactionId ||
    !state.sourceCompletionArtifactFingerprint ||
    !state.predecessorBaselinePolicyFingerprint
  ) {
    throw new Error(
      "M21 finalized baseline runtime requires completed M20 baseline lineage."
    );
  }

  const event = await input.lineageStore.getEvent(
    state.sourceFinalizationTransactionId
  );
  if (!event) {
    throw new Error(
      "M21 finalized baseline runtime cannot resolve the source M20 finalization event."
    );
  }
  const verifiedEvent = verifyNqaBaselineFinalizationEvent(event);

  if (
    verifiedEvent.transactionId !== state.sourceFinalizationTransactionId ||
    verifiedEvent.resultingLineageState.stateFingerprint !==
      state.stateFingerprint ||
    verifiedEvent.resultingLineageState.baselinePolicyFingerprint !==
      state.baselinePolicyFingerprint ||
    verifiedEvent.resultingLineageState.predecessorBaselinePolicyFingerprint !==
      state.predecessorBaselinePolicyFingerprint ||
    verifiedEvent.sourceCompletionGate.artifactFingerprint !==
      state.sourceCompletionArtifactFingerprint ||
    verifiedEvent.humanAuthorization.candidatePolicyFingerprint !==
      state.baselinePolicyFingerprint
  ) {
    throw new Error(
      "M21 finalized baseline runtime provenance does not match current M20 lineage state."
    );
  }

  const baselinePolicy = NqaFullAlignmentPolicySchema.parse(
    state.baselinePolicy
  );
  const withoutFingerprint = {
    runtimeVersion: NQA_FINALIZED_BASELINE_RUNTIME_VERSION,
    source: "M20_FINALIZED_BASELINE_LINEAGE" as const,
    lineageRevision: state.revision,
    lineageStateFingerprint: state.stateFingerprint,
    baselinePolicyVersion: state.baselinePolicyVersion,
    baselinePolicyFingerprint: state.baselinePolicyFingerprint,
    baselinePolicy,
    predecessorBaselinePolicyFingerprint:
      state.predecessorBaselinePolicyFingerprint,
    sourceFinalizationTransactionId: state.sourceFinalizationTransactionId,
    sourceFinalizationEventFingerprint: verifiedEvent.eventFingerprint,
    sourceCompletionArtifactFingerprint:
      state.sourceCompletionArtifactFingerprint,
  };

  return {
    ...withoutFingerprint,
    provenanceFingerprint: hashCanonicalJson({
      scope: "nqa:finalized-baseline-runtime-provenance:v1",
      ...withoutFingerprint,
    }),
  };
}

export function createNqaFinalizedBaselineAlignmentPolicyResolver(input: {
  lineageStore: NqaBaselineLineageStore;
}): () => Promise<NqaAlignmentPolicy> {
  return async () =>
    (await resolveNqaFinalizedBaselineRuntime(input)).baselinePolicy;
}

export async function createNqaNextCycleInMemoryActivationStore(input: {
  lineageStore: NqaBaselineLineageStore;
}) {
  const baseline = await resolveNqaFinalizedBaselineRuntime(input);
  return {
    baseline,
    store: new InMemoryNqaPolicyActivationStore(baseline.baselinePolicy),
  };
}

export async function createNqaNextCycleJsonActivationStore(input: {
  lineageStore: NqaBaselineLineageStore;
  rootDir: string;
}) {
  const baseline = await resolveNqaFinalizedBaselineRuntime({
    lineageStore: input.lineageStore,
  });
  return {
    baseline,
    store: new JsonFileNqaPolicyActivationStore(
      input.rootDir,
      baseline.baselinePolicy
    ),
  };
}
