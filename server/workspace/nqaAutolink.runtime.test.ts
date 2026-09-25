import { describe, expect, it } from "vitest";

import { InMemoryNqaNovelIdAutolinkAuditStore } from "../nqa/autolink/audit";
import type {
  NqaNovelCatalogCandidate,
  NqaNovelCatalogReader,
  NqaNovelIdSheetBackfillTransport,
  NqaNovelIdSheetRowIdentity,
} from "../nqa/autolink/contracts";
import {
  NQA_AUTOLINK_LIVE_TARGET,
  NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE,
  createWorkspaceNqaAutolinkRuntime,
  resolveWorkspaceNqaAutolinkRuntimeStatus,
} from "./nqaAutolink.runtime";
import { NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE } from "../nqa/autolink/googleTransport";

const TITLE = "นารูโตะ: ระบบค่าความชำนาญ ฝึกซ้ำจนไร้ขีดจำกัด 201 - 250";

function env(
  input: {
    remediation?: boolean;
    readToken?: string;
    writeToken?: string;
    readScopes?: string;
    writeScopes?: string;
    spreadsheetId?: string;
    auditDir?: string;
  } = {}
) {
  return {
    NQA_AUTOLINK_SPREADSHEET_ID:
      input.spreadsheetId ?? NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN: input.readToken ?? "readonly-token",
    NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES:
      input.readScopes ?? NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE,
    NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN: input.writeToken ?? "write-token",
    NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES:
      input.writeScopes ?? NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE,
    NQA_AUTOLINK_AUDIT_DIR: input.auditDir ?? "C:\\runtime\\nqa-autolink-audit",
    NQA_AUTOLINK_REMEDIATION_ENABLED: input.remediation ? "true" : "false",
  };
}

class Catalog implements NqaNovelCatalogReader {
  private readonly novel: NqaNovelCatalogCandidate = {
    novelId: 812,
    title: TITLE,
    slug: "nqa-live-pilot",
    author: null,
    publicationStatus: "published",
  };

  async searchByTitle(): Promise<NqaNovelCatalogCandidate[]> {
    return [structuredClone(this.novel)];
  }

  async getById(novelId: number): Promise<NqaNovelCatalogCandidate | null> {
    return novelId === this.novel.novelId ? structuredClone(this.novel) : null;
  }
}

class SheetTransport implements NqaNovelIdSheetBackfillTransport {
  readonly writes: number[] = [];
  readonly row: NqaNovelIdSheetRowIdentity = {
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    spreadsheetTitle: NQA_AUTOLINK_LIVE_TARGET.spreadsheetTitle,
    sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
    row: 1751,
    novelIdCell: null,
    novelTitle: TITLE,
  };

  async readRowIdentity(): Promise<NqaNovelIdSheetRowIdentity> {
    return structuredClone(this.row);
  }

  async writeNovelId(input: { novelId: number }) {
    this.writes.push(input.novelId);
    this.row.novelIdCell = String(input.novelId);
    return {
      updatedRange: "'" + NQA_AUTOLINK_LIVE_TARGET.sheetName + "'!A1751",
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    };
  }
}

describe("Workspace NQA Novel ID Auto-Link composition", () => {
  it("fails status closed when runtime configuration is absent", () => {
    const status = resolveWorkspaceNqaAutolinkRuntimeStatus({});
    expect(status.previewReady).toBe(false);
    expect(status.confirmReady).toBe(false);
    expect(status.remediationEnabled).toBe(false);
    expect(status.previewBlockers).toEqual(
      expect.arrayContaining([
        "TARGET_SPREADSHEET_ID_NOT_CONFIGURED",
        "READ_CREDENTIAL_MISSING",
        "READ_SCOPE_MISSING",
        "AUDIT_DIR_MISSING",
      ])
    );
    expect(status.confirmBlockers).toEqual(
      expect.arrayContaining([
        "REMEDIATION_DISABLED",
        "WRITE_CREDENTIAL_MISSING",
        "WRITE_SCOPE_MISSING",
      ])
    );
  });

  it("rejects any configured spreadsheet ID except the live-bound รวมนิยาย ID", () => {
    const status = resolveWorkspaceNqaAutolinkRuntimeStatus(
      env({ spreadsheetId: "wrong-sheet" })
    );
    expect(status.previewReady).toBe(false);
    expect(status.confirmReady).toBe(false);
    expect(status.previewBlockers).toContain("TARGET_SPREADSHEET_ID_MISMATCH");
  });

  it("requires distinct read and write credentials", () => {
    const status = resolveWorkspaceNqaAutolinkRuntimeStatus(
      env({
        remediation: true,
        readToken: "same-token",
        writeToken: "same-token",
      })
    );
    expect(status.previewReady).toBe(true);
    expect(status.confirmReady).toBe(false);
    expect(status.confirmBlockers).toContain(
      "READ_WRITE_CREDENTIALS_NOT_DISTINCT"
    );
  });

  it("routes preview through the real gateway with READ while performing no write", async () => {
    const readTransport = new SheetTransport();
    const writeTransport = new SheetTransport();
    const runtime = createWorkspaceNqaAutolinkRuntime({
      env: env(),
      catalog: new Catalog(),
      readTransport,
      writeTransport,
      auditStore: new InMemoryNqaNovelIdAutolinkAuditStore(),
      now: () => "2026-09-25T21:30:00+07:00",
      requestIdFactory: () => "preview-live-1751",
    });

    const response = await runtime.preview({
      actorUserId: 7,
      row: 1751,
      correlationId: "pilot-1751",
    });

    expect(response.status).toBe("OK");
    expect(response.authorization).toMatchObject({
      allowed: true,
      requiredPermission: "READ",
    });
    expect(response.result).toMatchObject({
      status: "MATCH",
      row: 1751,
      matchedNovelId: 812,
    });
    expect(readTransport.writes).toEqual([]);
    expect(writeTransport.writes).toEqual([]);
  });

  it("keeps confirmation TIER_DISABLED by default even for an authenticated Workspace admin", async () => {
    const readTransport = new SheetTransport();
    const writeTransport = new SheetTransport();
    const runtime = createWorkspaceNqaAutolinkRuntime({
      env: env(),
      catalog: new Catalog(),
      readTransport,
      writeTransport,
      auditStore: new InMemoryNqaNovelIdAutolinkAuditStore(),
      now: () => "2026-09-25T21:30:00+07:00",
      requestIdFactory: () => "confirm-disabled-1751",
    });

    const response = await runtime.confirmBackfill({
      actorUserId: 7,
      row: 1751,
      novelId: 812,
      previewFingerprint: "a".repeat(64),
    });

    expect(response).toMatchObject({
      status: "ERROR",
      error: { code: "TIER_DISABLED" },
      authorization: {
        allowed: false,
        requiredPermission: "REMEDIATION",
      },
    });
    expect(writeTransport.writes).toEqual([]);
  });

  it("allows an exact preview-bound backfill only after explicit remediation enablement and write scope", async () => {
    const readTransport = new SheetTransport();
    const writeTransport = new SheetTransport();
    const auditStore = new InMemoryNqaNovelIdAutolinkAuditStore();
    let id = 0;
    const runtime = createWorkspaceNqaAutolinkRuntime({
      env: env({ remediation: true }),
      catalog: new Catalog(),
      readTransport,
      writeTransport,
      auditStore,
      now: () => "2026-09-25T21:30:00+07:00",
      requestIdFactory: () => "request-" + ++id,
    });

    const preview = await runtime.preview({
      actorUserId: 7,
      row: 1751,
    });
    expect(preview.status).toBe("OK");
    const fingerprint = (preview.result as { previewFingerprint: string })
      .previewFingerprint;

    const result = await runtime.confirmBackfill({
      actorUserId: 7,
      row: 1751,
      novelId: 812,
      previewFingerprint: fingerprint,
    });

    expect(result.status).toBe("OK");
    expect(result.result).toMatchObject({
      status: "BACKFILLED",
      novelId: 812,
      syncHandoff: {
        status: "SYNC_READY",
        novelId: 812,
        canonicalIdentity: "novel:812",
      },
    });
    expect(writeTransport.writes).toEqual([812]);
  });

  it("does not let the write credential declaration substitute for the read-only preview scope", () => {
    const status = resolveWorkspaceNqaAutolinkRuntimeStatus(
      env({
        remediation: true,
        readScopes: NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE,
      })
    );
    expect(status.readScopeReady).toBe(false);
    expect(status.previewReady).toBe(false);
    expect(status.writeScopeReady).toBe(true);
  });
});
