import { z } from "zod";

export const NQA_SOURCE_CONTRACT_VERSION = "nqa-source-contract-v1" as const;
export const NQA_RESULT_CONTRACT_VERSION = "nqa-result-v1" as const;
export const NQA_FIXTURE_NORMALIZATION_VERSION = "NQA_FIXTURE_V1" as const;

export const NqaDecisionSchema = z.enum(["PASS", "REVIEW", "FAIL"]);
export type NqaDecision = z.infer<typeof NqaDecisionSchema>;

export const GoldLabelStatusSchema = z.enum([
  "CANONICAL_INCIDENT",
  "CANDIDATE_PENDING_HUMAN_SIGNOFF",
  "HUMAN_CONFIRMED",
]);
export type GoldLabelStatus = z.infer<typeof GoldLabelStatusSchema>;

export const TranslationVariantSchema = z.enum([
  "production_original",
  "corrected_candidate",
  "draft",
  "historical_revision",
]);
export type TranslationVariant = z.infer<typeof TranslationVariantSchema>;

export const GoogleDocRefSchema = z
  .object({
    kind: z.literal("google_doc"),
    documentId: z.string().min(10),
    url: z.string().url().optional(),
    docsRevisionToken: z.string().min(1).nullable().optional(),
    driveRevisionId: z.string().min(1).nullable().optional(),
    tabId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type GoogleDocRef = z.infer<typeof GoogleDocRefSchema>;

export const SheetLocatorSchema = z
  .object({
    spreadsheetId: z.string().min(10),
    sheetName: z.string().min(1),
    sheetId: z.number().int().nonnegative().nullable().optional(),
    row: z.number().int().positive(),
  })
  .strict();
export type SheetLocator = z.infer<typeof SheetLocatorSchema>;

export const SourceContractSchema = z
  .object({
    contractVersion: z.literal(NQA_SOURCE_CONTRACT_VERSION),
    locator: SheetLocatorSchema,
    novelDisplayTitle: z.string().min(1),
    translationRef: GoogleDocRefSchema.extend({
      column: z.literal("C"),
    }).strict(),
    preparedSourceRef: GoogleDocRefSchema.extend({
      column: z.literal("K"),
    }).strict(),
    webSourceRef: z
      .object({
        column: z.literal("E"),
        url: z.string().url(),
      })
      .strict()
      .nullable()
      .optional(),
    routingPolicy: z.literal("K_PRIMARY_E_FALLBACK_METADATA"),
  })
  .strict();
export type SourceContract = z.infer<typeof SourceContractSchema>;

export const NovelIdentitySchema = z
  .object({
    novelId: z.string().regex(/^novel_[a-f0-9]{16}$/),
    canonicalTitle: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    authority: z.enum(["EXACT", "ALIAS", "STRUCTURED", "FUZZY_CANDIDATE"]),
  })
  .strict();
export type NovelIdentity = z.infer<typeof NovelIdentitySchema>;

export const BundleIdentitySchema = z
  .object({
    bundleId: z.string().regex(/^bundle_[a-f0-9]{16}_[0-9]+_[0-9]+$/),
    novelId: z.string().regex(/^novel_[a-f0-9]{16}$/),
    rangeStart: z.number().int().positive(),
    rangeEnd: z.number().int().positive(),
    locator: SheetLocatorSchema.nullable(),
    translationDocumentId: z.string().min(10),
    sourceDocumentId: z.string().min(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rangeEnd < value.rangeStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rangeEnd must be greater than or equal to rangeStart",
        path: ["rangeEnd"],
      });
    }
  });
export type BundleIdentity = z.infer<typeof BundleIdentitySchema>;

export const ChapterIdentitySchema = z
  .object({
    novelId: z.string().regex(/^novel_[a-f0-9]{16}$/),
    bundleId: z.string().regex(/^bundle_[a-f0-9]{16}_[0-9]+_[0-9]+$/),
    sourceInternalSequence: z.number().int().positive().nullable(),
    sourceChapter: z.number().int().positive(),
    sourceTitle: z.string().min(1).nullable(),
    translationChapter: z.number().int().positive(),
    translationTitle: z.string().min(1).nullable(),
    translationVariant: TranslationVariantSchema,
  })
  .strict();
export type ChapterIdentity = z.infer<typeof ChapterIdentitySchema>;

export const ContentFingerprintSchema = z
  .object({
    normalizationVersion: z.literal(NQA_FIXTURE_NORMALIZATION_VERSION),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    charCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    paragraphCount: z.number().int().nonnegative().nullable().optional(),
    startIndex: z.number().int().nonnegative().nullable().optional(),
    endIndex: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type ContentFingerprint = z.infer<typeof ContentFingerprintSchema>;

export const ChapterSnapshotRefSchema = z
  .object({
    document: GoogleDocRefSchema,
    chapter: z.number().int().positive(),
    internalSequence: z.number().int().positive().nullable().optional(),
    title: z.string().min(1),
    variant: TranslationVariantSchema.nullable().optional(),
    fingerprint: ContentFingerprintSchema,
  })
  .strict();
export type ChapterSnapshotRef = z.infer<typeof ChapterSnapshotRefSchema>;

export const NqaReasonCodeSchema = z.enum([
  "SOURCE_REFERENCE_MISSING",
  "SOURCE_DOC_UNREADABLE",
  "TRANSLATION_DOC_UNREADABLE",
  "INTERNAL_SEQUENCE_DRIFT",
  "SOURCE_CHAPTER_NUMBER_MISMATCH",
  "SOURCE_TITLE_MISMATCH",
  "TRANSLATION_CHAPTER_NUMBER_MISMATCH",
  "TRANSLATION_TITLE_MISMATCH",
  "TAB_POSITION_MISMATCH",
  "DUPLICATE_CHAPTER_ID",
  "MISSING_CHAPTER_ID",
  "AMBIGUOUS_CHAPTER_MAPPING",
  "EMPTY_CHAPTER",
  "SUSPICIOUSLY_SHORT_CHAPTER",
  "SUSPICIOUSLY_LONG_CHAPTER",
  "LENGTH_RATIO_OUTLIER",
  "PARAGRAPH_RATIO_OUTLIER",
  "EXACT_DUPLICATE_CHAPTER",
  "REPEATED_PARAGRAPH",
  "MISSING_ENDING_MARKER",
  "FOREIGN_TEXT_POLICY_VIOLATION",
  "MALFORMED_CONTENT",
  "MEANING_DIVERGENCE",
  "EVENT_MISMATCH",
  "ENTITY_MISMATCH",
  "RELATIONSHIP_MISMATCH",
  "CAUSALITY_MISMATCH",
  "CHRONOLOGY_MISMATCH",
  "CONTRADICTION",
  "OMISSION_MAJOR",
  "ADDITION_MAJOR",
  "FABRICATION_SUSPECTED",
  "FABRICATION_DEFINITE",
  "WRONG_CHAPTER",
  "SOURCE_DRIFT",
  "LOW_CONFIDENCE",
  "MODEL_DISAGREEMENT",
  "ALIGNMENT_UNCERTAIN",
  "INSUFFICIENT_EVIDENCE",
  "HUMAN_REVIEW_REQUIRED",
]);
export type NqaReasonCode = z.infer<typeof NqaReasonCodeSchema>;

export const QaDimensionScoresSchema = z
  .object({
    meaning: z.number().min(0).max(1).nullable(),
    events: z.number().min(0).max(1).nullable(),
    entities: z.number().min(0).max(1).nullable(),
    relationships: z.number().min(0).max(1).nullable(),
    causality: z.number().min(0).max(1).nullable(),
    chronology: z.number().min(0).max(1).nullable(),
    sourceCoverage: z.number().min(0).max(1).nullable(),
    translationCoverage: z.number().min(0).max(1).nullable(),
    fabricationRisk: z.number().min(0).max(1).nullable(),
    wrongChapterRisk: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type QaDimensionScores = z.infer<typeof QaDimensionScoresSchema>;

export const QaEvidenceRefSchema = z
  .object({
    evidenceId: z.string().min(1),
    kind: z.enum([
      "SOURCE_RANGE",
      "TRANSLATION_RANGE",
      "ALIGNMENT",
      "ENTITY",
      "EVENT",
      "POLICY",
    ]),
    sourceStartIndex: z.number().int().nonnegative().nullable().optional(),
    sourceEndIndex: z.number().int().nonnegative().nullable().optional(),
    translationStartIndex: z.number().int().nonnegative().nullable().optional(),
    translationEndIndex: z.number().int().nonnegative().nullable().optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    translationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    boundedSummary: z.string().max(1000),
  })
  .strict();
export type QaEvidenceRef = z.infer<typeof QaEvidenceRefSchema>;

export const QaResultSchema = z
  .object({
    contractVersion: z.literal(NQA_RESULT_CONTRACT_VERSION),
    runId: z.string().min(1),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    identity: ChapterIdentitySchema,
    decision: NqaDecisionSchema,
    reasonCodes: z.array(NqaReasonCodeSchema),
    dimensions: QaDimensionScoresSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(QaEvidenceRefSchema),
    policyVersion: z.string().min(1),
    modelSetVersion: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();
export type QaResult = z.infer<typeof QaResultSchema>;

export const CanonicalFixtureSchema = z
  .object({
    fixtureId: z.string().regex(/^nqa_fixture_[a-z0-9_]+$/),
    label: z.string().min(1),
    source: ChapterSnapshotRefSchema,
    translation: ChapterSnapshotRefSchema,
    expectedDecision: NqaDecisionSchema,
    expectedReasonCodes: z.array(NqaReasonCodeSchema),
    goldLabelStatus: GoldLabelStatusSchema,
    provenance: z.enum(["CURRENT", "HISTORICAL_REVISION"]),
    notes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CanonicalFixture = z.infer<typeof CanonicalFixtureSchema>;
