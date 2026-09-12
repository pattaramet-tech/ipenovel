import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync("client/src/pages/WorkspacePage.tsx", "utf8");
const router = readFileSync("server/workspace/router.ts", "utf8");

describe("M06-B admin operational actions", () => {
  it("exposes Checker and AI queue/retry controls only through admin procedures", () => {
    expect(page).toContain("trpc.workspace.checker.queueRun.useMutation");
    expect(page).toContain("trpc.workspace.aiQueue.queue.useMutation");
    expect(page).toContain("trpc.workspace.aiQueue.retry.useMutation");
    expect(router).toMatch(/queueRun: adminProcedure/);
    expect(router).toMatch(/aiQueue: router\(\{[\s\S]*queue: adminProcedure[\s\S]*retry: adminProcedure/);
  });

  it("keeps publish, Kanban, and provider execution controls out of the Control Center", () => {
    expect(page).not.toContain("publishExecution.execute.useMutation");
    expect(page).not.toContain("publishOwnershipTransition.cutover.useMutation");
    expect(page).not.toContain("kanban.transition.useMutation");
    expect(page).not.toContain("claimAiJob");
    expect(page).not.toContain("executeCheckerRun");
  });

  it("uses immutable snapshot evidence and advisory QC policy inputs", () => {
    expect(page).toContain("snapshotOptions");
    expect(page).toContain('operation: "semantic_qc"');
    expect(page).toContain('promptVersion: "qc-prompt-v1"');
    expect(page).toContain('modelPolicyVersion: "qc-policy-v1"');
  });
});
