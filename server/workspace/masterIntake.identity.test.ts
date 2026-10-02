// Master Intake Sync Identity Repair — service-level regression tests for
// the canonical business identity contract (normalized title + canonical
// episode span). Source document/URL changes must rebind onto the SAME
// Episode Pack; title/range changes and ambiguity must still fail closed.
//
// The database and the Google Sheets transport are mocked; the assertions
// target preview blockers, provenance resolution and the sync-time source
// replacement wiring (IPE contract scenarios A-K).

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
  bindPublicationNovel: vi.fn(async () => ({ workspaceNovelId: 777 })),
  createWorkspacePublicationNovel: vi.fn(async () => ({ novelId: 5, workspaceNovelId: 777 })),
}));

vi.mock("./editorialBoard.service", () => ({
  createEditorialEpisodeWorkItem: vi.fn(async () => ({ created: true, board: { columns: [] } })),
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

import {
  masterIntakeRowFingerprint,
  parseMasterIntakeTitleRange,
} from "./masterIntake.domain";
import {
  previewWorkspaceMasterIntake,
  syncWorkspaceMasterIntake,
} from "./masterIntake.service";

const DOC_A = "DocAAAAAAAAAAAAAAAAAAAAA1";
const DOC_B = "DocBBBBBBBBBBBBBBBBBBBBB2";
const SHEET_ID = 42;

function sheetRowCells(input: {
  rawTitle: string;
  translationDocUrl: string;
  webSourceUrl?: string;
  preparedSourceDocUrl?: string;
}) {
  const cells: unknown[] = new Array(14).fill("");
  cells[0] = input.rawTitle;
  cells[1] = input.translationDocUrl;
  cells[3] = input.webSourceUrl ?? "";
  cells[13] = input.preparedSourceDocUrl ?? "";
  return cells;
}

function canonicalRowFingerprint(input: {
  rowNumber: number;
  rawTitle: string;
  translationDocUrl: string;
  webSourceUrl: string | null;
  preparedSourceDocUrl: string | null;
}) {
  const parsed = parseMasterIntakeTitleRange(input.rawTitle)!;
  const preparedSourceDocumentId = input.preparedSourceDocUrl
    ? input.preparedSourceDocUrl.match(/document\/d\/([^/]+)/)?.[1] ?? null
    : null;
  return masterIntakeRowFingerprint({
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    sheetId: SHEET_ID,
    sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
    rowNumber: input.rowNumber,
    novelTitle: parsed.novelTitle,
    normalizedTitle: parsed.normalizedTitle,
    episodeNumber: parsed.episodeNumber,
    translationDocUrl: input.translationDocUrl,
    translationDocumentId: input.translationDocUrl.match(/document\/d\/([^/]+)/)?.[1] ?? "",
    webSourceUrl: input.webSourceUrl,
    preparedSourceDocUrl: input.preparedSourceDocUrl,
    preparedSourceDocumentId,
  });
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
    rawTitle: "เรื่อง A 1-30",
    normalizedTitle: "เรื่อง a",
    episodeNumber: "001-030",
    translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`,
    translationDocumentId: DOC_A,
    webSourceUrl: "https://example.com/web",
    preparedSourceDocUrl: null,
    preparedSourceDocumentId: null,
    rowFingerprint: "old-fingerprint",
    lastSyncedByUserId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDb(config: {
  workspace?: unknown;
  novels?: unknown[];
  workspaceNovels?: unknown[];
  provenance?: unknown[];
  workItemLookup?: unknown[];
  activeItems?: unknown[];
  activeSources?: unknown[];
  existingProvenanceRow?: unknown;
}) {
  const calls = { updates: [] as Array<{ table: unknown; values: unknown }>, inserts: [] as Array<{ table: unknown; values: unknown }> };

  function resolveSelect(state: { table: unknown; projection: any }): unknown[] {
    const table = state.table;
    if (table === workspaceWorkspaces) return [config.workspace ?? { id: 1, status: "active" }];
    if (table === novels) return config.novels ?? [];
    if (table === workspaceNovels) return config.workspaceNovels ?? [];
    if (table === workspaceMasterIntakeRows) {
      // Projection present = persistProvenance existing-row lookup; absent = provenance list.
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
  }

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
            resolve(resolveSelect(state));
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
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
  };
  return { db, calls };
}

const defaultDbConfig = {
  workspace: { id: 1, status: "active" },
  novels: [{ id: 5, title: "เรื่อง A" }],
  workspaceNovels: [{ id: 777, novelId: 5, status: "active" }],
  workItemLookup: [{ id: 55, columnKey: "new" }],
  activeSources: [{ providerDocumentId: DOC_A }],
};

async function previewRows(config: Partial<typeof defaultDbConfig> & { startRow?: number; endRow?: number } = {}) {
  const merged = { ...defaultDbConfig, ...config };
  const { db } = makeDb(merged as any);
  h.db = db;
  const preview = await previewWorkspaceMasterIntake({
    actorUserId: 1,
    workspaceId: 1,
    googleConnectionId: 3,
    startRow: config.startRow ?? 2,
    endRow: config.endRow ?? 2,
  });
  return preview;
}

beforeEach(() => {
  h.sheetRows = new Map();
  importEditorialSource.mockClear();
});

describe("Master Intake canonical identity — preview contract (A-E)", () => {
  it("A: same identity + same source stays UNCHANGED with no blockers", async () => {
    const rawTitle = "เรื่อง A 1-30";
    const cells = sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" });
    h.sheetRows.set(2, cells);
    const preview = await previewRows({
      provenance: [
        provenanceRow({
          rowFingerprint: canonicalRowFingerprint({
            rowNumber: 2,
            rawTitle,
            translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`,
            webSourceUrl: "https://example.com/web",
            preparedSourceDocUrl: null,
          }),
        }),
      ],
    });
    expect(preview.rows[0].status).toBe("UNCHANGED");
    expect(preview.rows[0].blockers).toEqual([]);
    expect(preview.rows[0].workItemId).toBe(55);
  });

  it("B: same identity + translation doc changed => source update/rebind, NOT a blocker", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({ provenance: [provenanceRow()] });
    const row = preview.rows[0];
    expect(row.blockers).not.toContain("TRANSLATION_SOURCE_CHANGED");
    expect(row.blockers).not.toContain("SYNC_TARGET_SOURCE_CHANGED");
    expect(row.blockers).not.toContain("SYNC_IDENTITY_CHANGED");
    expect(row.blockers).toEqual([]);
    expect(row.status).toBe("UPDATED");
    expect(row.sourceReplacementExpected).toBe(true);
    expect(row.workItemId).toBe(55);
    expect(row.provenanceId).toBe(900);
  });

  it("C: same identity + prepared source changed => same Work Item, no identity blocker", async () => {
    const rawTitle = "เรื่อง A 1-30";
    const preparedUrl = "https://docs.google.com/document/d/PrepCCCCCCCCCCCCCCCCCC3/edit";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web", preparedSourceDocUrl: preparedUrl }));
    const preview = await previewRows({ provenance: [provenanceRow()] });
    const row = preview.rows[0];
    expect(row.blockers).toEqual([]);
    expect(row.status).toBe("UPDATED");
    expect(row.workItemId).toBe(55);
    expect(row.provenanceId).toBe(900);
    expect(row.sourceAlreadyLinked).toBe(true);
  });

  it("D: same identity + web source URL changed => identity unchanged", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/other" }));
    const preview = await previewRows({ provenance: [provenanceRow()] });
    const row = preview.rows[0];
    expect(row.blockers).toEqual([]);
    expect(row.status).toBe("UPDATED");
    expect(row.provenanceId).toBe(900);
  });

  it("E: `001 - 030` provenance vs `1-30` sheet title resolves to the same identity", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    // Provenance was persisted from a sheet that wrote "เรื่อง A 001 - 030"
    // (stored parsed episodeNumber "001-030"). Canonical span 1-30 matches.
    const preview = await previewRows({ provenance: [provenanceRow({ episodeNumber: "001-030", rawTitle: "เรื่อง A 001 - 030" })] });
    const row = preview.rows[0];
    expect(row.blockers).toEqual([]);
    expect(row.provenanceId).toBe(900);
    // Identity is the same, but the row text changed => UPDATED (re-sync).
    expect(row.status).toBe("UPDATED");
  });
});

describe("Master Intake canonical identity — fail closed (F-K)", () => {
  it("F: normalized title changed => SYNC_IDENTITY_CHANGED, CONFLICT", async () => {
    h.sheetRows.set(2, sheetRowCells({ rawTitle: "เรื่อง B 1-30", translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({ provenance: [provenanceRow()] });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("SYNC_IDENTITY_CHANGED");
  });

  it("G: episode range changed 141-190 -> 141-191 => identity changed, CONFLICT", async () => {
    h.sheetRows.set(2, sheetRowCells({ rawTitle: "เรื่อง A 141-191", translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({
      provenance: [provenanceRow({ rawTitle: "เรื่อง A 141-190", normalizedTitle: "เรื่อง a", episodeNumber: "141-190" })],
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("SYNC_IDENTITY_CHANGED");
  });

  it("H: overlapping but non-exact range => EPISODE_RANGE_OVERLAP, no auto-rebind", async () => {
    h.sheetRows.set(2, sheetRowCells({ rawTitle: "เรื่อง A 150-200", translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({
      provenance: [],
      activeItems: [
        {
          item: { id: 55, episodeNumber: "141-190", workspaceNovelId: 777, workItemType: "new_episode" },
          cardStatus: "active",
          columnKey: "new",
        },
      ],
      activeSources: [],
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("EPISODE_RANGE_OVERLAP");
    expect(row.workItemId).toBeNull();
  });

  it("I: more than one provenance matching the same identity => AMBIGUOUS_PROVENANCE_REBIND", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({
      provenance: [provenanceRow({ id: 900, rowNumber: 2 }), provenanceRow({ id: 901, rowNumber: 3 })],
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("AMBIGUOUS_PROVENANCE_REBIND");
  });

  it("K (move allowed): provenance moved + doc changed rebinds when the old row identity is gone", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    // Old row 9 now holds unrelated content — identity vacated.
    h.sheetRows.set(9, sheetRowCells({ rawTitle: "เรื่อง อื่น 1-1", translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({
      provenance: [provenanceRow({ rowNumber: 9 })],
      startRow: 2,
      endRow: 2,
    });
    const row = preview.rows[0];
    expect(row.blockers).toEqual([]);
    expect(row.provenanceId).toBe(900);
    expect(row.provenanceRowNumber).toBe(9);
    expect(row.status).toBe("UPDATED");
    expect(row.sourceReplacementExpected).toBe(true);
    expect(row.blockers).not.toContain("PROVENANCE_REBIND_BATCH_INCOMPLETE");
  });

  it("K (still present): old row still holds the same identity => PROVENANCE_REBIND_SOURCE_ROW_STILL_PRESENT", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    // Old row 9 still claims the same title+episode identity (even with a different doc).
    h.sheetRows.set(9, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_A}/edit`, webSourceUrl: "https://example.com/web" }));
    const preview = await previewRows({
      provenance: [provenanceRow({ rowNumber: 9 })],
      startRow: 2,
      endRow: 2,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("CONFLICT");
    expect(row.blockers).toContain("PROVENANCE_REBIND_SOURCE_ROW_STILL_PRESENT");
  });
});

describe("Master Intake sync — source replacement wiring", () => {
  it("J: doc change syncs onto the SAME work item with replaceActiveSource and persists provenance", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    const config = {
      ...defaultDbConfig,
      activeSources: [{ providerDocumentId: DOC_A }],
      provenance: [provenanceRow()],
      existingProvenanceRow: { id: 900 },
    } as any;
    const { db, calls } = makeDb(config);
    h.db = db;
    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 2,
      endRow: 2,
    });
    expect(preview.rows[0].status).toBe("UPDATED");

    const sync = await syncWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 2,
      endRow: 2,
      expectedPreviewFingerprint: preview.previewFingerprint,
    });

    expect(sync.summary.succeeded).toBe(1);
    expect(sync.results[0].ok).toBe(true);
    expect(sync.results[0].workItemId).toBe(55);
    expect(sync.results[0].sourceResult).toBe("SOURCE_IMPORTED");
    expect(importEditorialSource).toHaveBeenCalledTimes(1);
    expect(importEditorialSource.mock.calls[0][0].workItemId).toBe(55);
    expect(importEditorialSource.mock.calls[0][0].replaceActiveSource).toBe(true);
    // Provenance was updated (not duplicated) and the audit event was written.
    expect(calls.updates.some((update) => update.table === workspaceMasterIntakeRows)).toBe(true);
    expect(calls.inserts.some((insert) => insert.table === workspaceAuditEvents)).toBe(true);
  });

  it("unchanged source sync does not request source replacement", async () => {
    const rawTitle = "เรื่อง A 1-30";
    h.sheetRows.set(2, sheetRowCells({ rawTitle, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit`, webSourceUrl: "https://example.com/web" }));
    const config = {
      ...defaultDbConfig,
      activeSources: [{ providerDocumentId: DOC_B }],
      provenance: [provenanceRow({ translationDocumentId: DOC_B, translationDocUrl: `https://docs.google.com/document/d/${DOC_B}/edit` })],
      existingProvenanceRow: null,
    } as any;
    const { db } = makeDb(config);
    h.db = db;
    const preview = await previewWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 2,
      endRow: 2,
    });
    expect(preview.rows[0].sourceAlreadyLinked).toBe(true);
    const sync = await syncWorkspaceMasterIntake({
      actorUserId: 1,
      workspaceId: 1,
      googleConnectionId: 3,
      startRow: 2,
      endRow: 2,
      expectedPreviewFingerprint: preview.previewFingerprint,
    });
    expect(sync.results[0].ok).toBe(true);
    expect(importEditorialSource).not.toHaveBeenCalled();
  });
});
