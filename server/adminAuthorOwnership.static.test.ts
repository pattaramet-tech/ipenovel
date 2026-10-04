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
