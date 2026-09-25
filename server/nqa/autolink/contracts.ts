import { z } from "zod";

export const NQA_NOVEL_ID_AUTOLINK_VERSION =
  "nqa-novel-id-autolink-v1" as const;
export const NQA_NOVEL_ID_BACKFILL_AUTHORIZATION_VERSION =
  "nqa-novel-id-backfill-authorization-v1" as const;

export const NqaNovelIdAutolinkConfigSchema = z
  .object({
    spreadsheetId: z.string().min(1),
    spreadsheetTitle: z.string().min(1),
    sheetName: z.string().min(1),
    authorizationTtlSeconds: z.number().int().positive().max(3600).default(300),
  })
  .strict();

export type NqaNovelIdAutolinkConfig = z.infer<
  typeof NqaNovelIdAutolinkConfigSchema
>;

export type NqaNovelCatalogCandidate = {
  novelId: number;
  title: string;
  slug: string | null;
  author: string | null;
  publicationStatus: string | null;
};

export interface NqaNovelCatalogReader {
  searchByTitle(title: string): Promise<NqaNovelCatalogCandidate[]>;
  getById(novelId: number): Promise<NqaNovelCatalogCandidate | null>;
}

export type NqaNovelIdSheetRowIdentity = {
  spreadsheetId: string;
  spreadsheetTitle: string | null;
  sheetName: string;
  row: number;
  novelIdCell: string | null;
  novelTitle: string | null;
};

export type NqaNovelIdBackfillWriteReceipt = {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
};

export interface NqaNovelIdSheetBackfillTransport {
  readRowIdentity(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
  }): Promise<NqaNovelIdSheetRowIdentity>;

  writeNovelId(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
    novelId: number;
  }): Promise<NqaNovelIdBackfillWriteReceipt>;
}

export type NqaNovelIdAutolinkPreviewStatus =
  | "MATCH"
  | "NO_MATCH"
  | "AMBIGUOUS"
  | "ALREADY_LINKED"
  | "INVALID_EXISTING_VALUE"
  | "MISSING_TITLE";

export type NqaNovelIdAutolinkPreview = {
  version: typeof NQA_NOVEL_ID_AUTOLINK_VERSION;
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
  row: number;
  novelTitle: string | null;
  normalizedNovelTitle: string | null;
  currentNovelIdCell: string | null;
  existingNovelId: number | null;
  status: NqaNovelIdAutolinkPreviewStatus;
  candidates: NqaNovelCatalogCandidate[];
  matchedNovelId: number | null;
  createdAt: string;
  previewFingerprint: string;
};

export type NqaNovelIdBackfillAuthorization = {
  authorizationVersion: typeof NQA_NOVEL_ID_BACKFILL_AUTHORIZATION_VERSION;
  authorizationId: string;
  authorizerId: string;
  approvalStatement: "I_CONFIRM_NQA_NOVEL_ID_BACKFILL";
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
  row: number;
  novelTitle: string;
  normalizedNovelTitle: string;
  previewFingerprint: string;
  novelId: number;
  approvedAt: string;
  validUntil: string;
  authorizationFingerprint: string;
};

export type NqaWorkspaceSyncHandoff = {
  status: "SYNC_READY";
  row: number;
  novelId: number;
  spreadsheetId: string;
  sheetName: string;
  canonicalIdentity: string;
  sourceKey: string;
  backfillAuditFingerprint: string;
};

export type NqaNovelIdBackfillResult = {
  status: "BACKFILLED";
  row: number;
  novelId: number;
  previewFingerprint: string;
  authorizationFingerprint: string;
  writeReceipt: NqaNovelIdBackfillWriteReceipt;
  syncHandoff: NqaWorkspaceSyncHandoff;
  auditFingerprint: string;
};
