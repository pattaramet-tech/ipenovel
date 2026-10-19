import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-055-G Controlled Publish static boundaries", () => {
  it("composes the existing publish pipeline instead of creating another delivery path", () => {
    const service = source("server/workspace/editorialPublish.service.ts");
    expect(service).toContain("createPublishDryRun");
    expect(service).toContain("requestPublishExecution");
    expect(service).toContain("workspacePublishItems");
    expect(service).toContain("workspaceOutbox");
    expect(service).toContain("loadMatchingRunBatch");
    expect(service).toContain("editorialItemKey(stage.id, stage.episodeId)");
    expect(service).toContain("items: state.stages.map");
    expect(service).toContain("editorialStageSetSha256");
    expect(service).not.toMatch(/workspaceAi|openai|gemini|fetch\(/i);
  });

  it("runs the Editorial freshness preflight only on a real provider execute miss", () => {
    const execution = source("server/workspace/publishExecution.service.ts");
    const reconcile = execution.indexOf("await input.provider.reconcile(request)");
    const preflight = execution.indexOf("await input.beforeProviderExecute?.(request)");
    const execute = execution.indexOf("await input.provider.execute(request)");
    expect(reconcile).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(reconcile);
    expect(execute).toBeGreaterThan(preflight);
  });

  it("projects Published only after every batch item has durable receipt + reader visibility", () => {
    const service = source("server/workspace/editorialPublish.service.ts");
    const run = service.indexOf('runContext.run.status === "published"');
    const outbox = service.indexOf('outbox?.status === "delivered"');
    const item = service.indexOf('row.item.status === "published"');
    const receipt = service.indexOf("Boolean(row.item.providerReceipt)");
    const visible = service.indexOf("row.episode.isPublished === true");
    const projection = service.indexOf('targetColumnKey: "published"');
    expect(run).toBeGreaterThan(-1);
    expect(outbox).toBeGreaterThan(run);
    expect(item).toBeGreaterThan(outbox);
    expect(receipt).toBeGreaterThan(item);
    expect(visible).toBeGreaterThan(receipt);
    expect(projection).toBeGreaterThan(visible);
  });

  it("reconciles before claim and again after worker finalization for crash recovery", () => {
    const runtime = source("server/workspace/publishExecution.runtime.ts");
    const first = runtime.indexOf("await reconcileEditorialPublishRun");
    const claim = runtime.indexOf("await claimPublishOutbox");
    const hook = runtime.indexOf("beforeProviderExecute: assertEditorialPublishRequestCurrent");
    const second = runtime.lastIndexOf("await reconcileEditorialPublishRun");
    expect(first).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(first);
    expect(hook).toBeGreaterThan(claim);
    expect(second).toBeGreaterThan(hook);
  });

  it("binds the worker preflight to the Admin-requested execution, not the Stage creator", () => {
    const service = source("server/workspace/editorialPublish.service.ts");
    const preflight = service.slice(service.indexOf("export async function assertEditorialPublishRequestCurrent"));
    expect(preflight).not.toContain("actorUserId: stage.stagedByUserId");
    expect(preflight).not.toContain("getEditorialApprovalReadModel(");
    const binding = preflight.indexOf("requireAdminRequestedPublishExecution(db, request");
    const provenance = preflight.indexOf("requireCurrentStageProvenance(db, request.workspaceId, stage)");
    const read = preflight.indexOf("readEditorialApprovalEvidenceForAuthorizedPublish(");
    expect(binding).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(binding);
    expect(read).toBeGreaterThan(provenance);
    expect(preflight).toContain("stagedEpisodeUnchanged(db, stage)");
    const authorization = service.slice(service.indexOf("async function requireAdminRequestedPublishExecution"));
    expect(authorization).toContain("buildPublishOutboxIdempotencyKey(authorized.run.id, authorized.run.idempotencyKey)");
    expect(authorization).toContain('authorized.outbox.status !== "claimed"');
    expect(authorization).toContain("authorized.outbox.ownershipEpoch !== authorized.ownership.cutoverEpoch");
    const execution = source("server/workspace/publishExecution.service.ts");
    const request = execution.slice(execution.indexOf("export async function requestPublishExecution"));
    expect(request.indexOf("requireWorkspacePlatformAdmin(db, input.actorUserId)"))
      .toBeLessThan(request.indexOf("tx.insert(workspaceOutbox)"));
  });

  it("checks every editorial Stage against the locked Episode row before hygiene or any publish write", () => {
    const provider = source("server/workspace/ipenovelPublish.provider.ts");
    const locks = source("server/workspace/publishLockOrder.ts");
    const execute = provider.slice(provider.indexOf("async execute(request)"));
    const creatorLock = execute.indexOf("assertStageCreatorAuthorityLocked");
    const novelThenEpisode = execute.indexOf("lockNovelThenEpisode");
    const retry = execute.indexOf("runWorkspaceTransactionWithDeadlockRetry");
    const beforeLocks = execute.indexOf("publishLockBarrier.beforeLocks");
    const receipt = execute.indexOf("parseReceiptMetadata(existing.metadataJson)");
    const identity = execute.indexOf("let replacementStage");
    const missingStage = execute.indexOf("!stage ||");
    const stateCheck = execute.indexOf("stagedEpisodeStateSha256(stage, episode) !== stage.episodeStateSha256");
    const replacementCheck = execute.indexOf("targetStateSha256 !== stage.episodeStateSha256");
    const hygiene = execute.indexOf("buildNqaPrePublishHygieneGate(");
    const episodeWrite = execute.indexOf(".update(episodes)");
    const novelWrite = execute.indexOf(".update(novels)", episodeWrite);
    const receiptWrite = execute.indexOf(".insert(workspaceAuditEvents)");
    const novelLock = locks.indexOf('.from(novels)');
    const episodeLock = locks.indexOf('.from(episodes)');
    expect(retry).toBeGreaterThan(-1);
    expect(beforeLocks).toBeGreaterThan(retry);
    expect(execute.indexOf("recoverCommittedReceipt")).toBeGreaterThan(beforeLocks);
    expect(creatorLock).toBeGreaterThan(execute.indexOf("recoverCommittedReceipt"));
    expect(novelThenEpisode).toBeGreaterThan(creatorLock);
    expect(receipt).toBeGreaterThan(novelThenEpisode);
    expect(identity).toBeGreaterThan(receipt);
    expect(missingStage).toBeGreaterThan(identity);
    expect(stateCheck).toBeGreaterThan(missingStage);
    expect(replacementCheck).toBeGreaterThan(identity);
    expect(novelLock).toBeGreaterThan(-1);
    expect(episodeLock).toBeGreaterThan(novelLock);
    expect(locks.indexOf('.for("update")', novelLock)).toBeLessThan(episodeLock);
    for (const write of [hygiene, episodeWrite, novelWrite, receiptWrite]) {
      expect(write).toBeGreaterThan(stateCheck);
      expect(write).toBeGreaterThan(replacementCheck);
    }
    expect(execute).not.toContain("editorialIdentity && editorialIdentity.episodeId === episode.id");
  });

  it("keeps the trusted approval evidence read out of routers and Author paths", () => {
    const trusted = "readEditorialApprovalEvidenceForAuthorizedPublish";
    for (const path of [
      "server/workspace/router.ts",
      "server/workspace/authorEditorial.router.ts",
      "server/workspace/authorEditorial.service.ts",
      "server/workspace/publishExecution.runtime.ts",
      "server/routers.ts",
    ]) {
      expect(source(path), path).not.toContain(trusted);
    }
    expect(source("server/workspace/editorialPublish.service.ts")).toContain(trusted);
  });

  it("exposes explicit admin-only Editorial publish controls without direct Control Center execution", () => {
    // IPE-064: Publish runs through the bulk action bar endpoint; the
    // per-pack requestPublish mutation moved off the workspace page.
    const router = source("server/workspace/router.ts");
    const page = source("client/src/pages/WorkspacePage.tsx");
    const actionBar = source("client/src/pages/WorkspaceActionBar.tsx");
    expect(router).toMatch(/publish: adminProcedure[\s\S]*requestPublish: adminProcedure/);
    expect(page).toContain("bulkRequestEditorialPublish.mutate");
    expect(actionBar).toContain("6. Publish");
    expect(page).not.toContain("publishExecution.execute.useMutation");
  });
});
