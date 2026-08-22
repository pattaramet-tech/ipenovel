import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { buildAdminUsersGoogleConnectedExistsCondition } from "./db";

/**
 * Static SQL-shape test for buildAdminUsersGoogleConnectedExistsCondition()
 * - the fix for the PR #45 review finding that the Admin Users list's
 * "Google connection" filter/column previously checked ONLY "does this user
 * have ANY authIdentities row" with no provider filter at all. authIdentities
 * is explicitly provider-agnostic (see drizzle/schema.ts's own doc comment
 * on that column), so once a second provider ever exists, a user linked to
 * only that other provider would have shown up as "Google connected"
 * without this fix.
 *
 * Uses a throwaway drizzle instance purely to render `.toSQL()` text - the
 * connection string is never dialed (toSQL() does no network I/O), so this
 * needs no database - same pattern as
 * server/findAccountRecoveryUserOwnedData.test.ts's
 * buildOtherBlockingAccountRecoveryRequestsCondition test.
 */
const db = drizzle("mysql://user:pass@localhost:3306/db", { mode: "default" });

function renderCondition() {
  return db
    .select({ x: sql`1` })
    .from(users)
    .where(sql`${buildAdminUsersGoogleConnectedExistsCondition()}`)
    .toSQL();
}

describe("buildAdminUsersGoogleConnectedExistsCondition", () => {
  it("is an EXISTS subquery against authIdentities, correlated on userId = users.id", () => {
    const { sql: text } = renderCondition();
    expect(text.toLowerCase()).toContain("exists");
    expect(text).toMatch(/`authIdentities`/);
    expect(text).toMatch(/`userId`\s*=\s*`users`\.`id`/);
  });

  it("filters on provider = 'google' specifically - never treats an arbitrary/other provider as Google-connected", () => {
    const { sql: text } = renderCondition();
    expect(text).toMatch(/`provider`\s*=\s*'google'/i);
  });
});
