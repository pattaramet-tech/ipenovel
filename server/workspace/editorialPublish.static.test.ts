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

  it("exposes explicit admin-only Editorial publish controls without direct Control Center execution", () => {
    const router = source("server/workspace/router.ts");
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(router).toMatch(/publish: adminProcedure[\s\S]*requestPublish: adminProcedure/);
    expect(page).toContain("trpc.workspace.editorial.requestPublish.useMutation");
    expect(page).toContain("Publish (Controlled)");
    expect(page).not.toContain("publishExecution.execute.useMutation");
  });
});
