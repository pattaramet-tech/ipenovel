import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("Workspace Control Center read-only contract", () => {
  it("keeps the publish operational projection query-only and platform-admin-gated", () => {
    const service = read("server/workspace/controlCenter.service.ts");
    const router = read("server/workspace/router.ts");

    expect(service).toContain("requireWorkspacePlatformAdmin(db, input.actorUserId)");
    expect(service).toContain("readOnly: true as const");
    expect(service).toContain("sideEffectsApplied: false as const");
    expect(service).not.toMatch(/\.insert\s*\(/);
    expect(service).not.toMatch(/\.update\s*\(/);
    expect(service).not.toMatch(/\.delete\s*\(/);

    const controlCenterRouter = router.slice(router.indexOf("controlCenter: router({"), router.indexOf("fingerprints: router({"));
    expect(controlCenterRouter).toContain("publishOverview: adminProcedure");
    expect(controlCenterRouter).toContain(".query(async");
    expect(controlCenterRouter).not.toContain(".mutation(async");
  });

  it("does not expose operational mutation controls from the Workspace page", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");

    expect(page).toContain("Read-only Control Center");
    expect(page).toContain("trpc.workspace.controlCenter.publishOverview.useQuery");
    expect(page).toContain("trpc.workspace.publishCutover.readiness.useQuery");
    expect(page).toContain("trpc.workspace.publishFinalGate.package.useQuery");
    expect(page).not.toContain("requestExecution.useMutation");
    expect(page).not.toContain("publishCutover.cutover.useMutation");
    expect(page).not.toContain("publishCutover.rollback.useMutation");
    expect(page).not.toContain("aiQueue.queue.useMutation");
    expect(page).not.toContain("aiQueue.retry.useMutation");
    expect(page).not.toContain("checker.queueRun.useMutation");
    expect(page).not.toContain("kanban.transitionCard.useMutation");
  });
});
