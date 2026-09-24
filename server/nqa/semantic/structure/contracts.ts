import type {
  NqaDecision,
  NqaReasonCode,
  QaEvidenceRef,
} from "../../contracts";

export const NQA_STRUCTURE_POLICY_VERSION = "nqa-structure-v1" as const;

export type NqaStructureEvidenceKind =
  "ALIGNED_PAIR" | "SOURCE_GAP" | "TRANSLATION_GAP";

export type NqaStructureEvidenceItem = {
  evidenceId: string;
  kind: NqaStructureEvidenceKind;
  sourceHash: string | null;
  translationHash: string | null;
  sourceStartIndex: number | null;
  sourceEndIndex: number | null;
  translationStartIndex: number | null;
  translationEndIndex: number | null;
  rerankScore: number | null;
  sourceText: string | null;
  translationText: string | null;
};

export type NqaStructuredEntity = {
  canonicalName: string;
  role: string | null;
};

export type NqaStructuredEvent = {
  eventId: string;
  actor: string | null;
  action: string;
  object: string | null;
  outcome: string | null;
  order: number;
};

export type NqaStructuredRelationship = {
  subject: string;
  relation: string;
  object: string;
};

export type NqaStructuredCausalLink = {
  causeEventId: string;
  effectEventId: string;
};

export type NqaStructuredSide = {
  entities: NqaStructuredEntity[];
  events: NqaStructuredEvent[];
  relationships: NqaStructuredRelationship[];
  causalLinks: NqaStructuredCausalLink[];
};

export type NqaStructureDimensionStatus = "MATCH" | "MISMATCH" | "INSUFFICIENT";

export type NqaStructureDimension =
  "EVENT" | "ENTITY" | "RELATIONSHIP" | "CAUSALITY" | "CHRONOLOGY";

export type NqaStructureDimensionAssessment = {
  dimension: NqaStructureDimension;
  status: NqaStructureDimensionStatus;
  confidence: number;
  boundedSummary: string;
};

export type NqaStructurePairAssessment = {
  evidenceId: string;
  source: NqaStructuredSide;
  translation: NqaStructuredSide;
  dimensions: NqaStructureDimensionAssessment[];
};

export interface NqaStructureVerificationProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  verify(
    items: NqaStructureEvidenceItem[]
  ): Promise<NqaStructurePairAssessment[]>;
}

export type NqaStructurePolicy = {
  version: string;
  runOnPass: boolean;
  maxItems: number;
  maxCharsPerSide: number;
  lowScoreItemLimit: number;
  gapItemLimit: number;
  minMismatchConfidence: number;
  minMatchConfidence: number;
  minAssessedItems: number;
  minStrongMatchDimensions: number;
  minFailItems: number;
  failStrongMismatchCount: number;
  failEventPlusSupportingMismatch: boolean;
  allowStructuredPassUpgrade: boolean;
};

export type NqaStructureMetrics = {
  itemCount: number;
  assessedItemCount: number;
  strongMismatchCount: number;
  strongMismatchItemCount: number;
  strongMatchCount: number;
  mismatchByDimension: Partial<Record<NqaStructureDimension, number>>;
  matchByDimension: Partial<Record<NqaStructureDimension, number>>;
};

export type NqaStructureResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  metrics: NqaStructureMetrics;
  assessments: NqaStructurePairAssessment[];
  providerId: string;
  modelVersion: string;
  policyVersion: string;
  evidence: QaEvidenceRef[];
};
