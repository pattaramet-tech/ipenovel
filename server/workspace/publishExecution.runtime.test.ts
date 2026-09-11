import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWorkspacePublishExecutionScope, scopeMatches, WorkspacePublishRuntimeError } from "./publishExecution.runtime";

describe("workspace publish execution runtime scope", () => {
  it("parses one exact scoped run and rejects missing, duplicate, extra, or non-positive fields", () => {
    const scope = parseWorkspacePublishExecutionScope("workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2");
    expect(scope).toEqual({
      workspaceId: 2,
      workspaceNovelId: 2,
      runId: 7,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: 2,
    });
    expect(scopeMatches(scope, { ...scope })).toBe(true);
    expect(scopeMatches(scope, { ...scope, runId: 8 })).toBe(false);

    for (const raw of [
      undefined,
      "workspaceId=2,workspaceNovelId=2,runId=7,epoch=1",
      "workspaceId=2,workspaceId=3,workspaceNovelId=2,runId=7,epoch=1,version=2",
      "workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2,extra=1",
      "workspaceId=2,workspaceNovelId=2,runId=0,epoch=1,version=2",
    ]) {
      expect(() => parseWorkspacePublishExecutionScope(raw)).toThrow(WorkspacePublishRuntimeError);
    }
  });

  it("checks execution/provider flags before any outbox claim", () => {
    const source = readFileSync(new URL("./publishExecution.runtime.ts", import.meta.url), "utf8");
    const executionGuard = source.indexOf("if (!input.executionEnabled)");
    const providerGuard = source.indexOf('input.provider.mode === "external" && !input.allowExternalProvider');
    const claim = source.indexOf("await claimPublishOutbox");
    expect(executionGuard).toBeGreaterThan(-1);
    expect(providerGuard).toBeGreaterThan(executionGuard);
    expect(claim).toBeGreaterThan(providerGuard);
  });
});
