import { and, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceAuditEvents,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspaceNovels,
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
import { approveEditorialDraft, stageEditorialEpisodeDraft } from "./editorialApproval.service";
import { createEditorialEpisodeWorkItem, ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource, type EditorialSourcePayload } from "./editorialDraft.service";
import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import {
  WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
  type WorkspacePublishProvider,
  type WorkspacePublishProviderRequest,
} from "./publishExecution.domain";
import { runScopedPublishWorkerOnce } from "./publishExecution.runtime";
import {
  assertEditorialPublishRequestCurrent,
  getEditorialPublishReadModel,
  reconcileEditorialPublishRun,
  requestEditorialPublish,
} from "./editorialPublish.service";
import { requestPublishExecution } from "./publishExecution.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { publishLockBarrier } from "./publishLockOrder";
import { isWorkspaceTransactionDeadlock } from "./transactionRetry";
import { bindPublicationNovel, createWorkspace } from "./service";

const RUN = Boolean(process.env.TEST_DATABASE_URL);
const db = () => getTestDb();
const fixtures: Array<{ workspaceId: number }> = [];

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

function tabEdit(surface: Awaited<ReturnType<typeof getAuthorEditorialSurface>>, replacement: string, idempotencyKey: string) {
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

async function buildFixture(label: string) {
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL!);
  const admin = await createTestUser({ role: "admin" });
  const author = await createTestUser({ role: "author" });
  const novel = await createTestNovel();
  const workspace = await createWorkspace(admin.id, `R6A ${label}`);
  const ctx = {
    label,
    adminId: admin.id,
    authorId: author.id,
    novelId: novel.id,
    workspaceId: workspace.workspaceId,
    workspaceNovelId: 0,
    workItemId: 0,
    cardId: 0,
    episodeId: 0,
    approvalId: 0,
    stage: null as any,
    draft: null as any,
    scope: { actorUserId: author.id, workspaceId: workspace.workspaceId, workItemId: 0 },
    enqueued: null as Awaited<ReturnType<typeof requestEditorialPublish>> | null,
  };
  fixtures.push(ctx);
  const bound = await bindPublicationNovel({
    actorUserId: admin.id,
    workspaceId: ctx.workspaceId,
    novelId: novel.id,
  });
  ctx.workspaceNovelId = bound.workspaceNovelId;
  await db().update(novels).set({ authorUserId: author.id }).where(eq(novels.id, novel.id));
  await db().insert(workspaceMembers).values({
    workspaceId: ctx.workspaceId,
    userId: author.id,
    role: "editor",
    status: "active",
  });
  const board = await ensureEditorialBoard({ actorUserId: admin.id, workspaceId: ctx.workspaceId });
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
  const [owned] = await db()
    .select({ cardId: workspaceEditorialWorkItems.cardId })
    .from(workspaceEditorialWorkItems)
    .where(eq(workspaceEditorialWorkItems.id, ctx.workItemId));
  ctx.cardId = owned.cardId!;
  const imported = await getAuthorEditorialSurface(ctx.scope);
  const edited = await editAuthorEditorialDraft({
    ...ctx.scope,
    ...tabEdit(imported, "ผู้เขียนเพิ่มย่อหน้านี้", `${label}-author-edit`),
  });
  ctx.draft = edited.draft;
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
  ctx.draft = ready.draft;
  await anchorAndEnqueue(ctx, label);
  return ctx;
}

async function anchorAndEnqueue(ctx: Awaited<ReturnType<typeof buildFixture>>, label: string) {
  const connection = await saveGoogleConnection({
    userId: ctx.adminId,
    providerSubject: `r6a-${label}-${ctx.adminId}`,
    credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.r6a.ciphertext.tag" },
    grantedScopes:
      "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
  });
  const binding = await bindGoogleDocument({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workspaceNovelId: ctx.workspaceNovelId,
    connectionId: connection.connectionId,
    providerFileId: `doc_r6a_${label}_${ctx.adminId}`,
    mimeType: GOOGLE_DOC_MIME_TYPE,
    title: "R6A publish anchor",
    role: "chapter",
    sequence: 1,
    correlationId: `${label}-bind`,
  });
  await observeBoundGoogleDocument({
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    bindingId: binding.bindingId,
    accessToken: "server-only-test-token",
    correlationId: `${label}-observe`,
    adapter: {
      getMetadata: vi.fn(async () => ({
        providerFileId: `doc_r6a_${label}_${ctx.adminId}`,
        revision: `${label}-rev-1`,
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "R6A publish anchor",
      })),
      getNormalizedText: vi.fn(async () => "R6A publish anchor"),
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
    actorUserId: ctx.adminId,
    workspaceId: ctx.workspaceId,
    workItemId: ctx.workItemId,
  });
  if (!prepared.requestReady) throw new Error(`publish not ready: ${prepared.blocker}`);
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
    .where(eq(workspaceOutbox.publishRunId, ctx.enqueued.scope.runId));
}

function runWorker(ctx: Awaited<ReturnType<typeof buildFixture>>, provider: WorkspacePublishProvider) {
  return runScopedPublishWorkerOnce({
    scope: ctx.enqueued!.scope,
    leaseOwner: `r6a-worker-${ctx.adminId}-${ctx.label}`,
    provider,
    executionEnabled: true,
    allowExternalProvider: false,
  });
}

async function episodePublished(ctx: { episodeId: number }) {
  const [row] = await db().select().from(episodes).where(eq(episodes.id, ctx.episodeId));
  return row;
}

async function receiptCount(ctx: { workspaceId: number; episodeId: number }) {
  const rows = await db()
    .select({ id: workspaceAuditEvents.id })
    .from(workspaceAuditEvents)
    .where(and(
      eq(workspaceAuditEvents.workspaceId, ctx.workspaceId),
      eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
      eq(workspaceAuditEvents.entityId, String(ctx.episodeId)),
    ));
  return rows.length;
}

async function publishedTransitions(ctx: { cardId: number }) {
  const rows = await db()
    .select({ id: workspaceKanbanTransitions.id, reason: workspaceKanbanTransitions.reason })
    .from(workspaceKanbanTransitions)
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanTransitions.toColumnId, workspaceKanbanColumns.id))
    .where(and(
      eq(workspaceKanbanTransitions.cardId, ctx.cardId),
      eq(workspaceKanbanColumns.key, "published"),
    ));
  return rows;
}

async function publishRows(ctx: { enqueued: { scope: { runId: number } } | null }) {
  const runId = ctx.enqueued!.scope.runId;
  const [run] = await db().select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, runId));
  const items = await db().select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, runId));
  const [outbox] = await db().select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, runId));
  return { run, items, outbox };
}

function realProvider(): WorkspacePublishProvider {
  const real = createIpeNovelWorkspacePublishProvider();
  return { mode: "mock", reconcile: request => real.reconcile(request), execute: request => real.execute(request) };
}

describe.skipIf(!RUN)("IPE-070R4B-R6A lock order and provenance", () => {
  afterAll(async () => {
    publishLockBarrier.afterNovelLock = undefined;
  });

  it("runs the author stage replay and the admin publish together five times", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`stage-publish-${i}`);
      const provider = realProvider();
      await Promise.all([
        stageAuthorEditorialDraft({
          ...ctx.scope,
          approvalId: ctx.approvalId,
          expectedDraftId: ctx.draft.id,
          expectedDraftVersion: ctx.draft.version,
          expectedDraftSha256: ctx.draft.draftSha256,
          idempotencyKey: `author-stage:${ctx.approvalId}:${ctx.draft.id}`,
        }),
        runWorker(ctx, provider),
      ]);
      expect((await episodePublished(ctx)).isPublished).toBe(true);
      expect(await receiptCount(ctx)).toBe(1);
      expect(await publishedTransitions(ctx)).toHaveLength(1);
      const rows = await publishRows(ctx);
      expect(rows.run.status).toBe("published");
      expect(rows.outbox.status).toBe("delivered");
      expect(rows.items[0]!.providerReceipt).toBeTruthy();
    }
  }, 600000);

  it("runs an admin stage attempt and the admin publish together five times", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`admin-stage-publish-${i}`);
      const provider = realProvider();
      const stageAttempt = stageEditorialEpisodeDraft({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        approvalId: ctx.approvalId,
        expectedDraftId: ctx.draft.id,
        expectedDraftVersion: ctx.draft.version,
        expectedDraftSha256: ctx.draft.draftSha256,
        idempotencyKey: `admin-stage:${ctx.approvalId}:${ctx.draft.id}`,
      }).then(
        () => "staged" as const,
        (error: { code?: string }) => error.code ?? "threw",
      );
      const [stageResult] = await Promise.all([stageAttempt, runWorker(ctx, provider)]);
      const episode = await episodePublished(ctx);
      const receipts = await receiptCount(ctx);
      const rows = await publishRows(ctx);
      expect(episode.isPublished).toBe(true);
      expect(receipts).toBe(1);
      expect(rows.run.status).toBe("published");
      expect(rows.items[0]!.status).toBe("published");
      expect(ctx.stage.stagedByUserId).toBe(ctx.authorId);
      const [stage] = await db()
        .select({ stagedByUserId: workspaceEditorialEpisodeStages.stagedByUserId })
        .from(workspaceEditorialEpisodeStages)
        .where(eq(workspaceEditorialEpisodeStages.id, ctx.stage.id));
      expect(stage.stagedByUserId).toBe(ctx.authorId);
      expect(["staged", "EPISODE_CONFLICT", "EPISODE_PUBLISHED"]).toContain(stageResult);
    }
  }, 600000);

  it("runs the author approval replay and the admin publish together five times", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`approve-publish-${i}`);
      const ready = await getAuthorEditorialSurface(ctx.scope);
      await Promise.all([
        approveAuthorEditorialDraft({
          ...ctx.scope,
          expectedDraftId: ready.draft!.id,
          expectedDraftVersion: ready.draft!.version,
          expectedDraftSha256: ready.draft!.draftSha256,
          expectedCheckerRunId: ready.approval.checkerRunId!,
          expectedQcEvidenceSha256: ready.approval.qcEvidenceSha256!,
          idempotencyKey: `author-approve:${ready.draft!.id}:${ready.approval.checkerRunId}`,
        }),
        runWorker(ctx, realProvider()),
      ]);
      expect((await episodePublished(ctx)).isPublished).toBe(true);
      expect(await receiptCount(ctx)).toBe(1);
      const rows = await publishRows(ctx);
      expect(rows.outbox.status).toBe("delivered");
    }
  }, 600000);

  it("rejects publish when the author grant is revoked before execution", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`revoke-before-${i}`);
      await db()
        .update(workspaceMembers)
        .set({ status: "removed" })
        .where(and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, ctx.authorId),
        ));
      await expect(runWorker(ctx, realProvider())).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
      expect((await episodePublished(ctx)).isPublished).toBe(false);
      expect(await receiptCount(ctx)).toBe(0);
      expect(await publishedTransitions(ctx)).toHaveLength(0);
      const rows = await publishRows(ctx);
      expect(rows.items[0]!.providerReceipt).toBeNull();
      expect(rows.run.status).not.toBe("published");
      expect(rows.outbox.status).toBe("failed");
    }
  }, 600000);

  it("rejects publish when the author grant is revoked after preflight and before the provider lock", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`revoke-after-preflight-${i}`);
      const real = createIpeNovelWorkspacePublishProvider();
      const provider: WorkspacePublishProvider = {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        async execute(request: WorkspacePublishProviderRequest) {
          await db()
            .update(workspaceMembers)
            .set({ status: "removed" })
            .where(and(
              eq(workspaceMembers.workspaceId, ctx.workspaceId),
              eq(workspaceMembers.userId, ctx.authorId),
            ));
          return real.execute(request);
        },
      };
      await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
      expect((await episodePublished(ctx)).isPublished).toBe(false);
      expect(await receiptCount(ctx)).toBe(0);
      expect(await publishedTransitions(ctx)).toHaveLength(0);
      const rows = await publishRows(ctx);
      expect(rows.items[0]!.status).not.toBe("published");
      expect(rows.outbox.status).toBe("failed");
    }
  }, 600000);

  it("rejects publish when an admin stage creator is demoted before the provider lock", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`admin-demote-${i}`);
      await db()
        .update(workspaceEditorialEpisodeStages)
        .set({ stagedByUserId: ctx.adminId })
        .where(eq(workspaceEditorialEpisodeStages.id, ctx.stage.id));
      const real = createIpeNovelWorkspacePublishProvider();
      const provider: WorkspacePublishProvider = {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        async execute(request: WorkspacePublishProviderRequest) {
          await db().update(users).set({ role: "user" }).where(eq(users.id, ctx.adminId));
          return real.execute(request);
        },
      };
      await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
      expect((await episodePublished(ctx)).isPublished).toBe(false);
      expect(await receiptCount(ctx)).toBe(0);
      const rows = await publishRows(ctx);
      expect(rows.run.status).not.toBe("published");
      expect(rows.outbox.status).toBe("failed");
    }
  }, 600000);

  it("retries the provider transaction after a real InnoDB deadlock", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`deadlock-retry-${i}`);
      const peer = await openSeparateConnection();
      let deadlocks = 0;
      try {
        await peer.query("SET innodb_lock_wait_timeout = 10");
        await peer.beginTransaction();
        await peer.query("SELECT id FROM episodes WHERE id = ? FOR UPDATE", [ctx.episodeId]);
        for (let change = 0; change < 50; change += 1) {
          await peer.query("UPDATE episodes SET wordCount = wordCount + 0 WHERE id = ?", [ctx.episodeId]);
        }
        publishLockBarrier.beforeLocks = async tx => {
          await tx
            .select({ id: novels.id })
            .from(novels)
            .where(eq(novels.id, ctx.novelId))
            .for("update")
            .limit(1);
          const peerNovel = peer
            .query("SELECT id FROM novels WHERE id = ? FOR UPDATE", [ctx.novelId])
            .catch(() => undefined);
          await new Promise(resolve => setTimeout(resolve, 300));
          try {
            await tx
              .select({ id: episodes.id })
              .from(episodes)
              .where(eq(episodes.id, ctx.episodeId))
              .for("update")
              .limit(1);
          } catch (error) {
            if (isWorkspaceTransactionDeadlock(error)) deadlocks += 1;
            await peer.rollback().catch(() => undefined);
            throw error;
          }
          await peer.rollback().catch(() => undefined);
          await peerNovel;
        };
        const real = createIpeNovelWorkspacePublishProvider();
        const request = await providerRequest(ctx);
        const result = await real.execute(request);
        expect(result.status).toBe("published");
        expect(deadlocks).toBe(1);
        expect(await receiptCount(ctx)).toBe(1);
        const again = await real.execute(request);
        expect(again.providerReceipt).toBe(result.providerReceipt);
        expect(await receiptCount(ctx)).toBe(1);
      } finally {
        publishLockBarrier.beforeLocks = undefined;
        publishLockBarrier.afterNovelLock = undefined;
        await peer.rollback().catch(() => undefined);
        await peer.end();
      }
    }
  }, 600000);

  it("keeps one receipt when execute runs again after a successful publish", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`receipt-replay-${i}`);
      const real = createIpeNovelWorkspacePublishProvider();
      const outcome = await runWorker(ctx, {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        execute: request => real.execute(request),
      });
      expect((outcome as { result: { status: string } }).result.status).toBe("published");
      const request = await providerRequest(ctx);
      const again = await real.execute(request);
      expect(again.status).toBe("published");
      expect(await receiptCount(ctx)).toBe(1);
      expect((await episodePublished(ctx)).isPublished).toBe(true);
      const rows = await publishRows(ctx);
      expect(rows.items).toHaveLength(1);
      expect(rows.items[0]!.status).toBe("published");
    }
  }, 600000);

  it("rejects a V2 episode mutation that lands after preflight", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`v2-mismatch-${i}`);
      const before = await episodePublished(ctx);
      const real = createIpeNovelWorkspacePublishProvider();
      const provider: WorkspacePublishProvider = {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        async execute(request) {
          const conn = await openSeparateConnection();
          try {
            await conn.query("UPDATE episodes SET content = ?, wordCount = ? WHERE id = ?", [
              "เนื้อหาถูกแทรกหลัง preflight",
              3,
              ctx.episodeId,
            ]);
          } finally {
            await conn.end();
          }
          return real.execute(request);
        },
      };
      await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
      const after = await episodePublished(ctx);
      expect(after.isPublished).toBe(false);
      expect(after.content).toBe("เนื้อหาถูกแทรกหลัง preflight");
      expect(before.isPublished).toBe(false);
      expect(await receiptCount(ctx)).toBe(0);
      expect(await publishedTransitions(ctx)).toHaveLength(0);
      const rows = await publishRows(ctx);
      expect(rows.items[0]!.providerReceipt).toBeNull();
      expect(rows.outbox.status).toBe("failed");
    }
  }, 600000);

  it("publishes a V3 replacement while an author stage replay is in flight", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`v3-concurrent-${i}`);
      await runWorker(ctx, realProvider());
      const surface = await getAuthorEditorialSurface(ctx.scope);
      const { applyEditorialEditorEdit } = await import("./editorialEditor.service");
      const { runEditorialForeignChecker } = await import("./editorialForeignChecker.service");
      const edited = await applyEditorialEditorEdit({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        ...tabEdit(surface, "บรรณาธิการแก้เพื่อเข้ามาแทนที่", `${ctx.label}-admin-edit`),
      });
      await runEditorialForeignChecker({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        expectedDraftId: edited.draft.id,
      });
      const { getEditorialApprovalReadModel } = await import("./editorialApproval.service");
      const state = await getEditorialApprovalReadModel({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
      });
      const approved = await approveEditorialDraft({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        expectedDraftId: state.latestDraft!.id,
        expectedDraftVersion: state.latestDraft!.version,
        expectedDraftSha256: state.latestDraft!.draftSha256,
        expectedCheckerRunId: state.qc.checkerRunId!,
        expectedQcEvidenceSha256: state.qc.qcEvidenceSha256!,
        idempotencyKey: `admin-approve-v3:${ctx.label}`,
      });
      const staged = await stageEditorialEpisodeDraft({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        approvalId: approved.approval.id,
        expectedDraftId: state.latestDraft!.id,
        expectedDraftVersion: state.latestDraft!.version,
        expectedDraftSha256: state.latestDraft!.draftSha256,
        idempotencyKey: `admin-stage-v3:${ctx.label}`,
      });
      expect(staged.stage.stageContract).toBe("workspace-editorial-episode-stage-v3");
      const prepared = await getEditorialPublishReadModel({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
      });
      const enqueued = await requestEditorialPublish({
        actorUserId: ctx.adminId,
        workspaceId: ctx.workspaceId,
        workItemId: ctx.workItemId,
        expectedStageSetSha256: prepared.stageSetSha256!,
        expectedStagedDraftSha256: prepared.stages[0]!.stagedDraftSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: prepared.ownership!.version,
        executionEnabled: true,
      });
      ctx.enqueued = enqueued;
      await db()
        .update(workspaceOutbox)
        .set({ availableAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaceOutbox.publishRunId, enqueued.scope.runId));
      await Promise.all([
        stageEditorialEpisodeDraft({
          actorUserId: ctx.adminId,
          workspaceId: ctx.workspaceId,
          workItemId: ctx.workItemId,
          approvalId: approved.approval.id,
        expectedDraftId: state.latestDraft!.id,
        expectedDraftVersion: state.latestDraft!.version,
        expectedDraftSha256: state.latestDraft!.draftSha256,
        idempotencyKey: `admin-stage-v3:${ctx.label}`,
      }),
        runWorker(ctx, realProvider()),
      ]);
      const episode = await episodePublished(ctx);
      expect(episode.isPublished).toBe(true);
      expect(episode.content).toContain("บรรณาธิการแก้เพื่อเข้ามาแทนที่");
      expect(await receiptCount(ctx)).toBe(2);
      const rows = await publishRows(ctx);
      expect(rows.run.status).toBe("published");
      expect(rows.items.every(item => item.providerReceipt)).toBe(true);
    }
  }, 600000);

  it("recovers one receipt after the author membership is revoked", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`recover-revoked-${i}`);
      const real = createIpeNovelWorkspacePublishProvider();
      await runWorker(ctx, {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        execute: request => real.execute(request),
      });
      const before = await episodePublished(ctx);
      expect(before.isPublished).toBe(true);
      await db()
        .update(workspaceMembers)
        .set({ status: "removed" })
        .where(and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, ctx.authorId),
        ));
      const request = await providerRequest(ctx);
      const again = await real.execute(request);
      const after = await episodePublished(ctx);
      expect(again.status).toBe("published");
      expect(await receiptCount(ctx)).toBe(1);
      expect(after.content).toBe(before.content);
      expect(after.wordCount).toBe(before.wordCount);
      expect(after.isPublished).toBe(true);
      expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    }
  }, 600000);

  it("recovers one receipt after an admin stage creator is demoted", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`recover-demoted-${i}`);
      await db()
        .update(workspaceEditorialEpisodeStages)
        .set({ stagedByUserId: ctx.adminId })
        .where(eq(workspaceEditorialEpisodeStages.id, ctx.stage.id));
      const real = createIpeNovelWorkspacePublishProvider();
      await runWorker(ctx, {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        execute: request => real.execute(request),
      });
      const before = await episodePublished(ctx);
      await db().update(users).set({ role: "user" }).where(eq(users.id, ctx.adminId));
      const again = await real.execute(await providerRequest(ctx));
      const after = await episodePublished(ctx);
      expect(again.providerReceipt).toBeTruthy();
      expect(await receiptCount(ctx)).toBe(1);
      expect(after.content).toBe(before.content);
      expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    }
  }, 600000);

  it("rejects a new publish after preflight when workspace, link, or ownership is revoked", async () => {
    const cases = [
      {
        name: "workspace-suspended",
        apply: async (ctx: Awaited<ReturnType<typeof buildFixture>>) => {
          await db().update(workspaceWorkspaces).set({ status: "suspended" }).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
        },
      },
      {
        name: "workspace-deleted",
        apply: async (ctx: Awaited<ReturnType<typeof buildFixture>>) => {
          await db().update(workspaceWorkspaces).set({ deletedAt: new Date() }).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
        },
      },
      {
        name: "link-paused",
        apply: async (ctx: Awaited<ReturnType<typeof buildFixture>>) => {
          await db().update(workspaceNovels).set({ status: "paused" }).where(and(
            eq(workspaceNovels.workspaceId, ctx.workspaceId),
            eq(workspaceNovels.novelId, ctx.novelId),
          ));
        },
      },
      {
        name: "novel-transferred",
        apply: async (ctx: Awaited<ReturnType<typeof buildFixture>>) => {
          const other = await createTestUser({ role: "author" });
          await db().update(novels).set({ authorUserId: other.id }).where(eq(novels.id, ctx.novelId));
        },
      },
      {
        name: "member-viewer",
        apply: async (ctx: Awaited<ReturnType<typeof buildFixture>>) => {
          await db().update(workspaceMembers).set({ role: "viewer" }).where(and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.userId, ctx.authorId),
          ));
        },
      },
    ] as const;
    for (const spec of cases) {
      for (let i = 1; i <= 5; i += 1) {
        const ctx = await buildFixture(`${spec.name}-${i}`);
        const real = createIpeNovelWorkspacePublishProvider();
        const provider: WorkspacePublishProvider = {
          mode: "mock",
          reconcile: request => real.reconcile(request),
          async execute(request) {
            await spec.apply(ctx);
            return real.execute(request);
          },
        };
        await expect(runWorker(ctx, provider)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
        expect((await episodePublished(ctx)).isPublished).toBe(false);
        expect(await receiptCount(ctx)).toBe(0);
        expect(await publishedTransitions(ctx)).toHaveLength(0);
        const rows = await publishRows(ctx);
        expect(rows.items[0]!.providerReceipt).toBeNull();
        expect(rows.run.status).not.toBe("published");
      }
    }
  }, 600000);

  it("keeps the first Admin as the publish actor across a second request", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`requester-${i}`);
      const real = createIpeNovelWorkspacePublishProvider();
      await runWorker(ctx, {
        mode: "mock",
        reconcile: request => real.reconcile(request),
        execute: request => real.execute(request),
      });
      const [run] = await db()
        .select()
        .from(workspacePublishRuns)
        .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
      expect(run.requestedByUserId).toBe(ctx.adminId);
      const [transition] = await db()
        .select({ actorUserId: workspaceKanbanTransitions.actorUserId })
        .from(workspaceKanbanTransitions)
        .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanTransitions.toColumnId, workspaceKanbanColumns.id))
        .where(and(
          eq(workspaceKanbanTransitions.cardId, ctx.cardId),
          eq(workspaceKanbanColumns.key, "published"),
        ));
      expect(transition.actorUserId).toBe(ctx.adminId);
      expect(transition.actorUserId).not.toBe(ctx.authorId);
      const [receipt] = await db()
        .select({ actorUserId: workspaceAuditEvents.actorUserId })
        .from(workspaceAuditEvents)
        .where(and(
          eq(workspaceAuditEvents.workspaceId, ctx.workspaceId),
          eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
          eq(workspaceAuditEvents.entityId, String(ctx.episodeId)),
        ));
      expect(receipt.actorUserId).toBe(ctx.adminId);
      const other = await createTestUser({ role: "admin" });
      await requestPublishExecution({
        actorUserId: other.id,
        workspaceId: ctx.workspaceId,
        runId: ctx.enqueued!.scope.runId,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      }).catch(() => undefined);
      const [after] = await db()
        .select({ requestedByUserId: workspacePublishRuns.requestedByUserId })
        .from(workspacePublishRuns)
        .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
      expect(after.requestedByUserId).toBe(ctx.adminId);
      await reconcileEditorialPublishRun({
        workspaceId: ctx.workspaceId,
        runId: ctx.enqueued!.scope.runId,
      });
      expect(await publishedTransitions(ctx)).toHaveLength(1);
    }
  }, 600000);

  it("fails closed for a malformed editorial key without writing the episode", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const ctx = await buildFixture(`bad-key-${i}`);
      const before = await episodePublished(ctx);
      const real = createIpeNovelWorkspacePublishProvider();
      const request = await providerRequest(ctx);
      await expect(real.execute({
        ...request,
        requestKey: `malformed-${ctx.label}`,
        itemKey: "editorial-stage:abc:episode:1",
      })).rejects.toMatchObject({ code: "MALFORMED_EDITORIAL_ITEM_KEY" });
      for (const itemKey of ["editorial-stage_abc", "editorial-stageX", "editorial-stage/abc"]) {
        await expect(real.execute({
          ...request,
          requestKey: `malformed-${ctx.label}-${itemKey}`,
          itemKey,
        })).rejects.toMatchObject({ code: "MALFORMED_EDITORIAL_ITEM_KEY" });
        await expect(assertEditorialPublishRequestCurrent({
          ...request,
          itemKey,
        })).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });
      }
      const after = await episodePublished(ctx);
      expect(after.isPublished).toBe(before.isPublished);
      expect(after.content).toBe(before.content);
      await expect(assertEditorialPublishRequestCurrent({
        ...request,
        itemKey: "editorial-stage:0:episode:1",
      })).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });
      await expect(assertEditorialPublishRequestCurrent({
        ...request,
        itemKey: "chapter-1",
      })).resolves.toEqual({ editorial: false });
      await db().insert(workspacePublishItems).values([
        {
          runId: ctx.enqueued!.scope.runId,
          itemKey: "editorial-stage:abc:episode:1",
          episodeId: ctx.episodeId,
          sourceSha256: "b".repeat(64),
          status: "pending",
        },
        {
          runId: ctx.enqueued!.scope.runId,
          itemKey: "editorial-stage_abc",
          episodeId: ctx.episodeId,
          sourceSha256: "c".repeat(64),
          status: "pending",
        },
        {
          runId: ctx.enqueued!.scope.runId,
          itemKey: "editorial-stageX",
          episodeId: ctx.episodeId,
          sourceSha256: "d".repeat(64),
          status: "pending",
        },
        {
          runId: ctx.enqueued!.scope.runId,
          itemKey: "editorial-stage/abc",
          episodeId: ctx.episodeId,
          sourceSha256: "e".repeat(64),
          status: "pending",
        },
      ]);
      await expect(reconcileEditorialPublishRun({
        workspaceId: ctx.workspaceId,
        runId: ctx.enqueued!.scope.runId,
      })).rejects.toMatchObject({ code: "PUBLISH_STATE_CONFLICT" });
    }
  }, 600000);

  it("does not let a malformed key adopt a committed receipt", async () => {
    const ctx = await buildFixture("malformed-receipt");
    const real = createIpeNovelWorkspacePublishProvider();
    await runWorker(ctx, {
      mode: "mock",
      reconcile: request => real.reconcile(request),
      execute: request => real.execute(request),
    });
    const before = await episodePublished(ctx);
    const request = await providerRequest(ctx);
    await expect(real.execute({
      ...request,
      itemKey: "editorial-stage_abc",
    })).rejects.toMatchObject({ code: "MALFORMED_EDITORIAL_ITEM_KEY" });
    const after = await episodePublished(ctx);
    expect(after.isPublished).toBe(true);
    expect(after.content).toBe(before.content);
    expect(after.updatedAt).toEqual(before.updatedAt);
  }, 180000);

  it("refuses to hard-delete the Admin named by requestedByUserId", async () => {
    const ctx = await buildFixture("fk-requester");
    const real = createIpeNovelWorkspacePublishProvider();
    await runWorker(ctx, {
      mode: "mock",
      reconcile: request => real.reconcile(request),
      execute: request => real.execute(request),
    });
    const connection = await openSeparateConnection();
    try {
      const [rules] = await connection.query(
        "SELECT DELETE_RULE AS deleteRule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'wpr_requested_by_fk'"
      );
      expect(rules).toEqual([{ deleteRule: "NO ACTION" }]);
      await expect(connection.query("DELETE FROM users WHERE id = ?", [ctx.adminId])).rejects.toMatchObject({
        errno: 1451,
      });
    } finally {
      await connection.end();
    }
    const [user] = await db().select({ id: users.id }).from(users).where(eq(users.id, ctx.adminId));
    const [run] = await db()
      .select({ requestedByUserId: workspacePublishRuns.requestedByUserId })
      .from(workspacePublishRuns)
      .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
    expect(user.id).toBe(ctx.adminId);
    expect(run.requestedByUserId).toBe(ctx.adminId);
  }, 180000);

  it("does not attribute a null historical requester to the stage creator", async () => {
    const ctx = await buildFixture("null-requester");
    await db()
      .update(workspacePublishRuns)
      .set({ requestedByUserId: null })
      .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
    const real = createIpeNovelWorkspacePublishProvider();
    await runWorker(ctx, {
      mode: "mock",
      reconcile: request => real.reconcile(request),
      execute: request => real.execute(request),
    });
    expect((await episodePublished(ctx)).isPublished).toBe(true);
    expect(await publishedTransitions(ctx)).toHaveLength(0);
    const [run] = await db()
      .select({ requestedByUserId: workspacePublishRuns.requestedByUserId })
      .from(workspacePublishRuns)
      .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
    expect(run.requestedByUserId).toBeNull();
  }, 180000);
});

async function providerRequest(ctx: Awaited<ReturnType<typeof buildFixture>>): Promise<WorkspacePublishProviderRequest> {
  const { buildPublishItemRequestKey } = await import("./publishExecution.domain");
  const { workspacePublishingDestinations } = await import("../../drizzle/schema");
  const [run] = await db()
    .select()
    .from(workspacePublishRuns)
    .where(eq(workspacePublishRuns.id, ctx.enqueued!.scope.runId));
  const [item] = await db()
    .select()
    .from(workspacePublishItems)
    .where(eq(workspacePublishItems.runId, run.id));
  const [dest] = await db()
    .select()
    .from(workspacePublishingDestinations)
    .where(eq(workspacePublishingDestinations.id, run.destinationId));
  return {
    requestKey: buildPublishItemRequestKey({
      publishRunId: run.id,
      destinationId: dest.id,
      policyVersion: dest.policyVersion,
      itemKey: item.itemKey,
      episodeId: item.episodeId ?? undefined,
      sourceSha256: item.sourceSha256,
    }),
    workspaceId: ctx.workspaceId,
    publishRunId: run.id,
    destinationId: dest.id,
    targetType: dest.targetType,
    targetId: dest.targetId,
    itemKey: item.itemKey,
    episodeId: item.episodeId ?? undefined,
    sourceSha256: item.sourceSha256,
  };
}
