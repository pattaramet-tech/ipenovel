import { hashCanonicalJson } from "../core";
import {
  NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
  type NqaNovelIdAutolinkAuditStore,
} from "./audit";
import {
  NQA_NOVEL_ID_AUTOLINK_VERSION,
  NQA_NOVEL_ID_BACKFILL_AUTHORIZATION_VERSION,
  NqaNovelIdAutolinkConfigSchema,
  type NqaNovelCatalogReader,
  type NqaNovelIdAutolinkConfig,
  type NqaNovelIdAutolinkPreview,
  type NqaNovelIdBackfillAuthorization,
  type NqaNovelIdBackfillResult,
  type NqaNovelIdSheetBackfillTransport,
  type NqaNovelIdSheetRowIdentity,
} from "./contracts";
import {
  exactNqaNovelTitleCandidates,
  normalizeNqaNovelTitle,
} from "./matcher";

export type NqaNovelIdAutolinkErrorCode =
  | "SPREADSHEET_ID_MISMATCH"
  | "SPREADSHEET_TITLE_MISMATCH"
  | "SHEET_NAME_MISMATCH"
  | "PREVIEW_NOT_MATCHABLE"
  | "STALE_PREVIEW"
  | "NOVEL_ID_MISMATCH"
  | "AUTHORIZATION_INVALID"
  | "AUTHORIZATION_EXPIRED"
  | "CATALOG_CHANGED"
  | "WRITE_VERIFICATION_FAILED";

export class NqaNovelIdAutolinkError extends Error {
  constructor(
    readonly code: NqaNovelIdAutolinkErrorCode,
    message: string
  ) {
    super(message);
    this.name = "NqaNovelIdAutolinkError";
  }
}

function parseExistingNovelId(value: string | null): {
  status: "EMPTY" | "VALID" | "INVALID";
  novelId: number | null;
} {
  if (!value) return { status: "EMPTY", novelId: null };
  if (!/^\d+$/.test(value)) return { status: "INVALID", novelId: null };
  const novelId = Number(value);
  return Number.isSafeInteger(novelId) && novelId > 0
    ? { status: "VALID", novelId }
    : { status: "INVALID", novelId: null };
}

function stablePreviewFingerprint(
  preview: Omit<NqaNovelIdAutolinkPreview, "createdAt" | "previewFingerprint">
): string {
  return hashCanonicalJson({
    scope: "nqa:novel-id-autolink-preview:v1",
    ...preview,
  });
}

function authorizationFingerprint(
  authorization: Omit<
    NqaNovelIdBackfillAuthorization,
    "authorizationFingerprint"
  >
): string {
  return hashCanonicalJson({
    scope: "nqa:novel-id-backfill-authorization:v1",
    ...authorization,
  });
}

function addSeconds(iso: string, seconds: number): string {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) {
    throw new NqaNovelIdAutolinkError(
      "AUTHORIZATION_INVALID",
      "NQA novel-id backfill confirmation time is invalid."
    );
  }
  return new Date(value + seconds * 1000).toISOString();
}

export class NqaNovelIdAutolinkService {
  private readonly config: NqaNovelIdAutolinkConfig;
  private readonly now: () => string;

  constructor(
    private readonly dependencies: {
      transport: NqaNovelIdSheetBackfillTransport;
      catalog: NqaNovelCatalogReader;
      auditStore: NqaNovelIdAutolinkAuditStore;
      config: NqaNovelIdAutolinkConfig;
      now?: () => string;
    }
  ) {
    this.config = NqaNovelIdAutolinkConfigSchema.parse(dependencies.config);
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private assertRowScope(row: NqaNovelIdSheetRowIdentity): void {
    if (row.spreadsheetId !== this.config.spreadsheetId) {
      throw new NqaNovelIdAutolinkError(
        "SPREADSHEET_ID_MISMATCH",
        "NQA novel-id backfill spreadsheet identity mismatch."
      );
    }
    if (row.spreadsheetTitle !== this.config.spreadsheetTitle) {
      throw new NqaNovelIdAutolinkError(
        "SPREADSHEET_TITLE_MISMATCH",
        "NQA novel-id backfill spreadsheet title mismatch."
      );
    }
    if (row.sheetName !== this.config.sheetName) {
      throw new NqaNovelIdAutolinkError(
        "SHEET_NAME_MISMATCH",
        "NQA novel-id backfill sheet tab mismatch."
      );
    }
  }

  private async buildPreview(
    rowNumber: number
  ): Promise<NqaNovelIdAutolinkPreview> {
    const row = await this.dependencies.transport.readRowIdentity({
      spreadsheetId: this.config.spreadsheetId,
      sheetName: this.config.sheetName,
      row: rowNumber,
    });
    this.assertRowScope(row);

    const existing = parseExistingNovelId(row.novelIdCell);
    const novelTitle = row.novelTitle?.trim() || null;
    const normalizedNovelTitle = novelTitle
      ? normalizeNqaNovelTitle(novelTitle)
      : null;

    let status: NqaNovelIdAutolinkPreview["status"];
    let candidates: NqaNovelIdAutolinkPreview["candidates"] = [];
    let matchedNovelId: number | null = null;

    if (existing.status === "VALID") {
      status = "ALREADY_LINKED";
    } else if (existing.status === "INVALID") {
      status = "INVALID_EXISTING_VALUE";
    } else if (!novelTitle) {
      status = "MISSING_TITLE";
    } else {
      const searched =
        await this.dependencies.catalog.searchByTitle(novelTitle);
      candidates = exactNqaNovelTitleCandidates({
        novelTitle,
        candidates: searched,
      });
      if (candidates.length === 1) {
        status = "MATCH";
        matchedNovelId = candidates[0].novelId;
      } else if (candidates.length > 1) {
        status = "AMBIGUOUS";
      } else {
        status = "NO_MATCH";
      }
    }

    const stable = {
      version: NQA_NOVEL_ID_AUTOLINK_VERSION,
      spreadsheetId: row.spreadsheetId,
      spreadsheetTitle: row.spreadsheetTitle!,
      sheetName: row.sheetName,
      row: row.row,
      novelTitle,
      normalizedNovelTitle,
      currentNovelIdCell: row.novelIdCell,
      existingNovelId: existing.novelId,
      status,
      candidates,
      matchedNovelId,
    };
    const createdAt = this.now();
    return {
      ...stable,
      createdAt,
      previewFingerprint: stablePreviewFingerprint(stable),
    };
  }

  async previewRow(row: number): Promise<NqaNovelIdAutolinkPreview> {
    const preview = await this.buildPreview(row);
    await this.dependencies.auditStore.append({
      auditVersion: NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
      eventId: "preview-" + preview.row + "-" + preview.createdAt,
      kind: "PREVIEW_CREATED",
      spreadsheetId: preview.spreadsheetId,
      sheetName: preview.sheetName,
      row: preview.row,
      previewFingerprint: preview.previewFingerprint,
      novelId: preview.matchedNovelId ?? preview.existingNovelId,
      authorizationId: null,
      authorizerId: null,
      authorizationFingerprint: null,
      previewStatus: preview.status,
      writeReceipt: null,
      reason: null,
      createdAt: preview.createdAt,
    });
    return preview;
  }

  private buildAuthorization(input: {
    preview: NqaNovelIdAutolinkPreview;
    novelId: number;
    authorizationId: string;
    authorizerId: string;
    approvedAt: string;
  }): NqaNovelIdBackfillAuthorization {
    if (
      input.preview.status !== "MATCH" ||
      input.preview.matchedNovelId !== input.novelId ||
      !input.preview.novelTitle ||
      !input.preview.normalizedNovelTitle
    ) {
      throw new NqaNovelIdAutolinkError(
        "PREVIEW_NOT_MATCHABLE",
        "NQA novel-id backfill requires a unique MATCH preview."
      );
    }

    const base = {
      authorizationVersion: NQA_NOVEL_ID_BACKFILL_AUTHORIZATION_VERSION,
      authorizationId: input.authorizationId,
      authorizerId: input.authorizerId,
      approvalStatement: "I_CONFIRM_NQA_NOVEL_ID_BACKFILL" as const,
      spreadsheetId: input.preview.spreadsheetId,
      spreadsheetTitle: input.preview.spreadsheetTitle,
      sheetName: input.preview.sheetName,
      row: input.preview.row,
      novelTitle: input.preview.novelTitle,
      normalizedNovelTitle: input.preview.normalizedNovelTitle,
      previewFingerprint: input.preview.previewFingerprint,
      novelId: input.novelId,
      approvedAt: input.approvedAt,
      validUntil: addSeconds(
        input.approvedAt,
        this.config.authorizationTtlSeconds
      ),
    };
    return {
      ...base,
      authorizationFingerprint: authorizationFingerprint(base),
    };
  }

  private verifyAuthorization(
    authorization: NqaNovelIdBackfillAuthorization,
    committedAt: string
  ): void {
    const { authorizationFingerprint: supplied, ...base } = authorization;
    if (supplied !== authorizationFingerprint(base)) {
      throw new NqaNovelIdAutolinkError(
        "AUTHORIZATION_INVALID",
        "NQA novel-id backfill authorization fingerprint mismatch."
      );
    }

    const approved = Date.parse(authorization.approvedAt);
    const expires = Date.parse(authorization.validUntil);
    const committed = Date.parse(committedAt);
    if (
      !Number.isFinite(approved) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(committed) ||
      committed < approved ||
      committed > expires
    ) {
      throw new NqaNovelIdAutolinkError(
        "AUTHORIZATION_EXPIRED",
        "NQA novel-id backfill authorization is outside its validity window."
      );
    }
  }

  async confirmBackfill(input: {
    row: number;
    novelId: number;
    previewFingerprint: string;
    authorizationId: string;
    authorizerId: string;
  }): Promise<NqaNovelIdBackfillResult> {
    const preview = await this.buildPreview(input.row);
    if (preview.previewFingerprint !== input.previewFingerprint) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        reason: "STALE_PREVIEW",
      });
      throw new NqaNovelIdAutolinkError(
        "STALE_PREVIEW",
        "NQA novel-id backfill preview is stale."
      );
    }
    if (preview.status !== "MATCH" || preview.matchedNovelId === null) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        reason: "PREVIEW_NOT_MATCHABLE",
      });
      throw new NqaNovelIdAutolinkError(
        "PREVIEW_NOT_MATCHABLE",
        "NQA novel-id backfill preview is not a unique match."
      );
    }
    if (preview.matchedNovelId !== input.novelId) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        reason: "NOVEL_ID_MISMATCH",
      });
      throw new NqaNovelIdAutolinkError(
        "NOVEL_ID_MISMATCH",
        "Confirmed novelId does not match the preview candidate."
      );
    }

    const approvedAt = this.now();
    const authorization = this.buildAuthorization({
      preview,
      novelId: input.novelId,
      authorizationId: input.authorizationId,
      authorizerId: input.authorizerId,
      approvedAt,
    });
    const committedAt = this.now();
    this.verifyAuthorization(authorization, committedAt);

    const catalogNovel = await this.dependencies.catalog.getById(input.novelId);
    if (
      !catalogNovel ||
      normalizeNqaNovelTitle(catalogNovel.title) !==
        preview.normalizedNovelTitle
    ) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        authorizationFingerprint: authorization.authorizationFingerprint,
        reason: "CATALOG_CHANGED",
      });
      throw new NqaNovelIdAutolinkError(
        "CATALOG_CHANGED",
        "Matched novel changed before backfill confirmation."
      );
    }

    const beforeWrite = await this.dependencies.transport.readRowIdentity({
      spreadsheetId: this.config.spreadsheetId,
      sheetName: this.config.sheetName,
      row: preview.row,
    });
    this.assertRowScope(beforeWrite);
    if (
      beforeWrite.novelIdCell !== null ||
      !beforeWrite.novelTitle ||
      normalizeNqaNovelTitle(beforeWrite.novelTitle) !==
        preview.normalizedNovelTitle
    ) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        authorizationFingerprint: authorization.authorizationFingerprint,
        reason: "STALE_PREVIEW",
      });
      throw new NqaNovelIdAutolinkError(
        "STALE_PREVIEW",
        "NQA novel-id backfill row changed after confirmation."
      );
    }

    await this.dependencies.auditStore.append({
      auditVersion: NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
      eventId: "confirm-" + authorization.authorizationId,
      kind: "CONFIRMATION_ACCEPTED",
      spreadsheetId: preview.spreadsheetId,
      sheetName: preview.sheetName,
      row: preview.row,
      previewFingerprint: preview.previewFingerprint,
      novelId: input.novelId,
      authorizationId: authorization.authorizationId,
      authorizerId: authorization.authorizerId,
      authorizationFingerprint: authorization.authorizationFingerprint,
      previewStatus: preview.status,
      writeReceipt: null,
      reason: null,
      createdAt: committedAt,
    });

    const receipt = await this.dependencies.transport.writeNovelId({
      spreadsheetId: this.config.spreadsheetId,
      sheetName: this.config.sheetName,
      row: preview.row,
      novelId: input.novelId,
    });

    const after = await this.dependencies.transport.readRowIdentity({
      spreadsheetId: this.config.spreadsheetId,
      sheetName: this.config.sheetName,
      row: preview.row,
    });
    this.assertRowScope(after);
    const afterNovelId = parseExistingNovelId(after.novelIdCell);
    if (
      afterNovelId.status !== "VALID" ||
      afterNovelId.novelId !== input.novelId ||
      !after.novelTitle ||
      normalizeNqaNovelTitle(after.novelTitle) !== preview.normalizedNovelTitle
    ) {
      await this.rejectAudit({
        preview,
        novelId: input.novelId,
        authorizationFingerprint: authorization.authorizationFingerprint,
        reason: "WRITE_VERIFICATION_FAILED",
      });
      throw new NqaNovelIdAutolinkError(
        "WRITE_VERIFICATION_FAILED",
        "NQA novel-id Column A backfill could not be verified."
      );
    }

    const committedAudit = await this.dependencies.auditStore.append({
      auditVersion: NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
      eventId: "backfill-" + authorization.authorizationId,
      kind: "BACKFILL_COMMITTED",
      spreadsheetId: preview.spreadsheetId,
      sheetName: preview.sheetName,
      row: preview.row,
      previewFingerprint: preview.previewFingerprint,
      novelId: input.novelId,
      authorizationId: authorization.authorizationId,
      authorizerId: authorization.authorizerId,
      authorizationFingerprint: authorization.authorizationFingerprint,
      previewStatus: preview.status,
      writeReceipt: receipt,
      reason: null,
      createdAt: this.now(),
    });

    return {
      status: "BACKFILLED",
      row: preview.row,
      novelId: input.novelId,
      previewFingerprint: preview.previewFingerprint,
      authorizationFingerprint: authorization.authorizationFingerprint,
      writeReceipt: receipt,
      syncHandoff: {
        status: "SYNC_READY",
        row: preview.row,
        novelId: input.novelId,
        spreadsheetId: preview.spreadsheetId,
        sheetName: preview.sheetName,
        canonicalIdentity: "novel:" + input.novelId,
        sourceKey:
          "google-sheet:" +
          preview.spreadsheetId +
          ":" +
          preview.sheetName +
          ":" +
          preview.row,
        backfillAuditFingerprint: committedAudit.eventFingerprint,
      },
      auditFingerprint: committedAudit.eventFingerprint,
    };
  }

  private async rejectAudit(input: {
    preview: NqaNovelIdAutolinkPreview;
    novelId: number;
    authorizationFingerprint?: string;
    reason: string;
  }): Promise<void> {
    await this.dependencies.auditStore.append({
      auditVersion: NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
      eventId:
        "reject-" + input.preview.row + "-" + this.now() + "-" + input.reason,
      kind: "BACKFILL_REJECTED",
      spreadsheetId: input.preview.spreadsheetId,
      sheetName: input.preview.sheetName,
      row: input.preview.row,
      previewFingerprint: input.preview.previewFingerprint,
      novelId: input.novelId,
      authorizationId: null,
      authorizerId: null,
      authorizationFingerprint: input.authorizationFingerprint ?? null,
      previewStatus: input.preview.status,
      writeReceipt: null,
      reason: input.reason,
      createdAt: this.now(),
    });
  }
}
