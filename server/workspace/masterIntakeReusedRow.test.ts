// IPE-061 — Master Intake reused-row provenance reconciliation.
//
// Production defect: a Master Intake sheet row gets REUSED for a different
// novel/episode span (e.g. row 1597: Naruto+1251-1300 -> Football+1-40).
// The stale provenance record still sits at that rowNumber, and preview
// reported SYNC_IDENTITY_CHANGED even though the new business identity is
// valid and rowNumber is only a mutable sheet locator.
//
// Required classification:
//   CASE A  same identity / source changed   -> rebind (PR #98 behavior)
//   CASE B  identity moved to another row    -> provenance rebind to the new row
//   CASE C  true row reuse (old identity gone)-> normal NEW/existing path
//   CASE D  ambiguous / malformed            -> fail closed
//
// Database + Google transport are mocked, same harness style as
// masterIntake.identity.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  novels,
  workspaceAuditEvents,
  workspaceEditorialSources,
  workspaceEditorialWorkItems,
  workspaceMasterIntakeRows,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { NQA_AUTOLINK_LIVE_TARGET } from "./nqaAutolink.runtime";

const h = vi.hoisted(() => ({
  db: null as any,
  sheetRows: new Map<number, unknown[]>(),
}));

vi.mock("../db", () => ({
  getDb: async () => h.db,
}));

vi.mock("../nqa/google/transport", () => ({
  GoogleRestReadOnlyTransport: class {
    async getSpreadsheetMetadata() {
      return { sheets: [{ title: NQA_AUTOLINK_LIVE_TARGET.sheetName, sheetId: 42 }] };
    }
    async batchGetValues(input: { ranges: string[] }) {
      return input.ranges.map((range: string) => {
        const match = range.match(/!B(\d+):O(\d+)$/);
        const start = Number(match?.[1]);
        const end = Number(match?.[2]);
        const values: unknown[][] = [];
        for (let rowNumber = start; rowNumber <= end; rowNumber += 1) {
          values.push(h.sheetRows.get(rowNumber) ?? []);
        }
        return { values };
      });
    }
  },
}));

vi.mock("./adminAccess", () => ({
  requireWorkspacePlatformAdmin: vi.fn(async () => undefined),
}));

vi.mock("./service", () => ({
  bindPublicationNovel: vi.fn(async () => ({ workspaceNovelId: 888 })),
  createWorkspacePublicationNovel: vi.fn(async () => ({ novelId: 6, workspaceNovelId: 888 })),
}));

vi.mock("./editorialBoard.service", () => ({
  createEditorialEpisodeWorkItem: vi.fn(async (input: any) => ({
    created: true,
    board: {
      columns: [
        {
          cards: [
            {
              workItemType: "NEW_EPISODE",
              workspaceNovelId: input.workspaceNovelId,
              episodeNumber: input.episodeNumber,
              workItemId: 9001,
            },
          ],
        },
      ],
    },
  })),
}));

vi.mock("./editorialSource.googleDocs", () => ({
  fetchEditorialGoogleDocSource: vi.fn(async (_input: any) => ({
    sourceKind: "google_doc",
    sourceKey: "incoming-doc",
    providerDocumentId: "incoming-doc",
    mimeType: "text/html",
    title: "incoming doc",
    tabs: [{ sourceTabId: "t1", tabOrder: 1, title: "tab", paragraphs: ["body"] }],
  })),
}));

const importEditorialSource = vi.fn(async (_input: any) => ({
  sourceId: 1,
  sourceSnapshotId: 2,
  snapshotCreated: true,
  draftCreated: true,
  refreshBlocked: false,
  latestDraftId: 3,
  latestDraftVersion: 1,
  reason: "SOURCE_IMPORTED",
}));

vi.mock("./editorialDraft.service", () => ({
  importEditorialSource: (...args: any[]) => importEditorialSource(...(args as [any])),
}));

import { previewWorkspaceMasterIntake, syncWorkspaceMasterIntake } from "./masterIntake.service";

const DOC_A = "DocAAAAAAAAAAAAAAAAAAAAA1";
const DOC_B = "DocBBBBBBBBBBBBBBBBBBBBB2";
const DOC_FOOTBALL = "DocFootballBBBBBBBBBBBB2";
const DOC_DIAMOND = "DocDiamondAAAAAAAAAAAAA3";
const SHEET_ID = 42;

function sheetRowCells(input: {
  rawTitle: string;
  translationDocUrl: string;
  webSourceUrl?: string;
}) {
  const cells: unknown[] = new Array(14).fill("");
  cells[0] = input.rawTitle;
  cells[1] = input.translationDocUrl;
  cells[3] = input.webSourceUrl ?? "";
  return cells;
}

function provenanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    workspaceId: 1,
    workspaceNovelId: 777,
    workItemId: 55,
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    sheetId: SHEET_ID,
    sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
    rowNumber: 2,
    rawTitle: "เรื่องเดิม 1-30",
    normalizedTitle: "เรื่องเดิม",
    episodeNumber: "001-030",
    translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`,
    translationDocumentId: DOC_A,
    webSourceUrl: null,
    preparedSourceDocUrl: null,
    preparedSourceDocumentId: null,
    rowFingerprint: "old-fingerprint",
    lastSyncedByUserId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Shared resolver mirroring the real query shapes (object-identity routing,
// same as masterIntake.identity.test.ts).
function makeResolver(config: Record<string, any>) {
  return (state: { table: unknown; projection: any }): unknown[] => {
    const table = state.table;
    if (table === workspaceWorkspaces) return [config.workspace ?? { id: 1, status: "active" }];
    if (table === novels) return config.novels ?? [];
    if (table === workspaceNovels) return config.workspaceNovels ?? [];
    if (table === workspaceMasterIntakeRows) {
      if (config.__filterWorkspace) {
        return (config.provenance ?? []).filter((row: any) => row.workspaceId === 1);
      }
      return state.projection
        ? config.existingProvenanceRow
          ? [config.existingProvenanceRow]
          : []
        : config.provenance ?? [];
    }
    if (table === workspaceEditorialWorkItems) {
      return state.projection && "item" in state.projection
        ? config.activeItems ?? []
        : config.workItemLookup ?? [];
    }
    if (table === workspaceEditorialSources) return config.activeSources ?? [];
    return [];
  };
}

function makeDb(config: Record<string, any>) {
  const resolveRows = makeResolver(config);
  const calls = {
    updates: [] as Array<{ table: unknown; values: unknown }>,
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    deletes: [] as Array<{ table: unknown; where: unknown }>,
  };

  function resolveSelect(state: { table: unknown; projection: any }): unknown[] {
    const table = state.table;
    if (table === NQA_AUTOLINK_LIVE_TARGET) return [];
    if (config.tableOverrides?.has(table)) return config.tableOverrides.get(table).shift() ?? [];
    if (table === (config as any).workspaceTable) return [config.workspace ?? { id: 1, status: "active" }];
    return [];
  }
  void resolveSelect;

  const db: any = {
    select: (projection?: any) => {
      const state: { table: unknown; projection: any } = { table: null, projection: projection ?? null };
      const builder: any = {
        from: (table: unknown) => {
          state.table = table;
          return builder;
        },
        innerJoin: () => builder,
        where: () => builder,
        limit: () => builder,
        orderBy: () => builder,
        for: () => builder,
        then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
          try {
            resolve(resolveRows(state));
          } catch (error) {
            reject(error);
          }
        },
      };
      return builder;
    },
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => ({
          then: (resolve: (result: unknown) => void) => {
            calls.updates.push({ table, values });
            resolve({ affectedRows: 1 });
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        then: (resolve: (result: unknown) => void) => {
          calls.inserts.push({ table, values });
          resolve({ affectedRows: 1 });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => ({
        then: (resolve: (result: unknown) => void) => {
          calls.deletes.push({ table, where: true });
          resolve({ affectedRows: 1 });
        },
      }),
    }),
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
  };
  return { db, calls };
}

const NARUTO_OLD = {
  id: 1597,
  rowNumber: 1597,
  rawTitle: "Naruto 1251-1300",
  normalizedTitle: "naruto",
  episodeNumber: "1251-1300",
  workItemId: 551,
  workspaceNovelId: 771,
};

const HARRY_OLD = {
  id: 1692,
  rowNumber: 1692,
  rawTitle: "Harry Potter 241-290",
  normalizedTitle: "harry potter",
  episodeNumber: "241-290",
  workItemId: 552,
  workspaceNovelId: 772,
};

const baseConfig = (overrides: Record<string, any> = {}) => ({
  workspace: { id: 1, status: "active" },
  novels: [],
  workspaceNovels: [],
  provenance: [],
  workItemLookup: [],
  activeItems: [],
  activeSources: [],
  existingProvenanceRow: null,
  ...overrides,
});

function buildDb(config: Record<string, any>) {
  return { ...makeDb(config) };
}

beforeEach(() => {
  h.sheetRows = new Map();
  importEditorialSource.mockClear();
});

describe("IPE-061 reproduction (fails on pre-fix code)", () => {
  it("A. production reuse: row 1597 Naruto+1251-1300 -> Football+1-40 follows the normal NEW path", async () => {
    h.sheetRows.set(
      1597,
      sheetRowCells({
        rawTitle: "Football 1-40",
        translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit`,
        webSourceUrl: "https://example.com/fb",
      })
    );
    const { db, calls } = buildDb(
      baseConfig({
        novels: [],
        workspaceNovels: [],
        provenance: [provenanceRow({ ...NARUTO_OLD })],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
    });
    const row = preview.rows[0];

    expect(row.blockers).not.toContain("SYNC_IDENTITY_CHANGED");
    expect(row.blockers).toEqual([]);
    // Row reuse follows the normal NEW/existing-candidate path.
    expect(row.status).toBe("NEW"); // no novel yet -> NEW
    expect(row.provenanceDisposition).toBe("ROW_REUSED");
    // The stale locator is reconciled, not treated as this row's provenance.
    expect(row.provenanceId).toBeNull();
    expect(row.reconcileStaleProvenanceId).toBe(NARUTO_OLD.id);
  });

  it("A-sync. syncing the reused row reconciles the stale locator and creates fresh provenance", async () => {
    h.sheetRows.set(
      1597,
      sheetRowCells({
        rawTitle: "Football 1-40",
        translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit`,
        webSourceUrl: "https://example.com/fb",
      })
    );
    const { db, calls } = buildDb(
      baseConfig({
        novels: [{ id: 6, title: "Football" }],
        workspaceNovels: [{ id: 888, novelId: 6, status: "active" }],
        workItemLookup: [],
        activeSources: [],
        provenance: [provenanceRow({ ...NARUTO_OLD })],
        existingProvenanceRow: { id: NARUTO_OLD.id },
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
    });

    const sync = await syncWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
      expectedPreviewFingerprint: preview.previewFingerprint,
    });

    expect(sync.summary.succeeded).toBe(1);
    // The stale Naruto locator is reconciled by the upsert (overwritten in place),
    // provenance stays durable with no release gap.
    expect(calls.updates.some((update) => update.table === workspaceMasterIntakeRows)).toBe(true);
    expect(calls.inserts.some((insert) => insert.table === workspaceAuditEvents)).toBe(true);
  });

  it("A-2. second production case: row 1692 Harry Potter+241-290 -> Diamond no Ace+1-35", async () => {
    h.sheetRows.set(
      1692,
      sheetRowCells({
        rawTitle: "Diamond no Ace 1-35",
        translationDocUrl: `https://docs.google.com/document/d/${DOC_DIAMOND}/edit`,
        webSourceUrl: "https://example.com/dia",
      })
    );
    const { db } = buildDb(
      baseConfig({
        novels: [{ id: 9, title: "Diamond no Ace" }],
        workspaceNovels: [{ id: 889, novelId: 9, status: "active" }],
        provenance: [provenanceRow({ ...HARRY_OLD })],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1692,
      endRow: 1692,
    });
    const row = preview.rows[0];
    expect(row.blockers).toEqual([]);
    expect(row.status).toBe("MATCH"); // existing-candidate path
    expect(row.provenanceDisposition).toBe("ROW_REUSED");
    expect(row.provenanceId).toBeNull();
    expect(row.reconcileStaleProvenanceId).toBe(HARRY_OLD.id);
  });
});

describe("IPE-061 classification matrix (A-I)", () => {
  it("CASE B. identity moved to another row rebinds; the reused row proceeds independently", async () => {
    h.sheetRows.set(
      100,
      sheetRowCells({ rawTitle: "Football 1-40", translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit` })
    );
    h.sheetRows.set(
      150,
      sheetRowCells({ rawTitle: "Naruto 1-30", translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit` })
    );
    const { db } = buildDb(
      baseConfig({
        novels: [{ id: 6, title: "Football" }],
        workspaceNovels: [{ id: 888, novelId: 6, status: "active" }],
        workItemLookup: [{ id: 551, columnKey: "new" }],
        provenance: [provenanceRow({ id: 100, rowNumber: 100, rawTitle: "Naruto 1-30", normalizedTitle: "naruto", episodeNumber: "001-030" })],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 100,
      endRow: 150,
    });
    const rowB = preview.rows.find((r: any) => r.rowNumber === 100)!;
    const rowA = preview.rows.find((r: any) => r.rowNumber === 150)!;

    expect(rowA.blockers).toEqual([]);
    expect(rowA.provenanceId).toBe(100);
    expect(rowA.provenanceRowNumber).toBe(100);
    expect(rowA.provenanceDisposition).toBe("REBOUND");
    expect(rowB.blockers).toEqual([]);
    expect(rowB.status).toBe("MATCH"); // existing-candidate path (novel present)
    // Identity A is alive at row 150 (its locator rebinds there), so this
    // reused row is classified REBOUND-elsewhere — NOT an identity mutation.
    expect(rowB.provenanceDisposition).toBe("REBOUND");
  });

  it("CASE D-multi. duplicated old identity fails closed (ambiguous)", async () => {
    h.sheetRows.set(
      1597,
      sheetRowCells({ rawTitle: "Football 1-40", translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit` })
    );
    const { db } = buildDb(
      baseConfig({
        provenance: [
          provenanceRow({ id: 1597, rowNumber: 1597, ...NARUTO_OLD }),
          provenanceRow({ id: 1600, rowNumber: 1600, ...NARUTO_OLD }),
        ],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("AMBIGUOUS_PROVENANCE_REBIND");
    expect(row.provenanceId).toBe(1597);
    expect(row.reconcileStaleProvenanceId).toBeNull();
  });

  it("CASE D-malformed. malformed legacy provenance stays fail-closed (R1-D)", async () => {
    h.sheetRows.set(
      1597,
      sheetRowCells({ rawTitle: "Football 1-40", translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit` })
    );
    const { db } = buildDb(
      baseConfig({
        provenance: [
          provenanceRow({
            id: 1597,
            rowNumber: 1597,
            rawTitle: "ข้อมูลเสียหาย",
            normalizedTitle: "ข้อมูลเสียหาย",
            episodeNumber: "ไม่มีเลขจริง",
          }),
        ],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("SYNC_IDENTITY_CHANGED");
    expect(row.provenanceDisposition).toBe("NONE");
    expect(row.provenanceId).toBe(1597);
  });

  it("CASE B-verify. old row still holding its identity blocks the move (STILL_PRESENT)", async () => {
    const rawTitle = "Naruto 1-30";
    h.sheetRows.set(
      150,
      sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit` })
    );
    h.sheetRows.set(
      100,
      sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit` })
    );
    const { db } = buildDb(
      baseConfig({
        provenance: [provenanceRow({ id: 100, rowNumber: 100, rawTitle, normalizedTitle: "naruto", episodeNumber: "001-030" })],
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 150,
      endRow: 150,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("PROVENANCE_REBIND_SOURCE_ROW_STILL_PRESENT");
  });

  it("CASE I. cross-workspace provenance never participates in reconciliation", async () => {
    h.sheetRows.set(
      1597,
      sheetRowCells({ rawTitle: "Football 1-40", translationDocUrl: `https://docs.google.com/document/d/${DOC_FOOTBALL}/edit` })
    );
    const { db } = buildDb(
      baseConfig({
        novels: [{ id: 6, title: "Football" }],
        workspaceNovels: [{ id: 888, novelId: 6, status: "active" }],
        provenance: [
          provenanceRow({
            id: 500,
            workspaceId: 999,
            rowNumber: 1597,
            rawTitle: "Football 1-40",
            normalizedTitle: "football",
            episodeNumber: "001-040",
            workItemId: 600,
            workspaceNovelId: 888,
          }),
        ],
        __filterWorkspace: true,
      })
    );
    h.db = db;

    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 1597,
      endRow: 1597,
    });
    const row = preview.rows[0];
    expect(row.provenanceId).toBeNull();
    expect(row.status).toBe("MATCH"); // existing-candidate path (novel present)
  });
});
