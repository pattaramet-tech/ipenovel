import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceAuditEvents,
  workspaceEditorialCheckerAllowWords,
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
  workspacePublishItems,
  workspacePublishRuns,
  workspacePublishingDestinations,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { getTestDb } from "../test-helpers/testDb";
import {
  approveAuthorEditorialDraft,
  editAuthorEditorialDraft,
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
import { runEditorialForeignChecker } from "./editorialForeignChecker.service";
import {
  assertEditorialPublishRequestCurrent,
  getEditorialPublishReadModel,
  requestEditorialPublish,
} from "./editorialPublish.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import {
  buildPublishItemRequestKey,
  WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
  type WorkspacePublishObservation,
  type WorkspacePublishProvider,
  type WorkspacePublishProviderRequest,
} from "./publishExecution.domain";
import { runScopedPublishWorkerOnce } from "./publishExecution.runtime";
import { claimPublishOutbox, requestPublishExecution } from "./publishExecution.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const RUN = Boolean(process.env.TEST_DATABASE_URL);
const db = () => getTestDb();

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

/** Local in-repo provider (test DB writes only) presented as a mock with fault injection. */
function localProvider(faults: { failFirstExecute?: boolean; crashAfterExecute?: boolean } = {}) {
  const real = createIpeNovelWorkspacePublishProvider();
  const calls = { execute: 0, reconcile: 0 };
  const provider: WorkspacePublishProvider = {
    mode: "mock",
    async reconcile(request) {
      calls.reconcile += 1;
      return real.reconcile(request);
    },
    async execute(request) {
      calls.execute += 1;
      if (faults.failFirstExecute && calls.execute === 1) {
        return { status: "failed", errorClass: "TRANSIENT_PROVIDER_FAILURE" };
      }
      const result = await real.execute(request);
      if (faults.crashAfterExecute && calls.execute === 1) throw new Error("worker crashed after provider commit");
      return result;
    },
  };
  return { provider, calls };
}

type Fixture = Awaited<ReturnType<typeof buildFixture>>;
const fixtures: Fixture[] = [];

async function buildFixture(label: string, options: { requestPublish?: boolean } = {}) {
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL!);
  const admin = await createTestUser({ role: "admin" });
  const author = await createTestUser({ role: "author" });
  const otherAuthor = await createTestUser({ role: "author" });
  const novel = await createTestNovel();
  const workspace = await createWorkspace(admin.id, `Author stage publish ${label}`);
  const ctx = {
    adminId: admin.id,
    authorId: author.id,
    otherAuthorId: otherAuthor.id,
    novelId: novel.id,
    workspaceId: workspace.workspaceId,
    workspaceNovelId: 0,
    boardId: 0,
    cardId: 0,
    workItemId: 0,
    episodeId: 0,
    approvalId: 0,
    stage: null as any,
    scope: { actorUserId: author.id, workspaceId: workspace.workspaceId, workItemId: 0 },
    enqueued: null as Awaited<ReturnType<typeof requestEditorialPublish>> | null,
  };
  fixtures.push(ctx);
  const bound = await bindPublicationNovel({ actorUserId: admin.id, workspaceId: ctx.workspaceId, novelId: novel.id });
  ctx.workspaceNovelId = bound.workspaceNovelId;
  await db().update(novels).set({ authorUserId: author.id }).where(eq(novels.id, novel.id));
  await db().insert(workspaceMembers).values({
    workspaceId: ctx.workspaceId,
    userId: author.id,
    role: "editor",
    status: "active",
  });
  const board = await ensureEditorialBoard({ actorUserId: admin.id, workspaceId: ctx.workspaceId });
  ctx.boardId = board!.board.id;
  const story = board?.columns.flatMap(column => column.cards).find(card => card.workItemType === "NEW_STORY");
  const created = await createEditorialEpisodeWorkItem({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workspaceNovelId: story!.workspaceNovelId!,
    episodeNumber: "12",
    episodeTitle: "ชื่อจาก Intake",
    saleMode: "package",
    price: "12.00",
    isFree: false,
  });
  ctx.workItemId = created.board?.columns.flatMap(column => column.cards)
    .find(item => item.workItemType === "NEW_EPISODE" && item.episodeNumber === "12")!.workItemId!;
  ctx.scope.workItemId = ctx.workItemId;
  await importEditorialSource({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    payload: source(`${label}-${admin.id}`),
  });
  const [item] = await db()
    .select({ cardId: workspaceEditorialWorkItems.cardId })
    .from(workspaceEditorialWorkItems)
    .where(eq(workspaceEditorialWorkItems.id, ctx.workItemId));
  ctx.cardId = item.cardId!;

  const imported = await getAuthorEditorialSurface(ctx.scope);
  const edited = await editAuthorEditorialDraft({
    ...ctx.scope,
    ...tabEdit(imported, "ผู้เขียนเพิ่มย่อหน้านี้", `${label}-author-edit`),
  });
  await runAuthorEditorialChecker({ ...ctx.scope, expectedDraftId: edited.draft.id });
  const ready = await getAuthorEditorialSurface(ctx.scope);
  if (!ready.approval.qcReady) throw new Error(`QC not ready: ${ready.approval.qcReason}`);
  const approved = await approveAuthorEditorialDraft({
    ...ctx.scope,
    expectedDraftId: ready.draft!.id,
    expectedDraftVersion: ready.draft!.version,
    expectedDraftSha256: ready.draft!.draftSha256,
    expectedCheckerRunId: ready.approval.checkerRunId!,
    expectedQcEvidenceSha256: ready.approval.qcEvidenceSha256!,
    idempotencyKey: `author-approve:${ready.draft!.id}:${ready.approval.checkerRunId}`,
  });
  ctx.approvalId = approved.approval.id;
  const staged = await stageAuthorEditorialDraft({
    ...ctx.scope,
    approvalId: approved.approval.id,
    expectedDraftId: ready.draft!.id,
    expectedDraftVersion: ready.draft!.version,
    expectedDraftSha256: ready.draft!.draftSha256,
    idempotencyKey: `author-stage:${approved.approval.id}:${ready.draft!.id}`,
  });
  ctx.stage = staged.stage;
  ctx.episodeId = staged.episode!.id;

  const connection = await saveGoogleConnection({
    userId: admin.id,
    providerSubject: `author-stage-publish-${admin.id}`,
    credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.author-stage.ciphertext.tag" },
    grantedScopes:
      "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
  });
  const binding = await bindGoogleDocument({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workspaceNovelId: ctx.workspaceNovelId,
    connectionId: connection.connectionId,
    providerFileId: `doc_author_stage_${admin.id}`,
    mimeType: GOOGLE_DOC_MIME_TYPE,
    title: "Author stage publish anchor",
    role: "chapter",
    sequence: 1,
    correlationId: `${label}-bind`,
  });
  await observeBoundGoogleDocument({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    bindingId: binding.bindingId,
    accessToken: "server-only-test-token",
    correlationId: `${label}-observe`,
    adapter: {
      getMetadata: vi.fn(async () => ({
        providerFileId: `doc_author_stage_${admin.id}`,
        revision: `${label}-rev-1`,
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Author stage publish anchor",
      })),
      getNormalizedText: vi.fn(async () => "Author stage publish anchor"),
      revoke: vi.fn(async () => undefined),
    },
  });
  await db()
    .update(workspaceMigrationRegistry)
    .set({ owner: "workspace", cutoverEpoch: 1 })
    .where(and(
      eq(workspaceMigrationRegistry.workspaceNovelId, ctx.workspaceNovelId),
      eq(workspaceMigrationRegistry.capability, "publish"),
    ));

  const prepared = await getEditorialPublishReadModel({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
  });
  if (!prepared.requestReady) throw new Error(`publish not ready: ${prepared.blocker}`);
  const publishInput = {
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    expectedStageSetSha256: prepared.stageSetSha256!,
    expectedStagedDraftSha256: prepared.stages[0]!.stagedDraftSha256,
    expectedCutoverEpoch: 1,
    expectedOwnershipVersion: prepared.ownership!.version,
  };
  if (options.requestPublish === false) {
    await expect(requestEditorialPublish({ ...publishInput, executionEnabled: false }))
      .rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    return { ctx, prepared, publishInput };
  }
  ctx.enqueued = await requestEditorialPublish({ ...publishInput, executionEnabled: true });
  await makeOutboxAvailable(ctx);
  return { ctx, prepared, publishInput };
}

async function makeOutboxAvailable(ctx: Fixture["ctx"]) {
  await db()
    .update(workspaceOutbox)
    .set({ availableAt: new Date(Date.now() - 1_000) })
    .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
}

function runWorker(ctx: Fixture["ctx"], provider: WorkspacePublishProvider, observer?: (event: WorkspacePublishObservation) => void) {
  return runScopedPublishWorkerOnce({
    scope: ctx.enqueued!.scope,
    leaseOwner: `author-stage-worker-${ctx.adminId}`,
    provider,
    executionEnabled: true,
    allowExternalProvider: false,
    observer,
  });
}

async function columnKey(ctx: Fixture["ctx"]) {
  const [row] = await db()
    .select({ key: workspaceKanbanColumns.key })
    .from(workspaceKanbanCards)
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
    .where(eq(workspaceKanbanCards.id, ctx.cardId));
  return row?.key ?? null;
}

async function episodeRow(ctx: Fixture["ctx"]) {
  const [row] = await db().select().from(episodes).where(eq(episodes.id, ctx.episodeId));
  return row;
}

async function publishState(ctx: Fixture["ctx"]) {
  const runId = ctx.enqueued?.scope.runId ?? 0;
  const [run] = await db().select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, runId));
  const items = await db().select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, runId));
  const [outbox] = await db().select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, runId));
  return { run, items, outbox };
}

async function legitRequest(ctx: Fixture["ctx"]): Promise<WorkspacePublishProviderRequest> {
  const { run, items } = await publishState(ctx);
  const [destination] = await db()
    .select()
    .from(workspacePublishingDestinations)
    .where(eq(workspacePublishingDestinations.id, run.destinationId));
  const item = items[0]!;
  return {
    requestKey: buildPublishItemRequestKey({
      publishRunId: run.id,
      destinationId: destination.id,
      policyVersion: destination.policyVersion,
      itemKey: item.itemKey,
      episodeId: item.episodeId ?? undefined,
      sourceSha256: item.sourceSha256,
    }),
    workspaceId: ctx.workspaceId,
    publishRunId: run.id,
    destinationId: destination.id,
    targetType: destination.targetType,
    targetId: destination.targetId,
    itemKey: item.itemKey,
    episodeId: item.episodeId ?? undefined,
    sourceSha256: item.sourceSha256,
  };
}

async function expectNotPublished(ctx: Fixture["ctx"]) {
  expect((await episodeRow(ctx)).isPublished).toBe(false);
  expect(await columnKey(ctx)).toBe("ready_to_publish");
  const receipts = await db()
    .select({ id: workspaceAuditEvents.id })
    .from(workspaceAuditEvents)
    .where(and(
      eq(workspaceAuditEvents.workspaceId, ctx.workspaceId),
      eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
    ));
  expect(receipts).toHaveLength(0);
}

afterAll(async () => {
  if (!RUN) return;
  for (const ctx of fixtures) {
    await db().delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, ctx.boardId));
    await db().delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
    await db().delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, ctx.adminId));
    await db().delete(episodes).where(eq(episodes.novelId, ctx.novelId));
    await db().delete(novels).where(eq(novels.id, ctx.novelId));
    for (const id of [ctx.adminId, ctx.authorId, ctx.otherAuthorId]) await db().delete(users).where(eq(users.id, id));
  }
});

describe.skipIf(!RUN)("IPE-070R4B Author Stage to Admin Controlled Publish", () => {
  it("publishes an Author-created Stage only through an Admin request and keeps evidence consistent", async () => {
    const { ctx, publishInput } = await buildFixture("happy");
    expect(ctx.stage.stagedByUserId).toBe(ctx.authorId);
    expect(ctx.stage.stageContract).toBe("workspace-editorial-episode-stage-v2");
    const inspected = await getEditorialPublishReadModel({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
    });
    expect(inspected.stages.map((stage: any) => stage.stagedByUserId)).toEqual([ctx.authorId]);

    await expect(requestEditorialPublish({ ...publishInput, actorUserId: ctx.authorId, executionEnabled: true }))
      .rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(requestPublishExecution({
      actorUserId: ctx.authorId,
      workspaceId: ctx.workspaceId,
      runId: ctx.enqueued!.scope.runId,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: publishInput.expectedOwnershipVersion,
      executionEnabled: true,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(getEditorialPublishReadModel({
      actorUserId: ctx.authorId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });

    const stagedContent = (await episodeRow(ctx)).content;
    const { provider, calls } = localProvider();
    const events: string[] = [];
    const published = await runWorker(ctx, provider, event => events.push(event.type));
    expect(published.claimed).toBe(true);
    expect((published as any).result.status).toBe("published");
    expect((published as any).editorialProjection).toMatchObject({ matched: true, projected: true });
    expect(calls.execute).toBe(1);
    expect(events).toContain("execute_start");

    const live = await episodeRow(ctx);
    expect(live).toMatchObject({ id: ctx.episodeId, isPublished: true, content: stagedContent });
    expect(await columnKey(ctx)).toBe("published");
    const state = await publishState(ctx);
    expect(state.run.status).toBe("published");
    expect(state.outbox.status).toBe("delivered");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      status: "published",
      episodeId: ctx.episodeId,
      sourceSha256: ctx.stage.contentSha256,
    });
    expect(state.items[0]!.providerReceipt).toBeTruthy();
    const [stageAfter] = await db()
      .select()
      .from(workspaceEditorialEpisodeStages)
      .where(eq(workspaceEditorialEpisodeStages.id, ctx.stage.id));
    expect(stageAfter).toEqual(ctx.stage);
    const approvals = await db()
      .select({ id: workspaceEditorialDraftApprovals.id, approvedByUserId: workspaceEditorialDraftApprovals.approvedByUserId })
      .from(workspaceEditorialDraftApprovals)
      .where(eq(workspaceEditorialDraftApprovals.workItemId, ctx.workItemId));
    expect(approvals).toEqual([{ id: ctx.approvalId, approvedByUserId: ctx.authorId }]);

    const transitionsBefore = await db()
      .select({ id: workspaceKanbanTransitions.id })
      .from(workspaceKanbanTransitions)
      .where(eq(workspaceKanbanTransitions.cardId, ctx.cardId))
      .orderBy(asc(workspaceKanbanTransitions.id));
    const replay = await runWorker(ctx, provider);
    expect(replay.claimed).toBe(false);
    expect(calls.execute).toBe(1);
    expect(await episodeRow(ctx)).toEqual(live);
    expect(await db()
      .select({ id: workspaceKanbanTransitions.id })
      .from(workspaceKanbanTransitions)
      .where(eq(workspaceKanbanTransitions.cardId, ctx.cardId))
      .orderBy(asc(workspaceKanbanTransitions.id))).toEqual(transitionsBefore);

    const surface = await getAuthorEditorialSurface(ctx.scope);
    expect(surface.publishAvailable).toBe(false);
    expect(surface.approval.approveActionReady).toBe(false);
    expect(surface.approval.stageActionReady).toBe(false);
    await expect(approveAuthorEditorialDraft({
      ...ctx.scope,
      expectedDraftId: surface.draft!.id,
      expectedDraftVersion: surface.draft!.version,
      expectedDraftSha256: surface.draft!.draftSha256,
      expectedCheckerRunId: surface.approval.checkerRunId!,
      expectedQcEvidenceSha256: surface.approval.qcEvidenceSha256!,
      idempotencyKey: "after-publish-approve",
    })).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
    await expect(stageAuthorEditorialDraft({
      ...ctx.scope,
      approvalId: ctx.approvalId,
      expectedDraftId: surface.draft!.id,
      expectedDraftVersion: surface.draft!.version,
      expectedDraftSha256: surface.draft!.draftSha256,
      idempotencyKey: "after-publish-stage",
    })).rejects.toMatchObject({ code: "EPISODE_PUBLISHED" });
  }, 90000);

  it("refuses provider execution without an Admin-requested execution", async () => {
    const { ctx, publishInput } = await buildFixture("no-request", { requestPublish: false });
    const [run] = await db()
      .select()
      .from(workspacePublishRuns)
      .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
      .where(eq(workspacePublishingDestinations.workspaceNovelId, ctx.workspaceNovelId));
    expect(run).toBeTruthy();
    ctx.enqueued = {
      scope: {
        workspaceId: ctx.workspaceId,
        workspaceNovelId: ctx.workspaceNovelId,
        runId: run.workspacePublishRuns.id,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: publishInput.expectedOwnershipVersion,
      },
    } as any;
    const request = await legitRequest(ctx);
    await expect(assertEditorialPublishRequestCurrent(request)).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });
    const { provider, calls } = localProvider();
    expect((await runWorker(ctx, provider)).claimed).toBe(false);
    expect(calls.execute).toBe(0);
    await expectNotPublished(ctx);
  }, 90000);

  it("binds provider execution to the exact claimed run, item, destination, workspace, novel and Stage", async () => {
    const { ctx } = await buildFixture("binding");
    const other = await buildFixture("binding-other");
    const request = await legitRequest(ctx);
    await expect(assertEditorialPublishRequestCurrent(request)).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });

    const claimed = await claimPublishOutbox({
      workspaceId: ctx.workspaceId,
      publishRunId: ctx.enqueued!.scope.runId,
      leaseOwner: "binding-probe",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: ctx.enqueued!.scope.expectedOwnershipVersion,
    });
    expect(claimed?.status).toBe("claimed");
    await db()
      .update(workspacePublishItems)
      .set({ status: "publishing" })
      .where(eq(workspacePublishItems.runId, ctx.enqueued!.scope.runId));
    await expect(assertEditorialPublishRequestCurrent(request)).resolves.toMatchObject({ editorial: true });

    const otherRequest = await legitRequest(other.ctx);
    const forgedStageKey = `editorial-stage:${other.ctx.stage.id}:episode:${ctx.episodeId}`;
    const tampered: Array<[string, Partial<WorkspacePublishProviderRequest>, string]> = [
      ["other workspace", { workspaceId: other.ctx.workspaceId }, "WORK_ITEM_NOT_FOUND"],
      ["other novel", { targetId: other.ctx.novelId }, "PUBLISH_STATE_CONFLICT"],
      ["other destination", { destinationId: otherRequest.destinationId }, "PUBLISH_STATE_CONFLICT"],
      ["other run", { publishRunId: otherRequest.publishRunId }, "PUBLISH_STATE_CONFLICT"],
      ["forged Stage id", { itemKey: forgedStageKey }, "STAGE_CONFLICT"],
      ["other episode", { episodeId: other.ctx.episodeId }, "STAGE_CONFLICT"],
      ["other content hash", { sourceSha256: "0".repeat(64) }, "STAGE_CONFLICT"],
      ["other Stage item", { itemKey: otherRequest.itemKey, episodeId: otherRequest.episodeId, sourceSha256: otherRequest.sourceSha256 }, "WORK_ITEM_NOT_FOUND"],
    ];
    for (const [label, patch, code] of tampered) {
      await expect(
        assertEditorialPublishRequestCurrent({ ...request, ...patch }),
        label,
      ).rejects.toMatchObject({ code });
    }

    await db()
      .update(workspaceOutbox)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceOutbox.id, claimed!.id));
    await expect(assertEditorialPublishRequestCurrent(request)).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });
    await expectNotPublished(ctx);
    await expectNotPublished(other.ctx);
  }, 120000);

  it("re-running QC with unchanged evidence keeps the Admin request publishable", async () => {
    const { ctx } = await buildFixture("qc-rerun");
    const surface = await getAuthorEditorialSurface(ctx.scope);
    await runEditorialForeignChecker({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
      expectedDraftId: surface.draft!.id,
    });
    const { provider } = localProvider();
    expect(((await runWorker(ctx, provider)) as any).result.status).toBe("published");
    expect(await columnKey(ctx)).toBe("published");
  }, 90000);

  it("fails closed on stale Stage, Draft, QC and revoked Author ownership", async () => {
    const cases: Array<[string, (ctx: Fixture["ctx"]) => Promise<void>, string]> = [
      ["stale Stage", async ctx => {
        const state = await getEditorialApprovalReadModel({ actorUserId: ctx.adminId, workspaceId: ctx.workspaceId, workItemId: ctx.workItemId });
        await approveEditorialDraft({
          actorUserId: ctx.adminId,
          workspaceId: ctx.workspaceId,
          workItemId: ctx.workItemId,
          expectedDraftId: state.latestDraft!.id,
          expectedDraftVersion: state.latestDraft!.version,
          expectedDraftSha256: state.latestDraft!.draftSha256,
          expectedCheckerRunId: state.qc.checkerRunId!,
          expectedQcEvidenceSha256: state.qc.qcEvidenceSha256!,
          idempotencyKey: "stale-stage-new-approval",
        });
      }, "STAGE_NOT_READY"],
      ["stale Draft", async ctx => {
        const surface = await getAuthorEditorialSurface(ctx.scope);
        await applyEditorialEditorEdit({
          actorUserId: ctx.adminId,
          workspaceId: ctx.workspaceId,
          workItemId: ctx.workItemId,
          ...tabEdit(surface, "แอดมินแก้หลังขอเผยแพร่", "stale-draft-admin-edit"),
        });
      }, "STAGE_NOT_READY"],
      ["stale QC (workspace allow-list changed)", async ctx => {
        await db().insert(workspaceEditorialCheckerAllowWords).values({
          workspaceId: ctx.workspaceId,
          normalizedWord: "r10a-r1b-allow",
          displayWord: "r10a-r1b-allow",
          status: "active",
          createdByUserId: ctx.adminId,
        });
      }, "STAGE_NOT_READY"],
      ["revoked Author ownership", async ctx => {
        await db().update(novels).set({ authorUserId: ctx.otherAuthorId }).where(eq(novels.id, ctx.novelId));
      }, "STAGE_NOT_READY"],
    ];
    const observed = [];
    const expected = [];
    for (const [label, mutate, code] of cases) {
      const { ctx } = await buildFixture(label.replace(/\s+/g, "-").toLowerCase());
      await mutate(ctx);
      const { provider, calls } = localProvider();
      const outcome = await runWorker(ctx, provider).then(
        result => ({ resolved: (result as any).result?.status ?? "claim_miss" }),
        error => ({ rejected: error?.code ?? error?.message }),
      );
      observed.push({
        label,
        outcome,
        executed: calls.execute,
        episodePublished: (await episodeRow(ctx)).isPublished,
        cardPublished: (await columnKey(ctx)) === "published",
        outbox: (await publishState(ctx)).outbox.status,
      });
      expected.push({
        label,
        outcome: { rejected: code },
        executed: 0,
        episodePublished: false,
        cardPublished: false,
        outbox: "failed",
      });
    }
    expect(observed).toEqual(expected);
  }, 240000);

  it("refuses changed Episode content after the Admin request", async () => {
    const { ctx } = await buildFixture("episode-drift");
    await db()
      .update(episodes)
      .set({ content: "เนื้อหาถูกแก้จากภายนอกหลังขอเผยแพร่" })
      .where(eq(episodes.id, ctx.episodeId));
    const { provider, calls } = localProvider();
    await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect(calls.execute).toBe(0);
    expect((await episodeRow(ctx)).isPublished).toBe(false);
    expect(await columnKey(ctx)).toBe("ready_to_publish");
  }, 90000);

  it("refuses an unauthorized worker scope and ownership drift", async () => {
    const { ctx } = await buildFixture("scope");
    const { provider, calls } = localProvider();
    const wrongEpoch = await runScopedPublishWorkerOnce({
      scope: { ...ctx.enqueued!.scope, expectedCutoverEpoch: 2 },
      leaseOwner: "wrong-epoch",
      provider,
      executionEnabled: true,
      allowExternalProvider: false,
    });
    expect(wrongEpoch.claimed).toBe(false);
    await expect(runScopedPublishWorkerOnce({
      scope: { ...ctx.enqueued!.scope, expectedOwnershipVersion: ctx.enqueued!.scope.expectedOwnershipVersion + 7 },
      leaseOwner: "wrong-version",
      provider,
      executionEnabled: true,
      allowExternalProvider: false,
    })).rejects.toBeTruthy();
    await makeOutboxAvailable(ctx);
    await db()
      .update(workspaceOutbox)
      .set({ status: "pending", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
    await db()
      .update(workspaceMigrationRegistry)
      .set({ cutoverEpoch: 2 })
      .where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, ctx.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish"),
      ));
    const drifted = await runWorker(ctx, provider).catch((error: any) => ({ error }));
    expect((drifted as any).claimed === true && (drifted as any).result?.status === "published").toBe(false);
    expect(calls.execute).toBe(0);
    await expectNotPublished(ctx);
  }, 90000);

  it("retries a failed provider execution and recovers a crash after provider commit", async () => {
    const failing = await buildFixture("retry");
    const first = localProvider({ failFirstExecute: true });
    const failed = await runWorker(failing.ctx, first.provider);
    expect((failed as any).result.status).toBe("failed");
    await expectNotPublished(failing.ctx);
    expect((await publishState(failing.ctx)).outbox.status).toBe("failed");
    await makeOutboxAvailable(failing.ctx);
    const retried = await runWorker(failing.ctx, first.provider);
    expect((retried as any).result.status).toBe("published");
    expect(first.calls.execute).toBe(2);
    expect((await episodeRow(failing.ctx)).isPublished).toBe(true);
    expect(await columnKey(failing.ctx)).toBe("published");

    const crashing = await buildFixture("crash");
    const crash = localProvider({ crashAfterExecute: true });
    await expect(runWorker(crashing.ctx, crash.provider)).rejects.toThrow("worker crashed after provider commit");
    expect((await episodeRow(crashing.ctx)).isPublished).toBe(true);
    expect(await columnKey(crashing.ctx)).toBe("ready_to_publish");
    expect((await publishState(crashing.ctx)).outbox.status).toBe("failed");
    await makeOutboxAvailable(crashing.ctx);
    const events: string[] = [];
    const recovered = await runWorker(crashing.ctx, crash.provider, event => events.push(event.type));
    expect((recovered as any).result.status).toBe("published");
    expect(events).toContain("reconcile_hit");
    expect(events).not.toContain("execute_start");
    expect(crash.calls.execute).toBe(1);
    expect(await columnKey(crashing.ctx)).toBe("published");
  }, 180000);

  it("keeps Admin-created Stage publish and its creator provenance check", async () => {
    const { ctx } = await buildFixture("admin-stage", { requestPublish: false });
    const state = await getEditorialApprovalReadModel({ actorUserId: ctx.adminId, workspaceId: ctx.workspaceId, workItemId: ctx.workItemId });
    const approval = await approveEditorialDraft({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
      expectedDraftId: state.latestDraft!.id,
      expectedDraftVersion: state.latestDraft!.version,
      expectedDraftSha256: state.latestDraft!.draftSha256,
      expectedCheckerRunId: state.qc.checkerRunId!,
      expectedQcEvidenceSha256: state.qc.qcEvidenceSha256!,
      idempotencyKey: "admin-stage-approve",
    });
    const staged = await stageEditorialEpisodeDraft({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
      approvalId: approval.approval.id,
      expectedDraftId: state.latestDraft!.id,
      expectedDraftVersion: state.latestDraft!.version,
      expectedDraftSha256: state.latestDraft!.draftSha256,
      idempotencyKey: "admin-stage",
    });
    expect(staged.stage!.stagedByUserId).toBe(ctx.adminId);
    const prepared = await getEditorialPublishReadModel({ actorUserId: ctx.adminId, workspaceId: ctx.workspaceId, workItemId: ctx.workItemId });
    expect(prepared.requestReady).toBe(true);
    ctx.enqueued = await requestEditorialPublish({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
      expectedStageSetSha256: prepared.stageSetSha256!,
      expectedStagedDraftSha256: prepared.stages[0]!.stagedDraftSha256,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: prepared.ownership!.version,
      executionEnabled: true,
    });
    await makeOutboxAvailable(ctx);

    try {
      await db().update(users).set({ role: "user" }).where(eq(users.id, ctx.adminId));
      const { provider, calls } = localProvider();
      await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
      expect(calls.execute).toBe(0);
      expect((await episodeRow(ctx)).isPublished).toBe(false);
      await db().update(users).set({ role: "admin" }).where(eq(users.id, ctx.adminId));
      await makeOutboxAvailable(ctx);
      const published = await runWorker(ctx, provider);
      expect((published as any).result.status).toBe("published");
      expect((await episodeRow(ctx)).isPublished).toBe(true);
      expect(await columnKey(ctx)).toBe("published");
    } finally {
      await db().update(users).set({ role: "admin" }).where(eq(users.id, ctx.adminId));
    }
  }, 120000);
});
