import { z } from "zod";

export const NqaAdminModeSchema = z.enum(["FULL_QA", "QC"]);
export type NqaAdminMode = z.infer<typeof NqaAdminModeSchema>;

export const NqaAdminSampleModeSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal("FULL"),
]);
export type NqaAdminSampleMode = z.infer<typeof NqaAdminSampleModeSchema>;

export const NqaAdminStartRunInputSchema = z
  .object({
    mode: NqaAdminModeSchema,
    startRow: z.number().int().min(2),
    endRow: z.number().int().min(2),
    googleConnectionId: z.number().int().positive(),
    sampleParagraphs: NqaAdminSampleModeSchema.default(10),
    qcEligibilityOnly: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.endRow < value.startRow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endRow"],
        message: "endRow must be greater than or equal to startRow",
      });
    }
    if (value.endRow - value.startRow + 1 > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endRow"],
        message: "One NQA Admin run is limited to 50 Sheet rows",
      });
    }
  });

export type NqaAdminStartRunInput = z.infer<typeof NqaAdminStartRunInputSchema>;

export const NqaAdminWritebackColumnSchema = z.enum(["L", "M"]);
export type NqaAdminWritebackColumn = z.infer<
  typeof NqaAdminWritebackColumnSchema
>;

export type NqaAdminDisplayDecision =
  "PASS" | "REVIEW" | "MISMATCH" | "INSUFFICIENT";

export type NqaAdminQcFinding = {
  type:
    "FOREIGN_SCRIPT" | "UNICODE_ANOMALY" | "FOOTER_CONTENT" | "EMPTY_CHAPTER";
  severity: "INFO" | "REVIEW" | "FAIL";
  summary: string;
};

export type NqaAdminChapterResult = {
  row: number;
  chapter: number;
  displayDecision: NqaAdminDisplayDecision;
  coreDecision: "PASS" | "REVIEW" | "FAIL";
  reasonCodes: string[];
  confidence: number | null;
  policyVersion: string | null;
  modelSetVersion: string | null;
  evidence: Array<{
    kind: string;
    boundedSummary: string;
  }>;
  sourceExcerpt: string | null;
  translationExcerpt: string | null;
  qcFindings: NqaAdminQcFinding[];
  requestId: string;
  correlationId: string;
  auditRef: string;
  resultFingerprint: string;
  completedAt: string;
};

export type NqaAdminRunRow = {
  row: number;
  title: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  workflowF: boolean;
  workflowG: boolean;
  eligible: boolean;
  intakeStatus: "PASS" | "FAIL";
  intakeIssues: string[];
  chapters: number[];
};

export type NqaAdminRunSummary = {
  totalRows: number;
  eligibleRows: number;
  totalChapters: number;
  processedChapters: number;
  decisions: Record<NqaAdminDisplayDecision, number>;
};

export type NqaAdminRun = {
  version: "nqa-admin-run-v1";
  runId: string;
  actorUserId: number;
  mode: NqaAdminMode;
  startRow: number;
  endRow: number;
  googleConnectionId: number;
  sampleParagraphs: NqaAdminSampleMode;
  qcEligibilityOnly: boolean;
  status: "READY" | "RUNNING" | "COMPLETED" | "BLOCKED";
  blocker: string | null;
  rows: NqaAdminRunRow[];
  cursor: {
    rowIndex: number;
    chapterIndex: number;
  };
  results: NqaAdminChapterResult[];
  writebacks: Array<{
    row: number;
    column: NqaAdminWritebackColumn;
    fingerprint: string;
    valueSha256: string;
    confirmedAt: string;
    requestId: string;
    correlationId: string;
  }>;
  summary: NqaAdminRunSummary;
  createdAt: string;
  updatedAt: string;
};

export type NqaAdminWritebackPreview = {
  version: "nqa-admin-writeback-preview-v1";
  runId: string;
  row: number;
  column: NqaAdminWritebackColumn;
  value: string;
  fingerprint: string;
  confirmation: string;
};
