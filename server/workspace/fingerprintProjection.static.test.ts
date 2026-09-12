import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M03-A fingerprint projection static contract", () => {
  it("adds only the current fingerprint projection in migration 0040", () => {
    const migration = source("drizzle/0040_workspace_document_fingerprints.sql");
    expect(migration).toContain("CREATE TABLE `workspaceDocumentFingerprints`");
    expect(migration).toContain("CONSTRAINT `wdf_binding_unique` UNIQUE(`bindingId`)");
    expect(migration).toContain("CONSTRAINT `wdf_binding_fk`");
    expect(migration).toContain("CONSTRAINT `wdf_snapshot_fk`");
    expect(migration).toContain("wdf_normalized_hash_idx");
    expect(migration).toContain("wdf_last_published_hash_idx");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(/paymentSlipClaims|slipEvidence|fileHash|hashSlipFileBytes/i);
  });

  it("keeps immutable snapshots and projects only metadata/hash fields", () => {
    const schema = source("drizzle/schema.ts");
    const block = schema.slice(
      schema.indexOf("export const workspaceDocumentFingerprints"),
      schema.indexOf("export const workspaceAuditEvents")
    );
    expect(block).toContain('bindingId: int("bindingId").notNull()');
    expect(block).toContain('snapshotId: int("snapshotId").notNull()');
    expect(block).toContain("providerRevisionId");
    expect(block).toContain("normalizedSha256");
    expect(block).toContain("normalizationVersion");
    expect(block).toContain("lastPublishedSha256");
    expect(block).not.toMatch(/normalizedText|documentBody|refreshToken|accessToken/i);
  });

  it("updates the projection during observation and exposes a platform-admin-gated read model", () => {
    const service = source("server/workspace/googleDocs.service.ts");
    expect(service).toContain(".insert(workspaceDocumentFingerprints)");
    expect(service).toContain(".onDuplicateKeyUpdate({");
    expect(service).toContain("version: sql`${workspaceDocumentFingerprints.version} + 1`");
    expect(service).toContain("export async function listDocumentFingerprints");
    expect(service).toContain("await requireWorkspacePlatformAdmin(db, input.actorUserId)");
    const readModel = service.slice(service.indexOf("export async function listDocumentFingerprints"));
    expect(readModel).not.toMatch(/encryptedRefreshToken|accessToken|normalizedText/);
  });

  it("does not introduce Checker/Kanban side-effect ownership in M03-A", () => {
    const migration = source("drizzle/0040_workspace_document_fingerprints.sql");
    expect(migration).not.toMatch(/workspaceChecker|workspaceKanban|workspaceAi|workspacePublish|workspaceOutbox/i);
    const router = source("server/workspace/router.ts");
    expect(router).toContain("fingerprints: router({");
    expect(router).not.toContain("migrationOwnership.set");
  });
});
