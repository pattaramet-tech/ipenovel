import mysql from "mysql2/promise";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceEditorialDraftApprovals,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceGoogleConnections,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "../test-helpers/testDbConnectionOptions";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { getTestDb } from "../test-helpers/testDb";
import { workspaceAuthorEditorialRouter } from "./authorEditorial.router";
import {
  approveAuthorEditorialDraft,
  getAuthorEditorialSurface,
  runAuthorEditorialChecker,
  stageAuthorEditorialDraft,
} from "./authorEditorial.service";
import {
  approveEditorialDraft,
  getEditorialApprovalReadModel,
  stageEditorialEpisodeDraft,
} from "./editorialApproval.service";
import { createEditorialEpisodeWorkItem, ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource, type EditorialSourcePayload } from "./editorialDraft.service";
import { applyEditorialEditorEdit } from "./editorialEditor.service";
import { getEditorialPublishReadModel, requestEditorialPublish } from "./editorialPublish.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import { runScopedPublishWorkerOnce } from "./publishExecution.runtime";
import { bindPublicationNovel, createWorkspace } from "./service";

const RUN = Boolean(process.env.TEST_DATABASE_URL);

function source(revisionKey: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: `uploaded-file:${revisionKey}`,
    mimeType: "text/plain",
    title: "episode-12.txt",
    revisionKey,
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 12",
      paragraphs: ["บทที่ 12 ชื่อบท", "เนื้อหาสะอาดไม่มี finding", "จบตอน"],
    }],
  };
}

type Surface = Awaited<ReturnType<typeof getAuthorEditorialSurface>>;

function tabEdit(surface: Surface, replacement: string, idempotencyKey: string) {
  const tab = surface.tabs[0]!;
  const expectedText = tab.paragraphs.map(paragraph => paragraph.text).join("\n\n");
  return {
    expectedDraftId: surface.draft!.id,
    expectedDraftVersion: surface.draft!.version,
    expectedDraftSha256: surface.draft!.draftSha256,
    command: {
      kind: "replace_tab" as const,
      sourceTabId: tab.sourceTabId,
      expectedTabStructuralSha256: tab.structuralSha256,
      expectedText,
      replacementText: `${expectedText}\n\n${replacement}`,
      replacementParagraphKeys: [...tab.paragraphs.map(paragraph => paragraph.paragraphKey), ""],
    },
    idempotencyKey,
  };
}

function approveInput(surface: Surface, idempotencyKey: string) {
  return {
    expectedDraftId: surface.draft!.id,
    expectedDraftVersion: surface.draft!.version,
    expectedDraftSha256: surface.draft!.draftSha256,
    expectedCheckerRunId: surface.approval.checkerRunId!,
    expectedQcEvidenceSha256: surface.approval.qcEvidenceSha256!,
    idempotencyKey,
  };
}

function stageInput(surface: Surface, approvalId: number, idempotencyKey: string) {
  return {
    approvalId,
    expectedDraftId: surface.draft!.id,
    expectedDraftVersion: surface.draft!.version,
    expectedDraftSha256: surface.draft!.draftSha256,
    idempotencyKey,
  };
}

const db = () => getTestDb();

describe.skipIf(!RUN)("IPE-070R4B author approve and stage of a published episode", () => {
  let adminId = 0;
  let authorId = 0;
  let otherAuthorId = 0;
  let novelId = 0;
  let workspaceId = 0;
  let workspaceNovelId = 0;
  let boardId = 0;
  let cardId = 0;
  let workItemId = 0;
  let scope: { actorUserId: number; workspaceId: number; workItemId: number };
  let firstApprovalId = 0;
  let firstStageKey = "";
  let episodeId = 0;

  async function columnKey() {
    const [row] = await db()
      .select({ key: workspaceKanbanColumns.key })
      .from(workspaceKanbanCards)
      .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
      .where(eq(workspaceKanbanCards.id, cardId))
      .limit(1);
    return row?.key ?? null;
  }

  async function columnIdFor(key: string) {
    const [row] = await db()
      .select({ id: workspaceKanbanColumns.id })
      .from(workspaceKanbanColumns)
      .where(and(eq(workspaceKanbanColumns.boardId, boardId), eq(workspaceKanbanColumns.key, key)))
      .limit(1);
    return row!.id;
  }

  async function snapshot() {
    const [card] = await db()
      .select({ columnId: workspaceKanbanCards.columnId, version: workspaceKanbanCards.version })
      .from(workspaceKanbanCards)
      .where(eq(workspaceKanbanCards.id, cardId));
    const novelEpisodes = await db()
      .select()
      .from(episodes)
      .where(eq(episodes.novelId, novelId))
      .orderBy(asc(episodes.id));
    const approvals = await db()
      .select({ id: workspaceEditorialDraftApprovals.id, draftId: workspaceEditorialDraftApprovals.draftId })
      .from(workspaceEditorialDraftApprovals)
      .where(eq(workspaceEditorialDraftApprovals.workItemId, workItemId))
      .orderBy(asc(workspaceEditorialDraftApprovals.id));
    const stages = await db()
      .select({
        id: workspaceEditorialEpisodeStages.id,
        approvalId: workspaceEditorialEpisodeStages.approvalId,
        stageContract: workspaceEditorialEpisodeStages.stageContract,
        episodeId: workspaceEditorialEpisodeStages.episodeId,
      })
      .from(workspaceEditorialEpisodeStages)
      .where(eq(workspaceEditorialEpisodeStages.workItemId, workItemId))
      .orderBy(asc(workspaceEditorialEpisodeStages.id));
    const transitions = await db()
      .select({
        id: workspaceKanbanTransitions.id,
        fromColumnId: workspaceKanbanTransitions.fromColumnId,
        toColumnId: workspaceKanbanTransitions.toColumnId,
      })
      .from(workspaceKanbanTransitions)
      .where(eq(workspaceKanbanTransitions.cardId, cardId))
      .orderBy(asc(workspaceKanbanTransitions.id));
    const [workItem] = await db()
      .select({
        version: workspaceEditorialWorkItems.version,
        saleMode: workspaceEditorialWorkItems.saleMode,
        price: workspaceEditorialWorkItems.price,
        isFree: workspaceEditorialWorkItems.isFree,
      })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, workItemId));
    return { card, column: await columnKey(), episodes: novelEpisodes, approvals, stages, transitions, workItem };
  }

  async function backwardTransitions() {
    const published = await columnIdFor("published");
    const rows = await db()
      .select({ id: workspaceKanbanTransitions.id })
      .from(workspaceKanbanTransitions)
      .where(and(eq(workspaceKanbanTransitions.cardId, cardId), eq(workspaceKanbanTransitions.fromColumnId, published)));
    return rows.length;
  }

  async function prepareControlledPublish() {
    const connection = await saveGoogleConnection({
      userId: adminId,
      providerSubject: `author-published-guard-${adminId}`,
      credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.author-guard.ciphertext.tag" },
      grantedScopes:
        "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
    });
    const binding = await bindGoogleDocument({
      actorUserId: adminId,
      workspaceId,
      workspaceNovelId,
      connectionId: connection.connectionId,
      providerFileId: `doc_author_guard_${adminId}`,
      mimeType: GOOGLE_DOC_MIME_TYPE,
      title: "Author guard publish anchor",
      role: "chapter",
      sequence: 1,
      correlationId: "author-guard-bind",
    });
    await observeBoundGoogleDocument({
      actorUserId: adminId,
      workspaceId,
      bindingId: binding.bindingId,
      accessToken: "server-only-test-token",
      correlationId: "author-guard-observe",
      adapter: {
        getMetadata: vi.fn(async () => ({
          providerFileId: `doc_author_guard_${adminId}`,
          revision: "author-guard-rev-1",
          mimeType: GOOGLE_DOC_MIME_TYPE,
          title: "Author guard publish anchor",
        })),
        getNormalizedText: vi.fn(async () => "Author guard publish anchor"),
        revoke: vi.fn(async () => undefined),
      },
    });
    await db()
      .update(workspaceMigrationRegistry)
      .set({ owner: "workspace", cutoverEpoch: 1 })
      .where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish"),
      ));
    const prepared = await getEditorialPublishReadModel({ actorUserId: adminId, workspaceId, workItemId });
    if (!prepared.requestReady) throw new Error(`publish not ready: ${prepared.blocker}`);
    const enqueued = await requestEditorialPublish({
      actorUserId: adminId,
      workspaceId,
      workItemId,
      expectedStageSetSha256: prepared.stageSetSha256!,
      expectedStagedDraftSha256: prepared.stages[0]!.stagedDraftSha256,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: prepared.ownership!.version,
      executionEnabled: true,
    });
    await db()
      .update(workspaceOutbox)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceOutbox.id, enqueued.execution.outbox.id));
    return enqueued;
  }

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL!);
    const admin = await createTestUser({ role: "admin" });
    const author = await createTestUser({ role: "author" });
    const otherAuthor = await createTestUser({ role: "author" });
    adminId = admin.id;
    authorId = author.id;
    otherAuthorId = otherAuthor.id;
    const novel = await createTestNovel();
    novelId = novel.id;
    const workspace = await createWorkspace(adminId, "Author published guard");
    workspaceId = workspace.workspaceId;
    const bound = await bindPublicationNovel({ actorUserId: adminId, workspaceId, novelId });
    workspaceNovelId = bound.workspaceNovelId;
    await db().update(novels).set({ authorUserId: authorId }).where(eq(novels.id, novelId));
    await db().insert(workspaceMembers).values({ workspaceId, userId: authorId, role: "editor", status: "active" });
    const board = await ensureEditorialBoard({ actorUserId: adminId, workspaceId });
    boardId = board!.board.id;
    const story = board?.columns.flatMap(column => column.cards).find(card => card.workItemType === "NEW_STORY");
    const created = await createEditorialEpisodeWorkItem({
      actorUserId: adminId,
      workspaceId,
      workspaceNovelId: story!.workspaceNovelId!,
      episodeNumber: "12",
      episodeTitle: "ชื่อจาก Intake",
      saleMode: "package",
      price: "12.00",
      isFree: false,
    });
    const card = created.board?.columns.flatMap(column => column.cards)
      .find(item => item.workItemType === "NEW_EPISODE" && item.episodeNumber === "12");
    workItemId = card!.workItemId!;
    await importEditorialSource({ actorUserId: adminId, workspaceId, workItemId, payload: source(`guard-${adminId}`) });
    const [item] = await db()
      .select({ cardId: workspaceEditorialWorkItems.cardId })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, workItemId));
    cardId = item.cardId!;
    scope = { actorUserId: authorId, workspaceId, workItemId };
    const surface = await getAuthorEditorialSurface(scope);
    await runAuthorEditorialChecker({ ...scope, expectedDraftId: surface.draft!.id });
  }, 120000);

  afterAll(async () => {
    if (!RUN || !workspaceId) return;
    await db().delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, boardId));
    await db().delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspaceId));
    await db().delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, adminId));
    await db().delete(episodes).where(eq(episodes.novelId, novelId));
    await db().delete(novels).where(eq(novels.id, novelId));
    for (const id of [adminId, authorId, otherAuthorId]) await db().delete(users).where(eq(users.id, id));
  });

  it("rejects a stale draft and a revoked owner before publication without an approval row", async () => {
    const surface = await getAuthorEditorialSurface(scope);
    expect(surface.approval.approveActionReady).toBe(true);
    const before = await snapshot();
    await expect(approveAuthorEditorialDraft({
      ...scope,
      ...approveInput(surface, "guard-stale"),
      expectedDraftSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    await db().update(novels).set({ authorUserId: otherAuthorId }).where(eq(novels.id, novelId));
    try {
      await expect(approveAuthorEditorialDraft({ ...scope, ...approveInput(surface, "guard-revoked") }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db().update(novels).set({ authorUserId: authorId }).where(eq(novels.id, novelId));
    }
    expect(await snapshot()).toEqual(before);
  });

  it("approves, stages, and replays the Stage before publication", async () => {
    const surface = await getAuthorEditorialSurface(scope);
    const approved = await approveAuthorEditorialDraft({ ...scope, ...approveInput(surface, "guard-approve-1") });
    expect(approved.replayed).toBe(false);
    firstApprovalId = approved.approval.id;
    const approvedSurface = await getAuthorEditorialSurface(scope);
    expect(approvedSurface.approval.stageActionReady).toBe(true);
    firstStageKey = `author-stage:${firstApprovalId}:${surface.draft!.id}`;
    const staged = await stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, firstStageKey) });
    expect(staged.replayed).toBe(false);
    expect(staged.stage!.stageContract).toBe("workspace-editorial-episode-stage-v2");
    expect(staged.episode!.isPublished).toBe(false);
    episodeId = staged.episode!.id;
    expect(await columnKey()).toBe("ready_to_publish");

    const before = await snapshot();
    const replayed = await stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, firstStageKey) });
    expect(replayed.replayed).toBe(true);
    expect(replayed.stage!.id).toBe(staged.stage!.id);
    expect(await snapshot()).toEqual(before);
  }, 60000);

  it("rejects author approve and stage queued behind a real Controlled Publish of the Author Stage without moving the card back", async () => {
    const surface = await getAuthorEditorialSurface(scope);
    const enqueued = await prepareControlledPublish();
    const options = buildTestDbConnectionOptions(
      process.env.TEST_DATABASE_URL,
      parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT),
    );
    const holder = await mysql.createConnection(options);
    const watcher = await mysql.createConnection(options);
    const lockWaits = async () => {
      const [rows] = await watcher.query(
        "SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits",
      ) as unknown as [Array<{ waiting: number }>];
      return Number(rows[0]?.waiting ?? 0);
    };
    const waitFor = async (check: () => Promise<boolean>, label: string) => {
      const started = Date.now();
      while (Date.now() - started < 15000) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    let worker: Promise<any> | null = null;
    let approve: Promise<unknown> | null = null;
    let stage: Promise<unknown> | null = null;
    try {
      await holder.beginTransaction();
      await holder.query("SELECT id FROM workspaceEditorialWorkItems WHERE id = ? FOR UPDATE", [workItemId]);
      worker = runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "author-guard-publish-worker",
        provider: createIpeNovelWorkspacePublishProvider(),
        executionEnabled: true,
        allowExternalProvider: true,
      });
      await waitFor(async () => {
        const [rows] = await watcher.query("SELECT isPublished FROM episodes WHERE id = ?", [episodeId]) as any;
        return Boolean(rows[0]?.isPublished) && (await lockWaits()) >= 1;
      }, "provider commit with the projection waiting on the work item");
      expect(await columnKey()).toBe("ready_to_publish");

      approve = approveAuthorEditorialDraft({ ...scope, ...approveInput(surface, "guard-approve-race") });
      stage = stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, "guard-stage-race") });
      approve.catch(() => undefined);
      stage.catch(() => undefined);
      await waitFor(async () => (await lockWaits()) >= 3, "author approve and stage waiting on the work item");
      await holder.commit();

      const published = await worker;
      worker = null;
      expect(published.result.status).toBe("published");
      await expect(approve).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
      await expect(stage).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
      approve = null;
      stage = null;
    } finally {
      await holder.rollback().catch(() => undefined);
      await holder.end();
      await watcher.end();
      for (const pending of [worker, approve, stage]) if (pending) await pending.catch(() => undefined);
    }
    expect(await columnKey()).toBe("published");
    expect(await backwardTransitions()).toBe(0);
    const after = await snapshot();
    expect(after.approvals.map(row => row.id)).toEqual([firstApprovalId]);
    expect(after.stages).toHaveLength(1);
    expect(after.stages[0]).toMatchObject({
      approvalId: firstApprovalId,
      stageContract: "workspace-editorial-episode-stage-v2",
      episodeId,
    });
    const [live] = after.episodes;
    expect(live).toMatchObject({ id: episodeId, isPublished: true });
  }, 90000);

  it("rejects author reapproval, restage, and old Stage replay on the published card without writes", async () => {
    const surface = await getAuthorEditorialSurface(scope);
    expect(await columnKey()).toBe("published");
    expect(surface.publishAvailable).toBe(false);
    expect(surface.approval.approveActionReady).toBe(false);
    expect(surface.approval.stageActionReady).toBe(false);
    expect(surface.approval.stageActionReason).toContain("already published");
    expect(surface.approval.approveActionReason).toContain("already published");

    const before = await snapshot();
    await expect(approveAuthorEditorialDraft({ ...scope, ...approveInput(surface, "guard-approve-after-publish") }))
      .rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    await expect(approveAuthorEditorialDraft({ ...scope, ...approveInput(surface, "guard-approve-1") }))
      .rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    await expect(stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, "guard-stage-after-publish") }))
      .rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    await expect(stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, firstStageKey) }))
      .rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    expect(await snapshot()).toEqual(before);

    await db().update(novels).set({ authorUserId: otherAuthorId }).where(eq(novels.id, novelId));
    try {
      await expect(stageAuthorEditorialDraft({ ...scope, ...stageInput(surface, firstApprovalId, "guard-stage-revoked") }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db().update(novels).set({ authorUserId: authorId }).where(eq(novels.id, novelId));
    }
    expect(await snapshot()).toEqual(before);
  });

  it("denies author approve and stage of the live episode after an admin revision moves the card", async () => {
    const surface = await getAuthorEditorialSurface(scope);
    const revised = await applyEditorialEditorEdit({
      actorUserId: adminId,
      workspaceId,
      workItemId,
      ...tabEdit(surface, "เนื้อหารอบแก้หลังเผยแพร่", "guard-admin-revision"),
    });
    expect(revised.replayed).toBe(false);
    expect(await columnKey()).toBe("editing");
    await runAuthorEditorialChecker({ ...scope, expectedDraftId: revised.draft.id });
    const revisedSurface = await getAuthorEditorialSurface(scope);
    expect(revisedSurface.approval.qcReady).toBe(true);
    expect(revisedSurface.approval.approveActionReady).toBe(false);
    expect(revisedSurface.approval.stageActionReady).toBe(false);

    const before = await snapshot();
    expect(before.column).not.toBe("published");
    await expect(approveAuthorEditorialDraft({ ...scope, ...approveInput(revisedSurface, "guard-approve-revision") }))
      .rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    expect(await snapshot()).toEqual(before);

    const adminState = await getEditorialApprovalReadModel({ actorUserId: adminId, workspaceId, workItemId });
    const adminApproval = await approveEditorialDraft({
      actorUserId: adminId,
      workspaceId,
      workItemId,
      expectedDraftId: adminState.latestDraft!.id,
      expectedDraftVersion: adminState.latestDraft!.version,
      expectedDraftSha256: adminState.latestDraft!.draftSha256,
      expectedCheckerRunId: adminState.qc.checkerRunId!,
      expectedQcEvidenceSha256: adminState.qc.qcEvidenceSha256!,
      idempotencyKey: "guard-admin-approve-revision",
    });
    const withAdminApproval = await snapshot();
    await expect(stageAuthorEditorialDraft({
      ...scope,
      ...stageInput(revisedSurface, adminApproval.approval.id, "guard-author-stage-admin-approval"),
    })).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    expect(await snapshot()).toEqual(withAdminApproval);
  }, 60000);

  it("keeps the admin V3 replacement Stage and still denies the author in ready_to_publish", async () => {
    const adminState = await getEditorialApprovalReadModel({ actorUserId: adminId, workspaceId, workItemId });
    const liveBefore = (await snapshot()).episodes[0]!;
    const staged = await stageEditorialEpisodeDraft({
      actorUserId: adminId,
      workspaceId,
      workItemId,
      approvalId: adminState.approval!.id,
      expectedDraftId: adminState.latestDraft!.id,
      expectedDraftVersion: adminState.latestDraft!.version,
      expectedDraftSha256: adminState.latestDraft!.draftSha256,
      idempotencyKey: "guard-admin-replacement-stage",
    });
    expect(staged.replayed).toBe(false);
    expect(staged.stage!.stageContract).toBe("workspace-editorial-episode-stage-v3");
    expect(staged.episode!.id).toBe(episodeId);
    expect(staged.readModel.readyToPublish).toBe(true);
    expect(await columnKey()).toBe("ready_to_publish");
    const liveAfter = (await snapshot()).episodes[0]!;
    expect(liveAfter).toEqual(liveBefore);

    const surface = await getAuthorEditorialSurface(scope);
    expect(surface.approval.stageActionReady).toBe(false);
    const before = await snapshot();
    await expect(stageAuthorEditorialDraft({
      ...scope,
      ...stageInput(surface, adminState.approval!.id, "guard-author-stage-ready"),
    })).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    expect(await snapshot()).toEqual(before);
    expect(before.column).toBe("ready_to_publish");
    expect(await backwardTransitions()).toBe(1);
  }, 60000);

  it("exposes no author publish procedure", () => {
    const procedures = Object.keys((workspaceAuthorEditorialRouter as any)._def.procedures);
    expect(procedures.some(name => /publish/i.test(name))).toBe(false);
  });
});
