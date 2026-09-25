import {
  NQA_STRUCTURE_POLICY_VERSION,
  type NqaStructurePolicy,
} from "./contracts";

export const DEFAULT_NQA_STRUCTURE_POLICY: NqaStructurePolicy = {
  version: NQA_STRUCTURE_POLICY_VERSION,
  runOnPass: false,
  maxItems: 4,
  maxCharsPerSide: 500,
  lowScoreItemLimit: 2,
  gapItemLimit: 2,
  minMismatchConfidence: 0.85,
  minMatchConfidence: 0.75,
  minAssessedItems: 1,
  minStrongMatchDimensions: 3,
  minFailItems: 2,
  failStrongMismatchCount: 3,
  failEventPlusSupportingMismatch: true,
  allowStructuredPassUpgrade: false,
};

export function mergeNqaStructurePolicy(
  override: Partial<NqaStructurePolicy> = {}
): NqaStructurePolicy {
  return {
    ...DEFAULT_NQA_STRUCTURE_POLICY,
    ...override,
  };
}
