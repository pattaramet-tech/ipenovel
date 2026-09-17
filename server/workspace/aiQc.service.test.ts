import { describe, expect, it, vi } from "vitest";
import { WorkspaceAiQcExternalProviderError } from "./aiQc.provider";
import { classifyWorkspaceAiQcExecutionError, executeReadOnlyAiQcAttempt } from "./aiQc.service";

describe("workspace M04-B provider gate", () => {
  it("preserves provider error classes for durable attempt diagnostics", () => {
    expect(classifyWorkspaceAiQcExecutionError(
      new WorkspaceAiQcExternalProviderError("PROVIDER_REQUEST_FAILED", "HTTP 400")
    )).toBe("PROVIDER_REQUEST_FAILED");
    expect(classifyWorkspaceAiQcExecutionError(
      new WorkspaceAiQcExternalProviderError("PROVIDER_RESPONSE_INVALID", "bad response")
    )).toBe("PROVIDER_RESPONSE_INVALID");
    expect(classifyWorkspaceAiQcExecutionError({ code: "PROVIDER_REQUEST_FAILED" })).toBe("AI_QC_EXECUTION_FAILED");
  });

  it("fails closed before DB/network work when an external provider is not explicitly enabled", async () => {
    const provider = { mode: "external" as const, execute: vi.fn(async () => ({})) };
    await expect(executeReadOnlyAiQcAttempt({
      workspaceId: 1,
      jobId: 1,
      attemptId: 1,
      leaseOwner: "worker",
      accessToken: "never-used",
      docsAdapter: {
        getMetadata: vi.fn(),
        getNormalizedText: vi.fn(),
        revoke: vi.fn(),
      },
      provider,
      artifactStore: { putJson: vi.fn() },
    })).rejects.toMatchObject({ code: "PROVIDER_NOT_EXPLICITLY_ENABLED" });
    expect(provider.execute).not.toHaveBeenCalled();
  });
});
