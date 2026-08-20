import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { users } from "../drizzle/schema";

/**
 * PR #45 review finding "Avoid a full-table locking scan for role
 * changes" - server/db.ts's lockAdminRoleRows() runs
 * `WHERE role = 'admin' ORDER BY id FOR UPDATE`, which needs a
 * `(role, id)` composite index to avoid a full-table scan/lock on
 * MySQL/MariaDB (see migration 0036_add_users_role_id_index.sql). This
 * inspects the REAL Drizzle table metadata via getTableConfig() -
 * reflection over the actual schema object, not a hand-typed guess or a
 * grep over the migration file's text - so it fails loudly if the index
 * definition in drizzle/schema.ts is ever renamed, reordered, or removed
 * without a corresponding migration decision. Connection-free: getTableConfig
 * only inspects the in-memory table object, never touches a database.
 */
describe("users table - users_role_id_idx", () => {
  const { indexes } = getTableConfig(users);

  it("the composite (role, id) index exists, named users_role_id_idx", () => {
    const roleIdIndex = indexes.find((idx) => idx.config.name === "users_role_id_idx");
    expect(roleIdIndex).toBeDefined();
  });

  it("is NOT a unique index - many rows may share role = 'admin'", () => {
    const roleIdIndex = indexes.find((idx) => idx.config.name === "users_role_id_idx");
    expect(roleIdIndex?.config.unique).toBeFalsy();
  });

  it("column order is EXACTLY (role, id) - role first (matches the WHERE clause), id second (matches the ORDER BY)", () => {
    const roleIdIndex = indexes.find((idx) => idx.config.name === "users_role_id_idx");
    const columnNames = (roleIdIndex?.config.columns ?? []).map((col: any) => col.name);
    expect(columnNames).toEqual(["role", "id"]);
  });

  it("the pre-existing users_email_idx index is still present, untouched", () => {
    const emailIndex = indexes.find((idx) => idx.config.name === "users_email_idx");
    expect(emailIndex).toBeDefined();
    expect(emailIndex?.config.unique).toBeFalsy();
    const columnNames = (emailIndex?.config.columns ?? []).map((col: any) => col.name);
    expect(columnNames).toEqual(["email"]);
  });

  it("exactly two indexes exist on users - no unexpected extra/duplicate index was introduced", () => {
    expect(indexes.map((idx) => idx.config.name).sort()).toEqual(
      ["users_email_idx", "users_role_id_idx"].sort()
    );
  });
});

/**
 * Secondary, supplementary check directly against the generated migration
 * SQL text - per the task's own instruction, this is a defense-in-depth
 * addition, never the primary proof (the getTableConfig() reflection
 * above is that). Confirms the migration is additive-only: exactly one
 * CREATE INDEX statement, nothing else.
 */
describe("drizzle/0036_add_users_role_id_index.sql (supplementary)", () => {
  it("contains exactly one additive CREATE INDEX statement for users_role_id_idx on (role, id)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // Resolved from the repo root (process.cwd() when `pnpm test:unit` runs)
    // rather than `__dirname`, which is not reliably available under this
    // project's ESM/Vite test transform.
    const sql = await fs.readFile(
      path.resolve(process.cwd(), "drizzle/0036_add_users_role_id_index.sql"),
      "utf-8"
    );
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toHaveLength(1);
    const statement = statements[0].toLowerCase();
    expect(statement).toContain("create index");
    expect(statement).toContain("users_role_id_idx");
    expect(statement).toContain("`users`");
    expect(statement).toMatch(/\(`role`,\s*`id`\)/);
    expect(statement).not.toContain("drop");
    expect(statement).not.toContain("alter");
    expect(statement).not.toContain("force index");
  });
});
