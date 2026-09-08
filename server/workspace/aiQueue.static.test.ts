import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M04-A durable AI Queue static boundaries", () => {
  it("keeps migration 0041 additive and Workspace-only", () => {
    const migration = source("drizzle/0041_workspace_ai_queue_foundation.sql");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    for (const table of ["workspaceAiJobs", "workspaceAiJobAttempts", "workspaceAiArtifacts"]) {
      expect(migration).toContain(table);
    }
    expect(migration).not.toMatch(/payment|ocr|slip|wallet|publishRun|outbox/i);
  });

  it("models deterministic jobs, versioned attempts, leases, and immutable artifacts", () => {
    const schema = source("drizzle/schema.ts");
    expect(schema).toContain('uniqueIndex("waj_workspace_idempotency_unique")');
    expect(schema).toContain('index("waj_claim_idx")');
    expect(schema).toContain('uniqueIndex("waja_job_attempt_unique")');
    expect(schema).toContain('index("waja_status_lease_idx")');
    expect(schema).toContain('uniqueIndex("waa_attempt_type_hash_unique")');
    expect(schema).toContain('moderationStatus: mysqlEnum("moderationStatus", ["pending", "accepted", "rejected"])');
  });

  it("keeps worker execution internal and provider-free", () => {
    const service = source("server/workspace/aiQueue.service.ts");
    const router = source("server/workspace/router.ts");
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini|provider\.generate|workspacePublish|workspaceOutbox/i);
    expect(router).not.toContain("claimAiJob");
    expect(router).not.toContain("startAiAttempt");
    expect(router).not.toContain("completeAiAttempt");
  });

  it("does not mutate migration ownership or implement cutover", () => {
    const service = source("server/workspace/aiQueue.service.ts");
    expect(service).not.toContain("workspaceMigrationRegistry");
    expect(service).not.toMatch(/cutoverEpoch|owner:\s*["']workspace["']/);
  });
});
