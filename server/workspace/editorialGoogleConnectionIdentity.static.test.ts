import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
describe("IPE-056-N durable Google source connection identity", () => {
  const schema = read("drizzle/schema.ts");
  const draft = read("server/workspace/editorialDraft.service.ts");
  const publish = read("server/workspace/editorialPublish.service.ts");
  const router = read("server/workspace/router.ts");
  const migration = read("drizzle/0053_workspace_editorial_google_connection_identity.sql");
  it("persists Google connection identity with a database foreign key", () => {
    expect(schema).toContain('googleConnectionId: int("googleConnectionId")');
    expect(schema).toContain('name: "wes_google_connection_fk"');
    expect(migration).toContain("googleConnectionId");
    expect(migration).toContain("wes_google_connection_fk");
  });
  it("records the validated connection during Google import and re-import", () => {
    expect(router).toContain("googleConnectionId: input.connectionId");
    expect(draft).toContain('payload.sourceKind === "google_doc" && !input.googleConnectionId');
    expect(draft).toContain("input.googleConnectionId ?? source.googleConnectionId ?? null");
    expect(draft).toContain("already bound to a different durable connection identity");
  });
  it("scopes publish anchor by provider document and durable connection", () => {
    expect(publish).toContain("eq(workspaceDocuments.connectionId, workspaceEditorialSources.googleConnectionId)");
    expect(publish).toContain("source.googleConnectionId ? Number(source.googleConnectionId) : null");
    expect(publish).toContain("candidates.length !== 1");
  });
});
