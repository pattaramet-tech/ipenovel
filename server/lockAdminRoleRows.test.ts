import { describe, it, expect } from "vitest";
import { lockAdminRoleRows } from "./db";

/**
 * Static SQL-shape test for lockAdminRoleRows() - PR #45 review finding
 * "Use one lock hierarchy for admin demotions". Since this is now the
 * FIRST lock any role-changing admin.users mutation acquires (see
 * server/services/adminUserManagementService.ts's updateAdminUserProfile
 * "LOCK HIERARCHY" docstring), its own row-acquisition order must itself
 * be deterministic - `ORDER BY id` before `FOR UPDATE` - so this asserts
 * the exact generated SQL text, connection-free, by capturing the raw
 * `sql` chunk passed to a fake `tx.execute` (drizzle-orm's tagged
 * template result exposes its literal text via `.queryChunks` without
 * needing a real dialect/connection - same "no live database needed"
 * spirit as findAccountRecoveryUserOwnedData.test.ts's `.toSQL()` render,
 * adapted for a raw full-statement query rather than a where-clause
 * fragment).
 */

function extractSqlText(query: any): string {
  const chunks = query?.queryChunks ?? [];
  return chunks
    .map((chunk: any) => (typeof chunk === "string" ? chunk : (chunk?.value ?? []).join("")))
    .join("");
}

describe("lockAdminRoleRows", () => {
  it("selects every role='admin' row, ordered by id, before FOR UPDATE - not the other way around", async () => {
    let capturedQuery: any;
    const tx = {
      execute: async (query: any) => {
        capturedQuery = query;
        return [[]];
      },
    };

    await lockAdminRoleRows(tx);

    const text = extractSqlText(capturedQuery).toLowerCase();
    expect(text).toContain("where role = 'admin'");

    const orderByIndex = text.indexOf("order by id");
    const forUpdateIndex = text.indexOf("for update");
    expect(orderByIndex).toBeGreaterThan(-1);
    expect(forUpdateIndex).toBeGreaterThan(-1);
    expect(orderByIndex).toBeLessThan(forUpdateIndex);
  });
});
