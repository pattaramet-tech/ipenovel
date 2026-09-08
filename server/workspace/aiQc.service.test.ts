import { describe, expect, it, vi } from "vitest";
import { executeReadOnlyAiQcAttempt } from "./aiQc.service";

describe("workspace M04-B provider gate", () => {
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
