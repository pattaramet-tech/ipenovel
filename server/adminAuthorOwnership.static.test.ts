import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serverDir, "..");
const schema = readFileSync(path.join(root, "drizzle", "schema.ts"), "utf8");
const migration = readFileSync(path.join(root, "drizzle", "0062_novel_author_ownership.sql"), "utf8");
const dbSource = readFileSync(path.join(root, "server", "db.ts"), "utf8");
const source = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");

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
  const dbSource = readFileSync(path.join(root, "server", "db.ts"), "utf8");

  it("creation and rename propagation sit under the canonical account-merge barrier", () => {
    expect(dbSource).toContain("createAuthorOwnedNovelWithDb(db, userId, data)");
    // IPE-063R5 (P1): the create path opens an EXPLICIT transaction around
    // the guard's FOR UPDATE + resolution + insert (never the pooled client).
    expect(dbSource).toContain("createAuthorOwnedNovelWithDb(db, userId, data)");
    expect(dbSource).toContain("return db.transaction(async (tx: any) => {");
    expect(dbSource).toContain("await assertAccountMergeClassifiedMutationAllowed(userId, tx);");
    // Router fail-fast + guarded creator delegation.
    const routers = readFileSync(path.join(root, "server", "routers.ts"), "utf8");
    expect(routers).toContain("db.createAuthorOwnedNovel(authorIdentity.userId, {");
    expect(routers).toContain("db.bulkCreateNovels(input.rows, { userId: authorIdentity.userId })");
  });

  it("propagates fallback account renames via the canonical shared helper (IPE-063R4)", () => {
    // IPE-063R4: the service delegates to the canonical helper shared with
    // the OAuth/Google identity writers — the pen-name/fallback decision
    // and the barrier live in the helper itself (pinned below + exercised
    // by its own db-level tests in adminAuthorOwnership.test.ts).
    expect(service).toContain("db.propagateFallbackAuthorName(tx, params.userId, params.name)");
  });

  it("bulk creation resolves the authoritative name per row inside the guarded tx", () => {
    expect(dbSource).toContain("export async function bulkCreateNovelsWithDb(");
    expect(dbSource).toContain("resolveEffectiveAuthorNameWithDb(tx, authorUserId)");
    // No cached display name crosses rows.
    expect(dbSource).not.toContain("displayName: authorIdentity.displayName");
  });
});

describe("IPE-063R4 canonical fallback propagation helper", () => {
  const dbSourceR4 = source("server/db.ts");
  it("owns the fallback decision: pen name wins, barrier fail-closed, owned-only scope", () => {
    const helper = dbSourceR4.slice(
      dbSourceR4.indexOf("export async function propagateFallbackAuthorName("),
      dbSourceR4.indexOf("export async function updateAuthorProfileWithDb(")
    );
    expect(helper).toContain("export async function propagateFallbackAuthorName(");
    expect(helper).toContain("if (nextName == null) return 0;");
    // Rule B: explicit pen name wins — no account-name overwrite.
    expect(helper).toContain("if (!state || state.authorName != null) return 0;");
    // Fail-closed barrier before any byline write.
    expect(helper).toContain("await assertAccountMergeClassifiedMutationAllowed(targetUserId, tx);");
    expect(helper).toContain(".where(eq(novels.authorUserId, targetUserId))");
  });

  it("the OAuth/Google identity name writers use the same canonical helper", () => {
    const google = readFileSync(
      path.join(root, "server", "services", "googleIdentityService.ts"),
      "utf8"
    ).replace(/\r\n/g, "\n");
    expect(google).toContain("db.propagateFallbackAuthorName(tx, user.id, updateSet.name as string)");
    // upsertUser serializes the existing-account rename under the barrier.
    const upsert = dbSourceR4.slice(
      dbSource.indexOf("export async function upsertUser("),
      dbSource.indexOf("export async function getUserByOpenId(")
    );
    expect(upsert).toContain("assertAccountMergeClassifiedMutationAllowed(existing.id, tx)");
    expect(upsert).toContain("propagateFallbackAuthorName(tx, existing.id, candidateName)");
  });
});
