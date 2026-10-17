import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceAuditEvents,
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
  editAuthorEditorialDraft,
  getAuthorEditorialSurface,
  runAuthorEditorialChecker,
  stageAuthorEditorialDraft,
  approveAuthorEditorialDraft,
} from "./authorEditorial.service";
import {
  EDITORIAL_EPISODE_STAGE_CONTRACT,
  editorialEpisodeStateSha256,
} from "./editorialApproval.domain";
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
import { requestPublishExecution } from "./publishExecution.service";
import { bindPublicationNovel, createWorkspace } from "./service";

// Publish TOCTOU regression (IPE-070R4B-R4A-R10A-R1C reproduction, R1D repair).
//
// processClaimedPublishOutbox runs beforeProviderExecute (the
// assertEditorialPublishRequestCurrent preflight) and only then awaits
// provider.execute(request). The barrier provider below runs strictly inside
// that window: preflight has passed and the real provider has not yet opened
// its Episode-row-locked transaction. A dedicated raw mysql2 connection
// commits the Episode mutation inside the window, then the barrier delegates
// to the real provider, which must reject the changed row under its lock.
//
// Local MySQL only (TEST_DATABASE_URL, database "ipenovel_test"); the real
// provider touches only the database and the Google Docs adapter is mocked.

const RUN = Boolean(process.env.TEST_DATABASE_URL);
const db = () => getTestDb();

const MUTATED_CONTENT = "เนื้อหาถูกแทรกจากภายนอกหลัง preflight ผ่านแล้ว (TOCTOU R10A-R1C probe)";

function wordCountOf(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A dedicated connection, separate from every pool the services use. */
async function openSeparateConnection() {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  return mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  });
}

/** Commits the controlled mutation from its own connection. */
async function mutateEpisodeContent(episodeId: number) {
  const conn = await openSeparateConnection();
  try {
    await conn.execute(
      "UPDATE episodes SET content = ?, wordCount = ? WHERE id = ?",
      [MUTATED_CONTENT, wordCountOf(MUTATED_CONTENT), episodeId],
    );
  } finally {
    await conn.end();
  }
}

type Barrier = {
  mutate: boolean;
  /** Mutate only on this execute call (1-based); default every call. */
  mutateOnCall?: number;
  /** Return a transient provider failure on the first call without delegating. */
  failFirst?: boolean;
};

/**
 * Test-only provider configuration: the real in-repo provider behind a
 * barrier wrapper (mode "mock" so the worker accepts it without the external
 * provider opt-in). The wrapper is the synchronization point: it runs after
 * the preflight and before the real provider's row-locked transaction.
 */
function barrierProvider(
  barrier: Barrier,
  timeline: string[],
): { provider: WorkspacePublishProvider; executeCalls: () => number; realExecuteCalls: () => number } {
  const real = createIpeNovelWorkspacePublishProvider();
  let executeCalls = 0;
  let realExecuteCalls = 0;
  const provider: WorkspacePublishProvider = {
    mode: "mock",
    async reconcile(request) {
      return real.reconcile(request);
    },
    async execute(request) {
      executeCalls += 1;
      timeline.push("window_enter");
      if (barrier.failFirst && executeCalls === 1) {
        timeline.push("execute_failed");
        return { status: "failed", errorClass: "TRANSIENT_PROVIDER_FAILURE" };
      }
      if (barrier.mutate && (barrier.mutateOnCall === undefined || barrier.mutateOnCall === executeCalls)) {
        await mutateEpisodeContent(request.episodeId!);
        timeline.push("mutation_committed");
      }
      realExecuteCalls += 1;
      try {
        const result = await real.execute(request);
        timeline.push(`execute_${result.status}`);
        return result;
      } catch (error: any) {
        timeline.push(`execute_threw_${error?.code ?? "unknown"}`);
        throw error;
      }
    },
  };
  return { provider, executeCalls: () => executeCalls, realExecuteCalls: () => realExecuteCalls };
}

function source(revisionKey: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: `uploaded-file:${revisionKey}`,
    mimeType: "text/plain",
    title: "episode-21.txt",
    revisionKey,
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 21",
      paragraphs: ["บทที่ 21 ชื่อบท", "เนื้อหาสะอาดตรงตามที่ตรวจแล้ว", "จบตอน"],
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

type Fixture = Awaited<ReturnType<typeof buildFixture>>;
const fixtures: Fixture[] = [];

/**
 * Isolated unpublished V2 Stage with immutable approval, QC and content-hash
 * evidence, plus an actual Admin-authorized Controlled Publish request and
 * claimed Outbox. Mirrors the qualified R10A-R1B fixture end to end.
 */
async function buildFixture(label: string) {
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL!);
  const admin = await createTestUser({ role: "admin" });
  const author = await createTestUser({ role: "author" });
  const novel = await createTestNovel();
  const workspace = await createWorkspace(admin.id, `TOCTOU ${label}`);
  const ctx = {
    label,
    adminId: admin.id,
    authorId: author.id,
    novelId: novel.id,
    workspaceId: workspace.workspaceId,
    workspaceNovelId: 0,
    boardId: 0,
    cardId: 0,
    workItemId: 0,
    episodeId: 0,
    approvalId: 0,
    stage: null as any,
    stagedContent: "",
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
    episodeNumber: "21",
    episodeTitle: "ชื่อจาก Intake",
    saleMode: "package",
    price: "21.00",
    isFree: false,
  });
  ctx.workItemId = created.board?.columns.flatMap(column => column.cards)
    .find(item => item.workItemType === "NEW_EPISODE" && item.episodeNumber === "21")!.workItemId!;
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
  expect(ctx.stage.stageContract).toBe("workspace-editorial-episode-stage-v2");
  const [episodeRow] = await db().select().from(episodes).where(eq(episodes.id, ctx.episodeId));
  ctx.stagedContent = episodeRow.content;
  expect(episodeRow.isPublished).toBe(false);

  const connection = await saveGoogleConnection({
    userId: admin.id,
    providerSubject: `toctou-${label}-${admin.id}`,
    credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.toctou.ciphertext.tag" },
    grantedScopes:
      "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
  });
  const binding = await bindGoogleDocument({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workspaceNovelId: ctx.workspaceNovelId,
    connectionId: connection.connectionId,
    providerFileId: `doc_toctou_${label}_${admin.id}`,
    mimeType: GOOGLE_DOC_MIME_TYPE,
    title: "TOCTOU publish anchor",
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
        providerFileId: `doc_toctou_${label}_${admin.id}`,
        revision: `${label}-rev-1`,
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "TOCTOU publish anchor",
      })),
      getNormalizedText: vi.fn(async () => "TOCTOU publish anchor"),
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
  ctx.enqueued = await requestEditorialPublish({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    expectedStageSetSha256: prepared.stageSetSha256!,
    expectedStagedDraftSha256: prepared.stages[0]!.stagedDraftSha256,
    expectedCutoverEpoch: 1,
    expectedOwnershipVersion: prepared.ownership!.version,
    executionEnabled: true,
  });
  await db()
    .update(workspaceOutbox)
    .set({ availableAt: new Date(Date.now() - 1_000) })
    .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
  return ctx;
}

async function columnKey(ctx: Fixture) {
  const [row] = await db()
    .select({ key: workspaceKanbanColumns.key })
    .from(workspaceKanbanCards)
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
    .where(eq(workspaceKanbanCards.id, ctx.cardId));
  return row?.key ?? null;
}

async function episodeRow(ctx: Fixture) {
  const [row] = await db().select().from(episodes).where(eq(episodes.id, ctx.episodeId));
  return row;
}

async function publishState(ctx: Fixture) {
  const runId = ctx.enqueued!.scope.runId;
  const [run] = await db().select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, runId));
  const items = await db().select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, runId));
  const [outbox] = await db().select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, runId));
  return { run, items, outbox };
}

async function receiptEvents(ctx: Fixture) {
  return db()
    .select()
    .from(workspaceAuditEvents)
    .where(and(
      eq(workspaceAuditEvents.workspaceId, ctx.workspaceId),
      eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
    ));
}

function runWorker(ctx: Fixture, provider: WorkspacePublishProvider, observer?: (event: WorkspacePublishObservation) => void) {
  return runScopedPublishWorkerOnce({
    scope: ctx.enqueued!.scope,
    leaseOwner: `toctou-worker-${ctx.adminId}-${ctx.label}`,
    provider,
    executionEnabled: true,
    allowExternalProvider: false,
    observer,
  });
}

/** Rewrites the fully-authorized V2 Stage row into its Legacy (v1) shape. */
async function rewriteStageAsLegacy(ctx: Fixture) {
  const [episode] = await db().select().from(episodes).where(eq(episodes.id, ctx.episodeId));
  const legacyState = editorialEpisodeStateSha256({
    novelId: episode.novelId,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    content: episode.content,
    contentFormat: episode.contentFormat,
    wordCount: episode.wordCount,
    isPublished: episode.isPublished,
  });
  await db()
    .update(workspaceEditorialEpisodeStages)
    .set({
      stageContract: EDITORIAL_EPISODE_STAGE_CONTRACT,
      episodeStateSha256: legacyState,
    })
    .where(eq(workspaceEditorialEpisodeStages.id, ctx.stage.id));
}

afterAll(async () => {
  if (!RUN) return;
  for (const ctx of fixtures) {
    await db().delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, ctx.boardId));
    await db().delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
    await db().delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, ctx.adminId));
    await db().delete(episodes).where(eq(episodes.novelId, ctx.novelId));
    await db().delete(novels).where(eq(novels.id, ctx.novelId));
    for (const id of [ctx.adminId, ctx.authorId]) await db().delete(users).where(eq(users.id, id));
  }
});

async function transitionsIntoPublished(ctx: Fixture) {
  const [published] = await db()
    .select({ id: workspaceKanbanColumns.id })
    .from(workspaceKanbanColumns)
    .where(and(eq(workspaceKanbanColumns.boardId, ctx.boardId), eq(workspaceKanbanColumns.key, "published")));
  const rows = await db()
    .select({ id: workspaceKanbanTransitions.id })
    .from(workspaceKanbanTransitions)
    .where(and(eq(workspaceKanbanTransitions.cardId, ctx.cardId), eq(workspaceKanbanTransitions.toColumnId, published.id)));
  return rows.length;
}

/** Durable evidence a rejected provider transaction must leave untouched. */
async function evidenceSnapshot(ctx: Fixture) {
  const stages = await db()
    .select()
    .from(workspaceEditorialEpisodeStages)
    .where(eq(workspaceEditorialEpisodeStages.workItemId, ctx.workItemId));
  const approvals = await db()
    .select()
    .from(workspaceEditorialDraftApprovals)
    .where(eq(workspaceEditorialDraftApprovals.workItemId, ctx.workItemId));
  return {
    stages,
    approvals,
    receipts: (await receiptEvents(ctx)).length,
    publishedTransitions: await transitionsIntoPublished(ctx),
  };
}

/** Episode fields the provider would write when publishing. */
function publishFields(row: any) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    contentFormat: row.contentFormat,
    wordCount: row.wordCount,
    isPublished: row.isPublished,
    publishedAt: row.publishedAt,
    saleMode: row.saleMode,
    price: row.price,
    isFree: row.isFree,
    fileUrl: row.fileUrl,
    fileSize: row.fileSize,
    fileMimeType: row.fileMimeType,
  };
}

/** The Episode as the test's own out-of-band mutation left it, with no publish write on top. */
function afterTestMutation(before: any) {
  return publishFields({ ...before, content: MUTATED_CONTENT, wordCount: wordCountOf(MUTATED_CONTENT) });
}

async function expectRejectedPublish(
  ctx: Fixture,
  before: Awaited<ReturnType<typeof evidenceSnapshot>>,
  episodeBefore: any,
) {
  expect(await evidenceSnapshot(ctx)).toEqual(before);
  expect(publishFields(await episodeRow(ctx))).toEqual(afterTestMutation(episodeBefore));
  expect(await columnKey(ctx)).toBe("ready_to_publish");
  const state = await publishState(ctx);
  expect(state.run.status).not.toBe("published");
  expect(state.items).toHaveLength(1);
  expect(state.items[0]!.status).not.toBe("published");
  expect(state.items[0]!.providerReceipt).toBeNull();
  expect(state.outbox).toMatchObject({ status: "failed", leaseOwner: null, leaseExpiresAt: null });
  expect(state.outbox.deliveredAt).toBeNull();
}

async function stageAdminReplacement(ctx: Fixture, label: string) {
  const { provider } = barrierProvider({ mutate: false }, []);
  expect((await runWorker(ctx, provider) as any).result.status).toBe("published");
  const surface = await getAuthorEditorialSurface(ctx.scope);
  const edited = await applyEditorialEditorEdit({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    ...tabEdit(surface, "บรรณาธิการแก้เพื่อเข้ามาแทนที่", `${label}-admin-edit`),
  });
  await runEditorialForeignChecker({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    expectedDraftId: edited.draft.id,
  });
  const state = await getEditorialApprovalReadModel({ actorUserId: ctx.adminId, workspaceId: ctx.workspaceId, workItemId: ctx.workItemId });
  const approved = await approveEditorialDraft({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    expectedDraftId: state.latestDraft!.id,
    expectedDraftVersion: state.latestDraft!.version,
    expectedDraftSha256: state.latestDraft!.draftSha256,
    expectedCheckerRunId: state.qc.checkerRunId!,
    expectedQcEvidenceSha256: state.qc.qcEvidenceSha256!,
    idempotencyKey: `${label}-approve`,
  });
  const staged = await stageEditorialEpisodeDraft({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
    approvalId: approved.approval.id,
    expectedDraftId: state.latestDraft!.id,
    expectedDraftVersion: state.latestDraft!.version,
    expectedDraftSha256: state.latestDraft!.draftSha256,
    idempotencyKey: `${label}-stage`,
  });
  expect(staged.stage!.stageContract).toBe("workspace-editorial-episode-stage-v3");
  expect(staged.episode!.id).toBe(ctx.episodeId);
  const prepared = await getEditorialPublishReadModel({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
  });
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
  await db()
    .update(workspaceOutbox)
    .set({ availableAt: new Date(Date.now() - 1_000) })
    .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
  return { staged, published: await episodeRow(ctx) };
}

async function providerRequest(ctx: Fixture): Promise<WorkspacePublishProviderRequest> {
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

function expectWindowOrdering(timeline: string[]) {
  expect(timeline.indexOf("execute_start")).toBeGreaterThanOrEqual(0);
  expect(timeline.indexOf("execute_start")).toBeLessThan(timeline.indexOf("window_enter"));
  expect(timeline.indexOf("window_enter")).toBeLessThan(timeline.indexOf("mutation_committed"));
  expect(timeline.indexOf("mutation_committed")).toBeLessThan(timeline.indexOf("execute_threw_TARGET_CHANGED"));
  expect(timeline).not.toContain("execute_published");
}

describe.skipIf(!RUN)("Controlled Publish TOCTOU between preflight and provider Episode lock", () => {
  it("V2 unchanged: the Author-created Stage publishes its staged content through the Admin request", async () => {
    const ctx = await buildFixture("v2-unchanged");
    expect(ctx.stage.stagedByUserId).toBe(ctx.authorId);
    const { provider, executeCalls } = barrierProvider({ mutate: false }, []);

    const outcome = await runWorker(ctx, provider);

    expect((outcome as any).result.status).toBe("published");
    expect(executeCalls()).toBe(1);
    const live = await episodeRow(ctx);
    expect(live.isPublished).toBe(true);
    expect(live.content).toBe(ctx.stagedContent);
    expect(sha256(String(live.content))).toBe(String(ctx.stage.contentSha256).toLowerCase());
    expect(await columnKey(ctx)).toBe("published");
    const state = await publishState(ctx);
    expect(state.run.status).toBe("published");
    expect(state.outbox.status).toBe("delivered");
    expect(state.items[0]).toMatchObject({ status: "published", sourceSha256: ctx.stage.contentSha256 });
    const receipts = await receiptEvents(ctx);
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]!.metadataJson).sourceSha256).toBe(String(ctx.stage.contentSha256).toLowerCase());
  }, 180000);

  it("V2 mutation after preflight: provider rejects TARGET_CHANGED under the Episode lock", async () => {
    const ctx = await buildFixture("v2-toctou");
    const before = await evidenceSnapshot(ctx);
    const episodeBefore = await episodeRow(ctx);
    const timeline: string[] = [];
    const { provider, executeCalls } = barrierProvider({ mutate: true }, timeline);

    await expect(runWorker(ctx, provider, event => timeline.push(event.type)))
      .rejects.toMatchObject({ code: "TARGET_CHANGED" });

    expect(executeCalls()).toBe(1);
    expectWindowOrdering(timeline);
    await expectRejectedPublish(ctx, before, episodeBefore);
    expect(timeline).toContain("outbox_failed");
  }, 180000);

  it("Legacy unchanged: an emulated v1 Stage publishes its staged content", async () => {
    const ctx = await buildFixture("legacy-unchanged");
    await rewriteStageAsLegacy(ctx);
    const { provider, executeCalls } = barrierProvider({ mutate: false }, []);

    const outcome = await runWorker(ctx, provider);

    expect((outcome as any).result.status).toBe("published");
    expect(executeCalls()).toBe(1);
    const live = await episodeRow(ctx);
    expect(live.isPublished).toBe(true);
    expect(live.content).toBe(ctx.stagedContent);
    expect(await columnKey(ctx)).toBe("published");
  }, 180000);

  it("Legacy mutation after preflight: provider rejects TARGET_CHANGED under the Episode lock", async () => {
    const ctx = await buildFixture("legacy-toctou");
    await rewriteStageAsLegacy(ctx);
    const before = await evidenceSnapshot(ctx);
    const episodeBefore = await episodeRow(ctx);
    const timeline: string[] = [];
    const { provider, executeCalls } = barrierProvider({ mutate: true }, timeline);

    await expect(runWorker(ctx, provider, event => timeline.push(event.type)))
      .rejects.toMatchObject({ code: "TARGET_CHANGED" });

    expect(executeCalls()).toBe(1);
    expectWindowOrdering(timeline);
    await expectRejectedPublish(ctx, before, episodeBefore);
  }, 180000);

  it("V3 unchanged: the Admin replacement publishes the new staged content on the same Episode id", async () => {
    const ctx = await buildFixture("v3-unchanged");
    const { staged, published } = await stageAdminReplacement(ctx, "v3-unchanged");
    const { provider } = barrierProvider({ mutate: false }, []);

    expect((await runWorker(ctx, provider) as any).result.status).toBe("published");

    const replaced = await episodeRow(ctx);
    expect(replaced.id).toBe(ctx.episodeId);
    expect(replaced.isPublished).toBe(true);
    expect(replaced.content).not.toBe(published.content);
    expect(replaced.title).toBe(staged.stage!.episodeTitle);
    expect(replaced.publishedAt).toEqual(published.publishedAt);
    expect(await columnKey(ctx)).toBe("published");
    const replacementReceipt = (await receiptEvents(ctx)).map(event => JSON.parse(event.metadataJson))
      .find(metadata => metadata.editorialReplacement);
    expect(replacementReceipt.editorialReplacement.stageId).toBe(staged.stage!.id);
  }, 240000);

  it("V3 mutation after preflight: provider rejects TARGET_CHANGED and keeps the live Episode", async () => {
    const ctx = await buildFixture("v3-toctou");
    const { published } = await stageAdminReplacement(ctx, "v3-toctou");
    const before = await evidenceSnapshot(ctx);
    const timeline: string[] = [];
    const { provider, executeCalls } = barrierProvider({ mutate: true }, timeline);

    await expect(runWorker(ctx, provider, event => timeline.push(event.type)))
      .rejects.toMatchObject({ code: "TARGET_CHANGED" });

    expect(executeCalls()).toBe(1);
    expectWindowOrdering(timeline);
    expect(await evidenceSnapshot(ctx)).toEqual(before);
    expect(publishFields(await episodeRow(ctx))).toEqual(afterTestMutation(published));
    expect(await columnKey(ctx)).toBe("ready_to_publish");
    const state = await publishState(ctx);
    expect(state.items[0]!.providerReceipt).toBeNull();
    expect(state.run.status).not.toBe("published");
    expect(state.outbox.status).toBe("failed");
  }, 240000);

  it("existing receipt recovery returns the stored receipt without a second publish, even though the row is now live", async () => {
    const ctx = await buildFixture("receipt-recovery");
    const { provider } = barrierProvider({ mutate: false }, []);
    expect((await runWorker(ctx, provider) as any).result.status).toBe("published");
    const live = await episodeRow(ctx);
    const receiptsBefore = await receiptEvents(ctx);
    const request = await providerRequest(ctx);

    const replay = await createIpeNovelWorkspacePublishProvider().execute(request);

    expect(replay).toEqual({ status: "published", providerReceipt: receiptsBefore[0] && JSON.parse(receiptsBefore[0].metadataJson).providerReceipt });
    expect(await receiptEvents(ctx)).toEqual(receiptsBefore);
    expect(publishFields(await episodeRow(ctx))).toEqual(publishFields(live));
  }, 180000);

  it("provider retry re-enforces the locked-row check, then publishes once the staged content is restored", async () => {
    const ctx = await buildFixture("retry");
    const before = await evidenceSnapshot(ctx);
    const episodeBefore = await episodeRow(ctx);
    const timeline: string[] = [];
    const { provider, executeCalls, realExecuteCalls } = barrierProvider(
      { mutate: true, mutateOnCall: 2, failFirst: true },
      timeline,
    );

    const first = await runWorker(ctx, provider);
    expect((first as any).result.status).toBe("failed");
    expect((await publishState(ctx)).outbox.status).toBe("failed");
    expect(realExecuteCalls()).toBe(0);

    await db()
      .update(workspaceOutbox)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
    await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    expect(executeCalls()).toBe(2);
    expect(realExecuteCalls()).toBe(1);
    expect(await evidenceSnapshot(ctx)).toEqual(before);
    expect(publishFields(await episodeRow(ctx))).toEqual(afterTestMutation(episodeBefore));
    const rejected = await publishState(ctx);
    expect(rejected.items[0]!.providerReceipt).toBeNull();
    expect(rejected.outbox.status).toBe("failed");
    expect(rejected.outbox.attempts).toBe(2);
    expect(await columnKey(ctx)).toBe("ready_to_publish");

    await db()
      .update(episodes)
      .set({ content: episodeBefore.content, wordCount: episodeBefore.wordCount })
      .where(eq(episodes.id, ctx.episodeId));
    await db()
      .update(workspaceOutbox)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceOutbox.publishRunId, ctx.enqueued!.scope.runId));
    const recovered = await runWorker(ctx, provider);
    expect((recovered as any).result.status).toBe("published");
    expect(realExecuteCalls()).toBe(2);
    const live = await episodeRow(ctx);
    expect(live.isPublished).toBe(true);
    expect(live.content).toBe(ctx.stagedContent);
    expect(await columnKey(ctx)).toBe("published");
    expect(await receiptEvents(ctx)).toHaveLength(1);
  }, 240000);

  it("provider fails closed when an editorial item key does not resolve to its Stage", async () => {
    const ctx = await buildFixture("forged-stage");
    const request = await providerRequest(ctx);
    const episodeBefore = await episodeRow(ctx);
    const before = await evidenceSnapshot(ctx);
    const real = createIpeNovelWorkspacePublishProvider();
    const forged: Array<[string, Partial<WorkspacePublishProviderRequest>]> = [
      ["missing Stage", { itemKey: `editorial-stage:999999999:episode:${ctx.episodeId}` }],
      ["Stage for another episode", { itemKey: `editorial-stage:${ctx.stage.id}:episode:${ctx.episodeId + 1}` }],
      ["content hash mismatch", { sourceSha256: "0".repeat(64) }],
      ["other novel", { targetId: ctx.novelId + 100000 }],
    ];
    for (const [label, patch] of forged) {
      await expect(real.execute({ ...request, ...patch }), label).rejects.toMatchObject(
        label === "other novel" ? { code: "TARGET_NOT_FOUND" } : { code: "TARGET_CHANGED" },
      );
    }
    expect(publishFields(await episodeRow(ctx))).toEqual(publishFields(episodeBefore));
    expect(await evidenceSnapshot(ctx)).toEqual(before);
  }, 180000);

  it("keeps Controlled Publish Admin-only for the Author", async () => {
    const ctx = await buildFixture("author-denied");
    const prepared = await getEditorialPublishReadModel({
      actorUserId: ctx.adminId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
    });
    await expect(requestEditorialPublish({
      actorUserId: ctx.authorId,
      workspaceId: ctx.workspaceId,
      workItemId: ctx.workItemId,
      expectedStageSetSha256: prepared.stageSetSha256 ?? "0".repeat(64),
      expectedStagedDraftSha256: ctx.stage.stagedDraftSha256,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: prepared.ownership!.version,
      executionEnabled: true,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(requestPublishExecution({
      actorUserId: ctx.authorId,
      workspaceId: ctx.workspaceId,
      runId: ctx.enqueued!.scope.runId,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: prepared.ownership!.version,
      executionEnabled: true,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect((await episodeRow(ctx)).isPublished).toBe(false);
  }, 180000);
});
