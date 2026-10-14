import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("author role migration", () => {
  it("adds author to the users role enum and keeps user and admin", () => {
    const sql = source("drizzle/0064_author_account_role.sql");
    const executable = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sql).toContain("MODIFY COLUMN `role` ENUM('user','author','admin') NOT NULL DEFAULT 'user'");
    expect(executable).not.toMatch(/UPDATE\s+`?users`?/i);
    expect(source("drizzle/schema.ts")).toContain('mysqlEnum("role", ["user", "author", "admin"])');
    expect(source("drizzle/meta/_journal.json")).toContain("0064_author_account_role");
  });
});

describe("admin procedure stays admin-only", () => {
  it("does not treat author as a platform admin", () => {
    const trpc = source("server/_core/trpc.ts");
    const adminGuard = trpc.slice(trpc.indexOf("export const adminProcedure"), trpc.indexOf("export const authorContentProcedure"));
    expect(adminGuard).toContain("ctx.user.role !== 'admin'");
    expect(adminGuard).not.toContain('"author"');
    expect(source("server/workspace/router.ts")).toContain('import { adminProcedure, router } from "../_core/trpc"');
    expect(source("server/workspace/adminAccess.ts")).toContain('user.role !== "admin"');
  });
});
