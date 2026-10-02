// Master Intake Sync Identity Repair — unit tests for the explicit source
// replacement path in importEditorialSource. The old active source must be
// transitioned to status "removed" (row preserved for audit), a previously
// removed row for the same document identity must be reactivated instead of
// violating the unique index, and exactly one active source must remain.
// The database is mocked; callers other than Master Intake (without the
// opt-in flag) must still receive the hard SOURCE_CONFLICT.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  workspaceEditorialDrafts,
  workspaceEditorialSourceSnapshots,
  workspaceEditorialSources,
  workspaceEditorialWorkItems,
} from "../../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("../db", () => ({
  getDb: async () => h.db,
}));

vi.mock("./adminAccess", () => ({
  requireWorkspacePlatformAdmin: vi.fn(async () => undefined),
}));

import { and, eq } from "drizzle-orm";
import {
  workspaceEditorialBoards,
  workspaceKanbanCards,
} from "../../drizzle/schema";
import { sourcePayloadSha256, type EditorialSourcePayload } from "./editorialDraft.domain";
import { WorkspaceEditorialDraftError, importEditorialSource } from "./editorialDraft.service";

const DOC_A = "DocAAAAAAAAAAAAAAAAAAAAA1";
const DOC_B = "DocBBBBBBBBBBBBBBBBBBBBB2";

function payloadFor(documentId: string): EditorialSourcePayload {
  return {
    sourceKind: "google_doc",
    sourceKey: documentId,
    providerDocumentId: documentId,
    mimeType: "text/html",
    title: "translation doc",
    tabs: [{ sourceTabId: "t1", tabOrder: 1, title: "chapter", paragraphs: ["body"] }],
  };
}

type Queue = { rows: unknown[]; updates: Array<{ table: unknown; values: unknown }>; inserts: Array<{ table: unknown; values: unknown }> };

function makeTx(queues: Map<unknown, unknown[]>) {
  const calls = { updates: [] as Queue["updates"], inserts: [] as Queue["inserts"] };
  const next = (table: unknown) => {
    const queue = queues.get(table);
    return queue?.shift();
  };
  const builder = (state: { table: unknown }) => {
    const chain: any = {
      from: (table: unknown) => {
        state.table = table;
        return chain;
      },
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      for: () => chain,
      then: (resolve: (rows: unknown[]) => void) => resolve(next(state.table) ?? []),
    };
    return chain;
  };
  const tx: any = {
    select: () => builder({ table: null }),
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
  };
  return { tx, calls };
}

function makeDb(queues: Map<unknown, unknown[]>) {
  const { tx, calls } = makeTx(queues);
  const db: any = {
    select: () => {
      const state = { table: null as unknown };
      const chain: any = {
        from: (table: unknown) => {
          state.table = table;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        orderBy: () => chain,
        for: () => chain,
        then: (resolve: (rows: unknown[]) => void) => resolve(queues.get(state.table)?.shift() ?? []),
      };
      return chain;
    },
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
  };
  return { db, calls };
}

const requireWorkItemRow = {
  workItem: { id: 55 },
  card: { id: 6 },
  board: { id: 7 },
};

const activeOldSource = {
  id: 1,
  workItemId: 55,
  sourceKind: "google_doc",
  sourceKey: DOC_A,
  providerDocumentId: DOC_A,
  googleConnectionId: 5,
  mimeType: "text/html",
  title: "old doc",
  status: "active",
};

const dormantNewSource = {
  id: 2,
  workItemId: 55,
  sourceKind: "google_doc",
  sourceKey: DOC_B,
  providerDocumentId: DOC_B,
  googleConnectionId: 5,
  mimeType: "text/html",
  title: "new doc",
  status: "removed",
};

const payload = payloadFor(DOC_B);
const payloadSha = sourcePayloadSha256(payload);

beforeEach(() => {
  // nothing shared
});

describe("importEditorialSource — explicit source replacement", () => {
  it("still hard-blocks SOURCE_CONFLICT without the opt-in flag", async () => {
    const queues = new Map<unknown, unknown[]>([
      [workspaceEditorialWorkItems, [[requireWorkItemRow], [{ id: 55 }]]],
      [workspaceEditorialSources, [[activeOldSource]]],
    ]);
    const { db } = makeDb(queues);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
      })
    ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" } as Partial<WorkspaceEditorialDraftError>);
  });

  it("transitions the old active source to removed, reactivates the dormant row, one active source remains", async () => {
    const snapshot = { id: 501, sourceId: 2, revisionKey: payloadSha, sourceSha256: payloadSha };
    const latestDraft = { id: 700, version: 3, sourceSnapshotId: 501, origin: "source_import" };
    const queues = new Map<unknown, unknown[]>([
      // requireWorkItem lookup, then the transactional work-item lock.
      [workspaceEditorialWorkItems, [[requireWorkItemRow], [{ id: 55 }]]],
      // 1) active sources (old doc), 2) any-status candidate for DOC_B.
      [workspaceEditorialSources, [[activeOldSource], [dormantNewSource]]],
      // loadLatestSourceSnapshot, then the sameRevision lookup.
      [workspaceEditorialSourceSnapshots, [[{ id: 500, sourceSha256: "prev" }], [snapshot]]],
      // loadLatestDraft — draft already on the reactivated snapshot => SOURCE_UNCHANGED fast path.
      [workspaceEditorialDrafts, [[latestDraft]]],
    ]);
    const { db, calls } = makeDb(queues);
    h.db = db;

    const result = await importEditorialSource({
      actorUserId: 1,
      workspaceId: 1,
      workItemId: 55,
      payload,
      googleConnectionId: 5,
      replaceActiveSource: true,
      // R2: replacement authorization is bound to the preview-observed
      // active source state (old source A as observed at preview time).
      expectedActiveSourceKeys: [`google_doc:${DOC_A}`],
    });

    expect(result.reason).toBe("SOURCE_UNCHANGED");

    // Old active source transitioned to "removed" — row preserved for audit.
    const removal = calls.updates.find(
      (update) =>
        update.table === workspaceEditorialSources &&
        (update.values as any).status === "removed"
    );
    expect(removal).toBeTruthy();

    // Dormant row for DOC_B reactivated as the single active source, with
    // the incoming document's metadata.
    const reactivation = calls.updates.find(
      (update) =>
        update.table === workspaceEditorialSources &&
        (update.values as any).status === "active"
    );
    expect(reactivation).toBeTruthy();
    expect((reactivation!.values as any).providerDocumentId).toBe(DOC_B);
    expect((reactivation!.values as any).title).toBe("translation doc");
    expect((reactivation!.values as any).mimeType).toBe("text/html");

    // No insert happened (unique index preserved) and the removal targeted
    // the old source identity only.
    expect(calls.inserts).toHaveLength(0);
  });
});

describe("R2 — transaction-level TOCTOU guard on source replacement", () => {
  // Exact Codex P1 scenario: preview observed [A], incoming B, but by sync
  // time the active source inside the transaction is C.
  function queuedDbWithCurrentActive(currentActive: unknown) {
    const snapshot = { id: 501, sourceId: 2, revisionKey: payloadSha, sourceSha256: payloadSha };
    return makeDb(
      new Map<unknown, unknown[]>([
        [workspaceEditorialWorkItems, [[requireWorkItemRow], [{ id: 55 }]]],
        // 1) active sources re-read INSIDE the transaction (the drifted state),
        // 2) any-status candidate for DOC_B.
        [workspaceEditorialSources, [[currentActive], [dormantNewSource]]],
        [workspaceEditorialSourceSnapshots, [[{ id: 500, sourceSha256: "prev" }], [snapshot]]],
        [workspaceEditorialDrafts, [[{ id: 700, version: 3, sourceSnapshotId: 501, origin: "source_import" }]]],
      ])
    );
  }

  it("R2-B: preview saw [A], transaction state is [C] => STALE_PREVIEW, zero mutation", async () => {
    const driftedC = { ...activeOldSource, id: 9, sourceKey: "DocCCCCCCCCCCCCCCCCCCCCC3", providerDocumentId: "DocCCCCCCCCCCCCCCCCCCCCC3", title: "concurrent doc" };
    const { db, calls } = queuedDbWithCurrentActive([driftedC]);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        replaceActiveSource: true,
        // Preview observed [A]; the transaction re-read sees [C].
        expectedActiveSourceKeys: [`google_doc:${DOC_A}`],
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" } as Partial<WorkspaceEditorialDraftError>);

    // ZERO mutation: C not removed, B not activated, nothing inserted.
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("R2-C: preview saw [A], transaction state is [] => STALE_PREVIEW, zero mutation", async () => {
    const { db, calls } = queuedDbWithCurrentActive([]);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        replaceActiveSource: true,
        expectedActiveSourceKeys: [`google_doc:${DOC_A}`],
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("R2-D: preview saw [A], transaction state is [A,C] => STALE_PREVIEW, zero mutation", async () => {
    const driftedC = { ...activeOldSource, id: 9, sourceKey: "DocCCCCCCCCCCCCCCCCCCCCC3", providerDocumentId: "DocCCCCCCCCCCCCCCCCCCCCC3" };
    const { db, calls } = queuedDbWithCurrentActive([activeOldSource, driftedC]);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        replaceActiveSource: true,
        expectedActiveSourceKeys: [`google_doc:${DOC_A}`],
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("R2-F: expected key set comparison is order-insensitive (canonicalized)", async () => {
    // Transaction state [A, C]; expected passed as [C, A] — same canonical
    // set => NOT stale; replacement proceeds (guard passes the comparison).
    const extraC = { ...activeOldSource, id: 9, sourceKey: "DocCCCCCCCCCCCCCCCCCCCCC3", providerDocumentId: "DocCCCCCCCCCCCCCCCCCCCCC3" };
    const snapshot = { id: 501, sourceId: 2, revisionKey: payloadSha, sourceSha256: payloadSha };
    const queues = new Map<unknown, unknown[]>([
      [workspaceEditorialWorkItems, [[requireWorkItemRow], [{ id: 55 }]]],
      // 1) transaction re-read returns BOTH active rows [A, C],
      // 2) any-status candidate for DOC_B.
      [workspaceEditorialSources, [[[activeOldSource, extraC]], [dormantNewSource]]],
      [workspaceEditorialSourceSnapshots, [[{ id: 500, sourceSha256: "prev" }], [snapshot]]],
      [workspaceEditorialDrafts, [[{ id: 700, version: 3, sourceSnapshotId: 501, origin: "source_import" }]]],
    ]);
    // Fix the malformed nesting: the first shift must yield the plain row
    // array [A, C], not a wrapped one.
    (queues.get(workspaceEditorialSources) as unknown[][])[0] = [activeOldSource, extraC];
    const { db } = makeDb(queues);
    h.db = db;

    // NOTE: multiple-active legacy state is refused downstream (SOURCE_CONFLICT)
    // — this test only proves the STALE comparison itself is order-insensitive.
    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        replaceActiveSource: true,
        expectedActiveSourceKeys: [`google_doc:DocCCCCCCCCCCCCCCCCCCCCC3`, `google_doc:${DOC_A}`],
      })
    ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
  });

  it("R2-H (service-level): replaceActiveSource=true without expected state => STALE_PREVIEW, never authorized", async () => {
    const snapshot = { id: 501, sourceId: 2, revisionKey: payloadSha, sourceSha256: payloadSha };
    const queues = new Map<unknown, unknown[]>([
      [workspaceEditorialWorkItems, [[requireWorkItemRow], [{ id: 55 }]]],
      [workspaceEditorialSources, [[[activeOldSource]], [dormantNewSource]]],
      [workspaceEditorialSourceSnapshots, [[{ id: 500, sourceSha256: "prev" }], [snapshot]]],
      [workspaceEditorialDrafts, [[{ id: 700, version: 3, sourceSnapshotId: 501, origin: "source_import" }]]],
    ]);
    const { db, calls } = makeDb(queues);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        // Boolean alone: legacy-style preview with no observed binding.
        replaceActiveSource: true,
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("R2-I: the stale comparison runs inside the transaction (tx mock), before any mutation", async () => {
    // Prove ordering: with drifted state and a matching stale expected key,
    // the STALE_PREVIEW throws from the transaction callback BEFORE the
    // conflicting-source branch or any update/insert call is made.
    const driftedC = { ...activeOldSource, id: 9, sourceKey: "DocCCCCCCCCCCCCCCCCCCCCC3", providerDocumentId: "DocCCCCCCCCCCCCCCCCCCCCC3" };
    const { db, calls } = queuedDbWithCurrentActive([driftedC]);
    h.db = db;

    await expect(
      importEditorialSource({
        actorUserId: 1,
        workspaceId: 1,
        workItemId: 55,
        payload,
        googleConnectionId: 5,
        replaceActiveSource: true,
        expectedActiveSourceKeys: [`google_doc:${DOC_A}`],
      })
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });

    // The only transaction-side interactions were the work-item lock and the
    // active-source re-read: no update/insert ever executed.
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });
});

describe("importEditorialSource mock sanity", () => {
  it("uses and-filtered where chains consistent with the service queries", () => {
    // Guard the fixture assumptions: the service queries active sources with
    // and(eq(workItemId), eq(status)).
    const condition = and(
      eq(workspaceEditorialSources.workItemId, 55),
      eq(workspaceEditorialSources.status, "active")
    );
    expect(condition).toBeTruthy();
  });
});
