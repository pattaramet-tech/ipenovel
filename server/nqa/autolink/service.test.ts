import { describe, expect, it } from "vitest";

import { InMemoryNqaNovelIdAutolinkAuditStore } from "./audit";
import type {
  NqaNovelCatalogCandidate,
  NqaNovelCatalogReader,
  NqaNovelIdSheetBackfillTransport,
  NqaNovelIdSheetRowIdentity,
} from "./contracts";
import { NqaNovelIdAutolinkError, NqaNovelIdAutolinkService } from "./service";

const CONFIG = {
  spreadsheetId: "sheet-รวมนิยาย",
  spreadsheetTitle: "รวมนิยาย",
  sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
  authorizationTtlSeconds: 300,
};

function candidate(novelId: number, title: string): NqaNovelCatalogCandidate {
  return {
    novelId,
    title,
    slug: "novel-" + novelId,
    author: null,
    publicationStatus: "published",
  };
}

class FakeCatalog implements NqaNovelCatalogReader {
  constructor(
    private searchResults: NqaNovelCatalogCandidate[],
    private byId: Map<number, NqaNovelCatalogCandidate> = new Map()
  ) {
    for (const item of searchResults) {
      if (!this.byId.has(item.novelId)) this.byId.set(item.novelId, item);
    }
  }

  async searchByTitle(): Promise<NqaNovelCatalogCandidate[]> {
    return structuredClone(this.searchResults);
  }

  async getById(novelId: number): Promise<NqaNovelCatalogCandidate | null> {
    return structuredClone(this.byId.get(novelId) ?? null);
  }
}

class FakeSheetTransport implements NqaNovelIdSheetBackfillTransport {
  readonly writeCalls: Array<{
    spreadsheetId: string;
    sheetName: string;
    row: number;
    novelId: number;
  }> = [];
  readCount = 0;
  mutateOnRead:
    ((readCount: number, row: NqaNovelIdSheetRowIdentity) => void) | null =
    null;

  constructor(readonly rows: Map<number, NqaNovelIdSheetRowIdentity>) {}

  async readRowIdentity(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
  }): Promise<NqaNovelIdSheetRowIdentity> {
    const row = this.rows.get(input.row);
    if (!row) throw new Error("missing fixture row");
    this.readCount += 1;
    this.mutateOnRead?.(this.readCount, row);
    return structuredClone(row);
  }

  async writeNovelId(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
    novelId: number;
  }) {
    this.writeCalls.push({ ...input });
    const row = this.rows.get(input.row);
    if (!row) throw new Error("missing fixture row");
    row.novelIdCell = String(input.novelId);
    return {
      updatedRange: "'" + input.sheetName + "'!A" + input.row,
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    };
  }
}

function row(
  input: {
    row?: number;
    novelIdCell?: string | null;
    novelTitle?: string | null;
    spreadsheetTitle?: string;
    sheetName?: string;
  } = {}
): NqaNovelIdSheetRowIdentity {
  return {
    spreadsheetId: CONFIG.spreadsheetId,
    spreadsheetTitle: input.spreadsheetTitle ?? CONFIG.spreadsheetTitle,
    sheetName: input.sheetName ?? CONFIG.sheetName,
    row: input.row ?? 1744,
    novelIdCell: input.novelIdCell ?? null,
    novelTitle:
      input.novelTitle ??
      "นารูโตะ: ระบบนักรับจ้าง โลกนินจาไม่มีศัตรู มีแต่ลูกค้า 081 - 130",
  };
}

function makeService(input: {
  sheet?: FakeSheetTransport;
  catalog?: FakeCatalog;
}) {
  const sheet = input.sheet ?? new FakeSheetTransport(new Map([[1744, row()]]));
  const catalog =
    input.catalog ??
    new FakeCatalog([
      candidate(
        812,
        "นารูโตะ: ระบบนักรับจ้าง โลกนินจาไม่มีศัตรู มีแต่ลูกค้า 081 - 130"
      ),
    ]);
  const audit = new InMemoryNqaNovelIdAutolinkAuditStore();
  const service = new NqaNovelIdAutolinkService({
    transport: sheet,
    catalog,
    auditStore: audit,
    config: CONFIG,
    now: () => "2026-09-25T21:00:00+07:00",
  });
  return { service, sheet, catalog, audit };
}

describe("NQA Novel ID Auto-Link + Column A Backfill Gate", () => {
  it("previews one deterministic normalized exact title match without writing", async () => {
    const sheet = new FakeSheetTransport(
      new Map([
        [
          1744,
          row({
            novelTitle:
              "  นารูโตะ: ระบบนักรับจ้าง โลกนินจาไม่มีศัตรู มีแต่ลูกค้า 081 - 130  ",
          }),
        ],
      ])
    );
    const { service } = makeService({
      sheet,
      catalog: new FakeCatalog([
        candidate(
          812,
          "นารูโตะ: ระบบนักรับจ้าง  โลกนินจาไม่มีศัตรู มีแต่ลูกค้า 081 - 130"
        ),
        candidate(999, "เรื่องอื่น"),
      ]),
    });

    const preview = await service.previewRow(1744);

    expect(preview).toMatchObject({
      status: "MATCH",
      matchedNovelId: 812,
      existingNovelId: null,
      spreadsheetTitle: "รวมนิยาย",
      sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
      row: 1744,
    });
    expect(preview.candidates.map(item => item.novelId)).toEqual([812]);
    expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sheet.writeCalls).toEqual([]);
  });

  it("returns NO_MATCH and AMBIGUOUS deterministically without mutation", async () => {
    const noMatch = makeService({
      catalog: new FakeCatalog([candidate(1, "คนละเรื่อง")]),
    });
    await expect(noMatch.service.previewRow(1744)).resolves.toMatchObject({
      status: "NO_MATCH",
      matchedNovelId: null,
    });
    expect(noMatch.sheet.writeCalls).toEqual([]);

    const title = row().novelTitle!;
    const ambiguous = makeService({
      catalog: new FakeCatalog([
        candidate(10, title),
        candidate(9, title),
        candidate(9, title),
      ]),
    });
    const preview = await ambiguous.service.previewRow(1744);
    expect(preview.status).toBe("AMBIGUOUS");
    expect(preview.candidates.map(item => item.novelId)).toEqual([9, 10]);
    expect(ambiguous.sheet.writeCalls).toEqual([]);
  });

  it("refuses to match or overwrite an already-linked or invalid Column A value", async () => {
    const linkedSheet = new FakeSheetTransport(
      new Map([[1744, row({ novelIdCell: "812" })]])
    );
    const linked = makeService({ sheet: linkedSheet });
    await expect(linked.service.previewRow(1744)).resolves.toMatchObject({
      status: "ALREADY_LINKED",
      existingNovelId: 812,
      matchedNovelId: null,
    });

    const invalidSheet = new FakeSheetTransport(
      new Map([[1744, row({ novelIdCell: "manual-note" })]])
    );
    const invalid = makeService({ sheet: invalidSheet });
    await expect(invalid.service.previewRow(1744)).resolves.toMatchObject({
      status: "INVALID_EXISTING_VALUE",
      existingNovelId: null,
    });
    expect(linkedSheet.writeCalls).toEqual([]);
    expect(invalidSheet.writeCalls).toEqual([]);
  });

  it("requires exact configured spreadsheet and tab identity", async () => {
    const wrong = makeService({
      sheet: new FakeSheetTransport(
        new Map([
          [
            1744,
            row({
              spreadsheetTitle: "สำเนา รวมนิยาย",
            }),
          ],
        ])
      ),
    });

    await expect(wrong.service.previewRow(1744)).rejects.toMatchObject({
      code: "SPREADSHEET_TITLE_MISMATCH",
    });
  });

  it("human-confirmed backfill writes only the matched novelId and returns a Workspace Sync-ready handoff", async () => {
    const { service, sheet, audit } = makeService({});
    const preview = await service.previewRow(1744);

    const result = await service.confirmBackfill({
      row: 1744,
      novelId: 812,
      previewFingerprint: preview.previewFingerprint,
      authorizationId: "confirm-row-1744",
      authorizerId: "workspace-admin-7",
    });

    expect(sheet.writeCalls).toEqual([
      {
        spreadsheetId: CONFIG.spreadsheetId,
        sheetName: CONFIG.sheetName,
        row: 1744,
        novelId: 812,
      },
    ]);
    expect(result).toMatchObject({
      status: "BACKFILLED",
      row: 1744,
      novelId: 812,
      syncHandoff: {
        status: "SYNC_READY",
        row: 1744,
        novelId: 812,
        canonicalIdentity: "novel:812",
      },
    });
    expect(result.syncHandoff.sourceKey).toContain(":1744");
    expect(result.auditFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const records = await audit.list();
    expect(records.map(record => record.kind)).toEqual([
      "PREVIEW_CREATED",
      "CONFIRMATION_ACCEPTED",
      "BACKFILL_COMMITTED",
    ]);
    expect(records.at(-1)).toMatchObject({
      novelId: 812,
      authorizationId: "confirm-row-1744",
      authorizerId: "workspace-admin-7",
      reason: null,
    });
  });

  it("fails closed when the preview became stale before confirmation", async () => {
    const { service, sheet, audit } = makeService({});
    const preview = await service.previewRow(1744);
    sheet.rows.get(1744)!.novelIdCell = "900";

    await expect(
      service.confirmBackfill({
        row: 1744,
        novelId: 812,
        previewFingerprint: preview.previewFingerprint,
        authorizationId: "stale-confirm",
        authorizerId: "workspace-admin-7",
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(sheet.writeCalls).toEqual([]);
    expect((await audit.list()).at(-1)).toMatchObject({
      kind: "BACKFILL_REJECTED",
      reason: "STALE_PREVIEW",
    });
  });

  it("rechecks A and B immediately before write and rejects a last-moment row race", async () => {
    const { service, sheet } = makeService({});
    const preview = await service.previewRow(1744);
    sheet.mutateOnRead = (readCount, liveRow) => {
      if (readCount === 3) liveRow.novelIdCell = "901";
    };

    await expect(
      service.confirmBackfill({
        row: 1744,
        novelId: 812,
        previewFingerprint: preview.previewFingerprint,
        authorizationId: "race-confirm",
        authorizerId: "workspace-admin-7",
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(sheet.writeCalls).toEqual([]);
  });

  it("rejects confirmation for a novelId different from the unique preview candidate", async () => {
    const { service, sheet } = makeService({});
    const preview = await service.previewRow(1744);

    await expect(
      service.confirmBackfill({
        row: 1744,
        novelId: 999,
        previewFingerprint: preview.previewFingerprint,
        authorizationId: "wrong-novel",
        authorizerId: "workspace-admin-7",
      })
    ).rejects.toMatchObject({ code: "NOVEL_ID_MISMATCH" });
    expect(sheet.writeCalls).toEqual([]);
  });

  it("fails closed if the catalog candidate changed after preview", async () => {
    const title = row().novelTitle!;
    const catalog = new FakeCatalog([candidate(812, title)]);
    const { service, sheet } = makeService({ catalog });
    const preview = await service.previewRow(1744);
    (catalog as any).byId.set(812, candidate(812, "ชื่อถูกแก้ภายหลัง"));

    await expect(
      service.confirmBackfill({
        row: 1744,
        novelId: 812,
        previewFingerprint: preview.previewFingerprint,
        authorizationId: "catalog-changed",
        authorizerId: "workspace-admin-7",
      })
    ).rejects.toMatchObject({ code: "CATALOG_CHANGED" });
    expect(sheet.writeCalls).toEqual([]);
  });

  it("uses typed autolink errors", () => {
    const error = new NqaNovelIdAutolinkError("STALE_PREVIEW", "stale");
    expect(error.name).toBe("NqaNovelIdAutolinkError");
  });
});
