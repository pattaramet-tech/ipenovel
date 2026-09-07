import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M02 static security boundaries", () => {
  it("does not change or widen the existing login OAuth scope/callback", () => {
    const login = source("server/_core/googleOAuth.ts");
    expect(login).toContain(
      'const GOOGLE_OAUTH_SCOPE = "openid email profile"'
    );
    expect(login).toContain('"/api/auth/google/callback"');
    expect(login).not.toContain("drive.metadata.readonly");
    expect(login).not.toContain("documents.readonly");
    expect(login).not.toContain("WORKSPACE_DOCS_SCOPE");
  });

  it("keeps credentials encrypted and snapshots body-free at the schema boundary", () => {
    const schema = source("drizzle/schema.ts");
    expect(schema).toContain(
      'encryptedRefreshToken: text("encryptedRefreshToken")'
    );
    expect(schema).toContain('keyVersion: int("keyVersion").notNull()');
    expect(schema).not.toContain('refreshToken: text("refreshToken")');
    const snapshotBlock = schema.slice(
      schema.indexOf("export const workspaceDocumentSnapshots"),
      schema.indexOf("export const workspaceAuditEvents")
    );
    expect(snapshotBlock).toContain("normalizedSha256");
    expect(snapshotBlock).not.toMatch(/body|contentObjectKey/i);
  });

  it("keeps the reconstructed post-PR45 Workspace migration additive", () => {
    const migration = source("drizzle/0037_reconstruct_pr45_selected_features.sql");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).toContain("workspaceWorkspaces");
    expect(migration).toContain("workspaceMembers");
    expect(migration).toContain("workspaceGoogleConnections");
    expect(migration).toContain("workspaceDocumentSnapshots");
  });

  it("contains no provider token, code, or document body in routine audit metadata", () => {
    const service = source("server/workspace/googleDocs.service.ts");
    const auditWrites = [
      ...service.matchAll(
        /metadataJson:\s*JSON\.stringify\((\{[\s\S]*?\})\),/g
      ),
    ].map(match => match[1]);
    expect(auditWrites.length).toBeGreaterThanOrEqual(2);
    expect(auditWrites.join("\n")).not.toMatch(
      /accessToken|refreshToken|normalizedText|body/i
    );
  });
});
