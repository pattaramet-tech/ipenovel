import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serverDir, "..");
const schema = readFileSync(path.join(root, "drizzle", "schema.ts"), "utf8");
const migration = readFileSync(path.join(root, "drizzle", "0062_novel_author_ownership.sql"), "utf8");

describe("IPE-063 novel Author ownership schema", () => {
  it("adds nullable authorUserId with an index and user FK", () => {
    expect(schema).toContain('authorUserId: int("authorUserId")');
    expect(schema).toContain('index("novels_authorUserId_idx").on(table.authorUserId)');
    expect(schema).toContain('name: "novels_authorUserId_users_id_fk"');
    expect(schema).toContain('.onDelete("set null")');
  });

  it("keeps legacy novels nullable and performs no guessed ownership backfill", () => {
    expect(migration).toContain("ADD COLUMN `authorUserId` int;");
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toMatch(/UPDATE\s+`?novels`?/i);
    expect(migration).not.toMatch(/NOT NULL/i);
  });
});

describe("IPE-063R1 author name / pen name schema", () => {
  const dbSource = readFileSync(path.join(root, "server", "db.ts"), "utf8");

  it("adds a nullable users.authorName pen-name column in schema and migration 0062", () => {
    expect(schema).toContain('authorName: varchar("authorName", { length: 255 })');
    expect(migration).toContain("ALTER TABLE `users` ADD COLUMN `authorName` varchar(255);");
    // Still no guessed ownership backfill and no forced values.
    expect(migration).not.toMatch(/UPDATE\s+`?(novels|users)`?/i);
  });

  it("propagates the pen name to owned novels inside one transaction without touching legacy rows", () => {
    expect(dbSource).toContain("export async function resolveEffectiveAuthorName(");
    expect(dbSource).toContain("export async function updateAuthorProfile(");
    // The display-name sync is scoped by authorUserId — legacy novels with
    // authorUserId IS NULL are structurally excluded from the UPDATE.
    expect(dbSource).toContain(".where(eq(novels.authorUserId, userId))");
    expect(dbSource).toContain(".set({ author: effective })");
    // The effective name resolves from the DB: pen name first, account name fallback.
    expect(dbSource).toContain("authorName ?? accountName");
  });
});

describe("IPE-063R3 account-merge barrier + fallback propagation", () => {
  const service = readFileSync(path.join(root, "server", "services", "adminUserManagementService.ts"), "utf8");
  const dbSource2 = readFileSync(path.join(root, "server", "db.ts"), "utf8");

  it("creation and rename propagation sit under the canonical account-merge barrier", () => {
    expect(dbSource2).toContain("createAuthorOwnedNovelWithDb(db, userId, data)");
    expect(dbSource2).toContain("withAccountMergeClassifiedMutationGuard(userId, db, async (tx: any) => {");
    expect(dbSource2).toContain("await assertAccountMergeClassifiedMutationAllowed(userId, tx);");
    // Router fail-fast + guarded creator delegation.
    const routers = readFileSync(path.join(root, "server", "routers.ts"), "utf8");
    expect(routers).toContain("db.createAuthorOwnedNovel(authorIdentity.userId, {");
    expect(routers).toContain("db.bulkCreateNovels(input.rows, { userId: authorIdentity.userId })");
  });

  it("propagates fallback account renames to owned novels only when no pen name is set", () => {
    expect(service).toContain("assertAccountMergeClassifiedMutationAllowed(params.userId, tx)");
    expect(service).toContain(".where(eq(novels.authorUserId, params.userId))");
    // Rule B: explicit pen name wins — no account-name overwrite.
    expect(service).toContain("authorState.authorName == null");
  });

  it("bulk creation resolves the authoritative name per row inside the guarded tx", () => {
    expect(dbSource2).toContain("export async function bulkCreateNovelsWithDb(");
    expect(dbSource2).toContain("resolveEffectiveAuthorNameWithDb(tx, authorUserId)");
    // No cached display name crosses rows.
    expect(dbSource2).not.toContain("displayName: authorIdentity.displayName");
  });
});
