import { describe, expect, it } from "vitest";
import { buildConfiguredWorkspaceAiQcPreviewReadiness } from "./aiQc.previewReadiness";

const requestKey = "b".repeat(64);
const managed = (overrides: Record<string, unknown> = {}) => ({
  profileId: 7,
  profileRevision: 3,
  providerType: "openai_compatible",
  enabled: true as const,
  apiUrl: "https://ai.example.test/v1/chat/completions",
  apiKey: "managed-secret-never-print",
  model: "managed-model-v1",
  providerName: "managed-provider",
  timeoutMs: 30_000,
  maxInputChars: 200_000,
  reconcileUrlTemplate: "https://ai.example.test/v1/chat/completions/{providerRequestId}",
  ...overrides,
});

function previewEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    WORKSPACE_AI_QC_RUNTIME_TARGET: "preview",
    WORKSPACE_AI_QC_PROVIDER_ENABLED: "",
    WORKSPACE_AI_QC_EXECUTION_ENABLED: "",
    R2_PRIVATE_ACCOUNT_ID: "test-account",
    R2_PRIVATE_ACCESS_KEY_ID: "test-access-key",
    R2_PRIVATE_SECRET_ACCESS_KEY: "test-secret-key",
    R2_PRIVATE_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
    R2_PRIVATE_BUCKET_NAME: "test-private-bucket",
    R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "900",
    ...overrides,
  };
}

describe("IPE-054-D0 managed provider Preview readiness", () => {
  it("uses an active database profile so provider credentials can change without redeploy", async () => {
    const report = await buildConfiguredWorkspaceAiQcPreviewReadiness(
      previewEnv(), async () => managed()
    );
    expect(report.provider).toMatchObject({ ready: true, enabled: false, source: "database", profileId: 7 });
    expect(report.reconciliation.ready).toBe(true);
    expect(report.readyForDisarmedPreview).toBe(true);
    expect(report.readyForControlledExecution).toBe(false);
    expect(JSON.stringify(report)).not.toContain("managed-secret-never-print");
  });

  it("allows controlled readiness only when independent execution gates are armed", async () => {
    const report = await buildConfiguredWorkspaceAiQcPreviewReadiness(
      previewEnv({
        WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
        WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
        WORKSPACE_AI_QC_EXECUTION_SCOPE: `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`,
        WORKSPACE_AI_QC_LEASE_SECONDS: "60",
        WORKSPACE_AI_QC_MAX_ATTEMPTS: "3",
      }),
      async () => managed()
    );
    expect(report.readyForControlledExecution).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("still requires receipt reconciliation from a managed profile", async () => {
    const report = await buildConfiguredWorkspaceAiQcPreviewReadiness(
      previewEnv(), async () => managed({ reconcileUrlTemplate: null })
    );
    expect(report.reconciliation.ready).toBe(false);
    expect(report.reconciliation.missing).toContain("WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE");
    expect(report.readyForDisarmedPreview).toBe(false);
  });

  it("fails closed when the secret vault cannot resolve the active profile", async () => {
    const report = await buildConfiguredWorkspaceAiQcPreviewReadiness(
      previewEnv(), async () => { throw new Error("synthetic vault failure with no secret value"); }
    );
    expect(report.provider.ready).toBe(false);
    expect(report.provider.source).toBe("database");
    expect(report.blockers).toContain("WORKSPACE_SECRET_ENCRYPTION_KEY");
    expect(report.readyForDisarmedPreview).toBe(false);
  });

  it("fails closed for a provider type whose execution adapter does not exist yet", async () => {
    const report = await buildConfiguredWorkspaceAiQcPreviewReadiness(
      previewEnv(), async () => managed({ providerType: "gemini_interactions" })
    );
    expect(report.provider.ready).toBe(false);
    expect(report.provider.invalid).toContain("ADMIN_AI_PROVIDER_TYPE_UNSUPPORTED");
    expect(report.readyForControlledExecution).toBe(false);
  });
});
