import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M06 operational publish prerequisites", () => {
  const execution = readFileSync(new URL("./publishExecution.service.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./publishExecution.runtime.ts", import.meta.url), "utf8");
  const provider = readFileSync(new URL("./ipenovelPublish.provider.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../scripts/workspace-publish-worker-once.mts", import.meta.url), "utf8");

  it("requires the global flag plus an exact workspace/run/epoch/version scope", () => {
    expect(router).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(router).toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
    expect(router).toContain("expectedOwnershipVersion");
    expect(runtime).toContain("workspaceNovelId");
    expect(runtime).toContain("runId");
    expect(runtime).toContain("expectedCutoverEpoch");
    expect(runtime).toContain("expectedOwnershipVersion");
  });

  it("keeps the runtime one-shot and double-gated for an external provider", () => {
    expect(worker).toContain('WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true"');
    expect(worker).toContain('WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true"');
    expect(runtime).not.toMatch(/setInterval\(|setTimeout\(|cron\(|scheduler\(/i);
    expect(worker).not.toMatch(/setInterval\(|setTimeout\(|cron\(|scheduler\(/i);
  });

  it("implements bounded retries, terminal dead-letter, receipt-first recovery and successful hash advancement", () => {
    expect(execution).toContain("WORKSPACE_PUBLISH_MAX_ATTEMPTS");
    expect(execution).toContain('status: "dead_letter"');
    expect(execution).toContain("provider.reconcile(request)");
    expect(execution).toContain("providerReceipt: receipt");
    expect(execution).toContain("lastPublishedSha256: source.snapshot.normalizedSha256.toLowerCase()");
    expect(execution).toContain("workspaceDocumentFingerprints.version");
  });

  it("keeps provider delivery behind the adapter and does not introduce a network client", () => {
    expect(provider).toContain('mode: "external"');
    expect(provider).toContain("WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT");
    expect(provider).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini/i);
    expect(execution).not.toMatch(/update\(episodes\)|insert\(episodes\)|update\(novels\)|insert\(novels\)/i);
  });
});
