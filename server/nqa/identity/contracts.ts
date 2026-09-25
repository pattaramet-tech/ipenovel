import { z } from "zod";

import {
  BundleIdentitySchema,
  NovelIdentitySchema,
  type BundleIdentity,
  type NovelIdentity,
} from "../contracts";

export const NQA_INTAKE_STATUSES = [
  "INTAKE_PASS",
  "INTAKE_REVIEW",
  "INTAKE_FAIL",
] as const;

export const NqaIntakeStatusSchema = z.enum(NQA_INTAKE_STATUSES);
export type NqaIntakeStatus = z.infer<typeof NqaIntakeStatusSchema>;

export const NQA_IDENTITY_RESOLUTION_KINDS = [
  "KNOWN_DOCUMENT",
  "EXACT_TITLE",
  "ALIAS",
  "STRUCTURED_NEW",
  "FUZZY_REVIEW",
  "AMBIGUOUS",
] as const;

export type NqaIdentityResolutionKind =
  (typeof NQA_IDENTITY_RESOLUTION_KINDS)[number];

export const NQA_INTAKE_REASON_CODES = [
  "CONTRACT_INVALID",
  "SOURCE_DOC_UNREADABLE",
  "TRANSLATION_DOC_UNREADABLE",
  "SOURCE_TRANSLATION_SAME_DOCUMENT",
  "IDENTITY_AMBIGUOUS",
  "FUZZY_IDENTITY_REVIEW",
  "DUPLICATE_BUNDLE",
  "OVERLAPPING_BUNDLE_RANGE",
  "BUNDLE_DOCUMENT_DRIFT",
  "DOCUMENT_REUSED_ACROSS_BUNDLES",
] as const;
export const NqaIntakeReasonCodeSchema = z.enum(NQA_INTAKE_REASON_CODES);
export type NqaIntakeReasonCode = z.infer<typeof NqaIntakeReasonCodeSchema>;

export const NqaNovelCatalogEntrySchema = z
  .object({
    novel: NovelIdentitySchema,
    translationDocumentIds: z.array(z.string().min(10)).default([]),
    sourceDocumentIds: z.array(z.string().min(10)).default([]),
  })
  .strict();

export type NqaNovelCatalogEntry = z.infer<typeof NqaNovelCatalogEntrySchema>;

export const NqaBundleCatalogEntrySchema = z
  .object({
    bundle: BundleIdentitySchema,
  })
  .strict();

export type NqaBundleCatalogEntry = z.infer<typeof NqaBundleCatalogEntrySchema>;

export type NqaIdentityCatalog = {
  novels: NqaNovelCatalogEntry[];
  bundles: NqaBundleCatalogEntry[];
};

export type NqaFuzzyCandidate = {
  novelId: string;
  canonicalTitle: string;
  score: number;
};

export type NqaIdentityResolution =
  | {
      status: "RESOLVED";
      kind: "KNOWN_DOCUMENT" | "EXACT_TITLE" | "ALIAS";
      novel: NovelIdentity;
      candidates: [];
    }
  | {
      status: "NEW";
      kind: "STRUCTURED_NEW";
      novel: NovelIdentity;
      candidates: [];
    }
  | {
      status: "REVIEW";
      kind: "FUZZY_REVIEW" | "AMBIGUOUS";
      novel: null;
      candidates: NqaFuzzyCandidate[];
    };

export type NqaIntakeCheckResult = {
  row: number;
  status: NqaIntakeStatus;
  reasonCodes: NqaIntakeReasonCode[];
  novel: NovelIdentity | null;
  bundle: BundleIdentity | null;
  identityResolution: NqaIdentityResolution | null;
};
