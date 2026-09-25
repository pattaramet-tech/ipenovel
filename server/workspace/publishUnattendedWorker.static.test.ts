import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("M12D.9 unattended Controlled Publish worker", () => {
  const worker = read("server/workspace/publishUnattendedWorker.ts");
  const runtime = read("server/workspace/publishExecution.runtime.ts");
  const execution = read("server/workspace/publishExecution.service.ts");
  const startup = read("server/_core/index.ts");
  const router = read("server/workspace/router.ts");

  it("reuses the centralized environment policy, provider gate, and environment-specific DB safety", () => {
    expect(worker).toContain("resolveWorkspacePublishExecutionPolicy(env)");
    expect(runtime).toContain('WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true"');
    expect(worker).toContain('WORKSPACE_PUBLISH_UNATTENDED_ENABLED === "false"');
    expect(worker).toContain("publishPolicy.safety");
    expect(router).toContain("requireWorkspacePublishRequestPolicy");
    expect(router).not.toContain('WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true"');
    expect(runtime).toContain("WORKSPACE_PUBLISH_ACCEPTANCE_TIER");
    expect(runtime).toContain("WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME");
    expect(runtime).toContain("PRODUCTION_DB_FINGERPRINT");
    expect(runtime).toContain("requireProductionPublishExecutionSafety");
  });

  it("derives each queued scope from durable state and executes through the existing fenced runtime/provider", () => {
    expect(worker).toContain("resolvePendingPublishExecutionScope");
    expect(worker).toContain("runScopedPublishWorkerOnce");
    expect(worker).toContain("createIpeNovelWorkspacePublishProvider");
    expect(execution).toContain("candidate.ownership.version");
    expect(execution).toContain("candidate.outbox.ownershipEpoch !== candidate.ownership.cutoverEpoch");
    expect(worker).not.toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
  });

  it("is single-flight, restart-safe, bounded and backs off on errors", () => {
    expect(worker).toContain("let inFlight = false");
    expect(worker).toContain("if (stopped || inFlight) return");
    expect(worker).toContain("Math.max(pollMs, ERROR_BACKOFF_MS)");
    expect(worker).toContain("timer as any)?.unref?.()");
    expect(worker).toContain("clearTimer(timer)");
    expect(worker).not.toContain("setInterval(");
  });

  it("starts only after the HTTP server is listening and stops with server close", () => {
    const migration = startup.indexOf("await ensureDatabaseMigrated()");
    const construct = startup.indexOf("createUnattendedPublishWorker()");
    const listen = startup.lastIndexOf("server.listen(port, () => {");
    const start = startup.indexOf("unattendedPublishWorker.start()");
    expect(migration).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(migration);
    expect(listen).toBeGreaterThan(construct);
    expect(start).toBeGreaterThan(listen);
    expect(startup).toContain('server.on("close", () => unattendedPublishWorker.stop())');
  });

  it("logs operational identifiers/status only and does not log connection secrets", () => {
    expect(worker).toContain('component: "workspace-publish-worker"');
    expect(worker).toContain('event: "cycle_complete"');
    expect(worker).toContain('event: "cycle_failed"');
    expect(worker).not.toMatch(/console\.(?:log|error)\([^\n]*(?:DATABASE_URL|password|leaseToken)/i);
  });
});
