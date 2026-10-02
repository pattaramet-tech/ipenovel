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
  preparedSourceDocUrl: string | null;
  preparedSourceDocumentId: string | null;
};

function normalizeSpace(value: string) {
  return value.normalize("NFKC").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

export function normalizeMasterIntakeNovelTitle(value: string) {
  return normalizeSpace(value).toLocaleLowerCase("th");
}

export function parseMasterIntakeTitleRange(rawValue: string): MasterIntakeParsedTitle | null {
  const rawTitle = normalizeSpace(rawValue);
  const rangeTitle = rawTitle.replace(/\s+(?:ต้นฉบับ|จบ)$/, "");
  const match = rangeTitle.match(/^(.*?)\s+(\d{1,7})\s*-\s*(\d{1,7})$/);
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

/**
 * Parse an episode number/range into canonical start/end numbers. Leading
 * zeros, whitespace and dash variants normalize away: "001 - 030",
 * "001-030", "1-30" and "1 — 30" all resolve to { start: 1, end: 30 }.
 * Returns null for malformed input — callers must fail closed.
 */
export function parseMasterIntakeEpisodeSpan(value: string): { start: number; end: number } | null {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/[–—]/g, "-");
  const match = normalized.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
    return null;
  }
  return { start, end };
}

export type MasterIntakeCanonicalIdentity = {
  version: "workspace-master-intake-identity-v2";
  normalizedTitle: string;
  episodeStart: number;
  episodeEnd: number;
};

/**
 * Canonical Master Intake business identity: normalized novel title +
 * canonical episode span. This is the ONLY identity that decides whether an
 * intake row is "the same Novel / Episode Pack" as a previous sync.
 *
 * Deliberately EXCLUDED from business identity: rowNumber, spreadsheet/sheet
 * metadata, translationDocumentId/Url, webSourceUrl, prepared source
 * document/Url. Those belong to provenance/audit and to the row/source
 * fingerprint (masterIntakeRowFingerprint) — changing a source document must
 * never turn the same Episode Pack into an identity conflict.
 */
export function canonicalMasterIntakeIdentity(input: {
  normalizedTitle: string;
  episodeNumber: string;
}): MasterIntakeCanonicalIdentity | null {
  const span = parseMasterIntakeEpisodeSpan(input.episodeNumber);
  const normalizedTitle = normalizeSpace(String(input.normalizedTitle ?? ""));
  if (!span || !normalizedTitle) return null;
  return {
    version: "workspace-master-intake-identity-v2",
    normalizedTitle,
    episodeStart: span.start,
    episodeEnd: span.end,
  };
}

/** Deterministic fingerprint of the canonical business identity, or null when malformed. */
export function canonicalMasterIntakeIdentityFingerprint(input: {
  normalizedTitle: string;
  episodeNumber: string;
}): string | null {
  const identity = canonicalMasterIntakeIdentity(input);
  if (!identity) return null;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * Canonicalize an observed active-source key set: unique, trimmed, sorted —
 * so the same source set in a different DB order yields the same
 * fingerprint (no false STALE_PREVIEW) while any membership change is
 * detected. Keys use the same stable identity `importEditorialSource` uses
 * for SOURCE_CONFLICT decisions: `<sourceKind>:<sourceKey>`.
 */
export function canonicalizeActiveSourceKeys(keys: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(keys.map((key) => String(key ?? "").trim()).filter((key) => key.length > 0))
  ).sort();
}

export function masterIntakeRowIdentityFingerprint(row: MasterIntakeRowCanonical): string {
  const fingerprint = canonicalMasterIntakeIdentityFingerprint({
    normalizedTitle: row.normalizedTitle,
    episodeNumber: row.episodeNumber,
  });
  if (!fingerprint) {
    throw new Error("Master Intake canonical identity is invalid.");
  }
  return fingerprint;
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
        preparedSourceDocUrl: row.preparedSourceDocUrl?.trim() ?? null,
      })
    )
    .digest("hex");
}

export function masterIntakeProvenancePreviewStatus(input: {
  hasBlockers: boolean;
  rowUnchanged: boolean;
  sourceAlreadyLinked: boolean;
  workspaceNovelActive: boolean;
}) {
  if (input.hasBlockers) return "CONFLICT" as const;
  return input.rowUnchanged &&
    input.sourceAlreadyLinked &&
    input.workspaceNovelActive
    ? ("UNCHANGED" as const)
    : ("UPDATED" as const);
}

export function masterIntakePreviewFingerprint(input: {
  workspaceId: number;
  startRow: number;
  endRow: number;
  rows: Array<{
    rowNumber: number;
    rowFingerprint: string;
    status: string;
    existingNovelId?: number | null;
    workspaceNovelId?: number | null;
    workItemId?: number | null;
    provenanceId?: number | null;
    provenanceRowNumber?: number | null;
    blockers?: string[];
    sourceAlreadyLinked?: boolean;
    sourceReplacementExpected?: boolean;
    /** Canonical `<sourceKind>:<sourceKey>` set observed active at preview time. */
    observedActiveSourceKeys?: string[];
    /** IPE-061: how this row's provenance was classified during preview. */
    provenanceDisposition?: "SAME_IDENTITY" | "REBOUND" | "ROW_REUSED" | "NONE";
    /** Stale at-row locator (different identity) pending reconcile in sync. */
    reconcileStaleProvenanceId?: number | null;
    /** IPE-061R2: canonical identity of that stale locator at preview time. */
    reconcileStaleProvenanceIdentityFingerprint?: string | null;
  }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "workspace-master-intake-preview-v6",
        workspaceId: input.workspaceId,
        startRow: input.startRow,
        endRow: input.endRow,
        rows: input.rows.map(row => ({
          rowNumber: row.rowNumber,
          rowFingerprint: row.rowFingerprint,
          status: row.status,
          existingNovelId: row.existingNovelId ?? null,
          workspaceNovelId: row.workspaceNovelId ?? null,
          workItemId: row.workItemId ?? null,
          provenanceId: row.provenanceId ?? null,
          provenanceRowNumber: row.provenanceRowNumber ?? null,
          blockers: [...(row.blockers ?? [])].sort(),
          sourceAlreadyLinked: row.sourceAlreadyLinked === true,
          sourceReplacementExpected: row.sourceReplacementExpected === true,
          provenanceDisposition: row.provenanceDisposition ?? "NONE",
          reconcileStaleProvenanceId: row.reconcileStaleProvenanceId ?? null,
          reconcileStaleProvenanceIdentityFingerprint:
            row.reconcileStaleProvenanceIdentityFingerprint ?? null,
          // Binding the preview to the exact observed active-source state is
          // what makes a replacement authorization stale-safe: [A] and [C]
          // must never produce the same fingerprint.
          observedActiveSourceKeys: canonicalizeActiveSourceKeys(row.observedActiveSourceKeys ?? []),
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
