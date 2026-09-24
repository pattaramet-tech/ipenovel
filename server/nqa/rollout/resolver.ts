import { hashCanonicalJson } from "../core";
import type { NqaPolicyActivationStore } from "../activation/store";
import {
  NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION,
  NqaControlledRolloutScopeSchema,
  NqaRuntimePolicyResolutionSchema,
  type NqaControlledRolloutScope,
  type NqaRuntimePolicyResolution,
} from "./contracts";

function targetKey(row: number, chapter: number): string {
  return row + ":" + chapter;
}

export function normalizeNqaRolloutTargets(
  targets: readonly { row: number; chapter: number }[]
): Array<{ row: number; chapter: number }> {
  const unique = new Map<string, { row: number; chapter: number }>();
  for (const target of targets) {
    if (!Number.isSafeInteger(target.row) || target.row <= 0) {
      throw new Error(
        "Controlled rollout target row must be a positive integer."
      );
    }
    if (!Number.isSafeInteger(target.chapter) || target.chapter <= 0) {
      throw new Error(
        "Controlled rollout target chapter must be a positive integer."
      );
    }
    unique.set(targetKey(target.row, target.chapter), {
      row: target.row,
      chapter: target.chapter,
    });
  }
  return Array.from(unique.values()).sort(
    (left, right) => left.row - right.row || left.chapter - right.chapter
  );
}

function scopePayload(
  scope: Omit<NqaControlledRolloutScope, "scopeFingerprint">
): unknown {
  return {
    scope: "nqa:controlled-rollout-scope:v1",
    ...scope,
  };
}

export function buildNqaControlledRolloutScope(input: {
  state: Awaited<ReturnType<NqaPolicyActivationStore["readState"]>>;
  scopeId: string;
  approvedBy: string;
  approvedAt: string;
  targets: readonly { row: number; chapter: number }[];
}): NqaControlledRolloutScope {
  if (!input.state.rollbackTarget || !input.state.lastTransactionId) {
    throw new Error(
      "M18 controlled rollout requires an active M17 candidate with rollback target."
    );
  }

  const withoutFingerprint = {
    scopeVersion: NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION,
    scopeId: input.scopeId,
    approvedBy: input.approvedBy,
    approvalStatement: "I_APPROVE_NQA_CONTROLLED_ROLLOUT_SCOPE" as const,
    approvedAt: input.approvedAt,
    sourceActivationTransactionId: input.state.lastTransactionId,
    expectedRegistryRevision: input.state.revision,
    expectedRegistryStateFingerprint: input.state.stateFingerprint,
    candidatePolicyFingerprint: input.state.activePolicyFingerprint,
    baselinePolicyFingerprint: input.state.rollbackTarget.policyFingerprint,
    targets: normalizeNqaRolloutTargets(input.targets),
  };

  return NqaControlledRolloutScopeSchema.parse({
    ...withoutFingerprint,
    scopeFingerprint: hashCanonicalJson(scopePayload(withoutFingerprint)),
  });
}

export function verifyNqaControlledRolloutScope(
  input: NqaControlledRolloutScope
): NqaControlledRolloutScope {
  const scope = NqaControlledRolloutScopeSchema.parse(input);
  const { scopeFingerprint, ...withoutFingerprint } = scope;
  if (
    scopeFingerprint !== hashCanonicalJson(scopePayload(withoutFingerprint))
  ) {
    throw new Error("M18 controlled rollout scope fingerprint mismatch.");
  }
  const keys = scope.targets.map(target =>
    targetKey(target.row, target.chapter)
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("M18 controlled rollout scope contains duplicate targets.");
  }
  return scope;
}

export async function resolveNqaRuntimeAlignmentPolicy(input: {
  store: NqaPolicyActivationStore;
  scope?: NqaControlledRolloutScope | null;
  row: number;
  chapter: number;
}): Promise<NqaRuntimePolicyResolution> {
  const state = await input.store.readState();
  const scope = input.scope
    ? verifyNqaControlledRolloutScope(input.scope)
    : null;

  if (!scope) {
    const baseline = state.rollbackTarget?.policy ?? state.activePolicy;
    return NqaRuntimePolicyResolutionSchema.parse({
      mode: "BASELINE_ONLY",
      selectedPolicy: "BASELINE",
      inScope: false,
      dualRun: false,
      registryRevision: state.revision,
      registryStateFingerprint: state.stateFingerprint,
      sourceActivationTransactionId:
        state.rollbackTarget?.sourceActivationTransactionId ?? null,
      baselinePolicyFingerprint:
        state.rollbackTarget?.policyFingerprint ??
        state.activePolicyFingerprint,
      candidatePolicyFingerprint: state.rollbackTarget
        ? state.activePolicyFingerprint
        : null,
      primaryPolicy: baseline,
      baselinePolicy: baseline,
      candidatePolicy: state.rollbackTarget ? state.activePolicy : null,
      scopeId: null,
      scopeFingerprint: null,
    });
  }

  if (!state.rollbackTarget) {
    if (
      state.activePolicyFingerprint === scope.baselinePolicyFingerprint &&
      state.revision > scope.expectedRegistryRevision
    ) {
      return NqaRuntimePolicyResolutionSchema.parse({
        mode: "ROLLED_BACK_BASELINE",
        selectedPolicy: "BASELINE",
        inScope: false,
        dualRun: false,
        registryRevision: state.revision,
        registryStateFingerprint: state.stateFingerprint,
        sourceActivationTransactionId: scope.sourceActivationTransactionId,
        baselinePolicyFingerprint: state.activePolicyFingerprint,
        candidatePolicyFingerprint: null,
        primaryPolicy: state.activePolicy,
        baselinePolicy: state.activePolicy,
        candidatePolicy: null,
        scopeId: scope.scopeId,
        scopeFingerprint: scope.scopeFingerprint,
      });
    }
    throw new Error(
      "M18 rollout scope is incompatible with current registry state."
    );
  }

  if (
    state.revision !== scope.expectedRegistryRevision ||
    state.stateFingerprint !== scope.expectedRegistryStateFingerprint ||
    state.lastTransactionId !== scope.sourceActivationTransactionId ||
    state.activePolicyFingerprint !== scope.candidatePolicyFingerprint ||
    state.rollbackTarget.policyFingerprint !== scope.baselinePolicyFingerprint
  ) {
    throw new Error("M18 rollout scope is stale for current registry state.");
  }

  const inScope = scope.targets.some(
    target => target.row === input.row && target.chapter === input.chapter
  );
  const baseline = state.rollbackTarget.policy;
  const candidate = state.activePolicy;

  return NqaRuntimePolicyResolutionSchema.parse({
    mode: inScope ? "CONTROLLED_CANDIDATE" : "BASELINE_ONLY",
    selectedPolicy: inScope ? "CANDIDATE" : "BASELINE",
    inScope,
    dualRun: inScope,
    registryRevision: state.revision,
    registryStateFingerprint: state.stateFingerprint,
    sourceActivationTransactionId: scope.sourceActivationTransactionId,
    baselinePolicyFingerprint: state.rollbackTarget.policyFingerprint,
    candidatePolicyFingerprint: state.activePolicyFingerprint,
    primaryPolicy: inScope ? candidate : baseline,
    baselinePolicy: baseline,
    candidatePolicy: candidate,
    scopeId: scope.scopeId,
    scopeFingerprint: scope.scopeFingerprint,
  });
}

export function createNqaRuntimeAlignmentPolicyResolver(input: {
  store: NqaPolicyActivationStore;
  scope?: NqaControlledRolloutScope | null;
}): (target: {
  row: number;
  chapter: number;
}) => Promise<NqaRuntimePolicyResolution> {
  return target =>
    resolveNqaRuntimeAlignmentPolicy({
      store: input.store,
      scope: input.scope,
      row: target.row,
      chapter: target.chapter,
    });
}
