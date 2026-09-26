import { createHash } from "node:crypto";

export const MASTER_INTAKE_MAX_ROWS = 100;

export type MasterIntakeParsedTitle = {
  rawTitle: string;
  novelTitle: string;
  normalizedTitle: string;
  episodeNumber: string;
  rangeStart: number;
  rangeEnd: number;
};

export type MasterIntakeRowCanonical = {
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  rowNumber: number;
  novelTitle: string;
  normalizedTitle: string;
  episodeNumber: string;
  translationDocUrl: string;
  translationDocumentId: string;
  webSourceUrl: string | null;
  preparedSourceDocUrl: string;
  preparedSourceDocumentId: string;
};

function normalizeSpace(value: string) {
  return value.normalize("NFKC").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

export function normalizeMasterIntakeNovelTitle(value: string) {
  return normalizeSpace(value).toLocaleLowerCase("th");
}

export function parseMasterIntakeTitleRange(rawValue: string): MasterIntakeParsedTitle | null {
  const rawTitle = normalizeSpace(rawValue);
  const match = rawTitle.match(/^(.*?)\s+(\d{1,7})\s*-\s*(\d{1,7})$/);
  if (!match) return null;
  const novelTitle = normalizeSpace(match[1] ?? "");
  const startText = match[2] ?? "";
  const endText = match[3] ?? "";
  const rangeStart = Number(startText);
  const rangeEnd = Number(endText);
  if (
    !novelTitle ||
    !Number.isSafeInteger(rangeStart) ||
    !Number.isSafeInteger(rangeEnd) ||
    rangeStart <= 0 ||
    rangeEnd < rangeStart
  ) {
    return null;
  }
  return {
    rawTitle,
    novelTitle,
    normalizedTitle: normalizeMasterIntakeNovelTitle(novelTitle),
    episodeNumber: `${startText}-${endText}`,
    rangeStart,
    rangeEnd,
  };
}

export function googleDocumentIdFromUrlOrId(value: string): string | null {
  const normalized = value.trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(normalized)) return normalized;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
    const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function normalizeOptionalHttpUrl(value: string): string | null | undefined {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function masterIntakeRowFingerprint(row: MasterIntakeRowCanonical): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "workspace-master-intake-row-v1",
        spreadsheetId: row.spreadsheetId,
        sheetId: row.sheetId,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        normalizedTitle: row.normalizedTitle,
        episodeNumber: row.episodeNumber,
        translationDocumentId: row.translationDocumentId,
        translationDocUrl: row.translationDocUrl.trim(),
        webSourceUrl: row.webSourceUrl?.trim() ?? null,
        preparedSourceDocumentId: row.preparedSourceDocumentId,
        preparedSourceDocUrl: row.preparedSourceDocUrl.trim(),
      })
    )
    .digest("hex");
}

export function masterIntakePreviewFingerprint(input: {
  workspaceId: number;
  startRow: number;
  endRow: number;
  rows: Array<{ rowNumber: number; rowFingerprint: string; status: string }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "workspace-master-intake-preview-v1",
        workspaceId: input.workspaceId,
        startRow: input.startRow,
        endRow: input.endRow,
        rows: input.rows.map(row => ({
          rowNumber: row.rowNumber,
          rowFingerprint: row.rowFingerprint,
          status: row.status,
        })),
      })
    )
    .digest("hex");
}

export function assertMasterIntakeRowRange(startRow: number, endRow: number) {
  if (
    !Number.isInteger(startRow) ||
    !Number.isInteger(endRow) ||
    startRow < 2 ||
    endRow < startRow ||
    endRow - startRow + 1 > MASTER_INTAKE_MAX_ROWS
  ) {
    throw new Error(`Master Intake supports 1-${MASTER_INTAKE_MAX_ROWS} rows per sync.`);
  }
}
