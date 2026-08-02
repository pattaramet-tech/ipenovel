import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { accountRecoveryRequests } from "../drizzle/schema";
import { buildOtherBlockingAccountRecoveryRequestsCondition } from "./db";

/**
 * Static SQL-shape test for buildOtherBlockingAccountRecoveryRequestsCondition()
 * - the fix for PR #27 review finding M1: findAccountRecoveryUserOwnedData's
 * "other request by this same requester" check previously had NO status
 * filter at all, so a terminal-but-unsuccessful request (rejected/
 * cancelled/blocked) counted as "user-owned data left behind" and
 * permanently blocked every future approval for that user - even though the
 * UI's own resubmit flow (client/src/pages/accountRecoveryPresentation.ts's
 * showForm) explicitly re-enables submission after exactly those statuses.
 *
 * This asserts the generated SQL's status filter is EXACTLY
 * `IN ('pending', 'approved')` - neither broader (which would silently
 * reintroduce the bug this fixes) nor narrower (which could under-block a
 * genuinely pending/already-approved source, weakening the "empty source
 * account" invariant - see the executeAccountRecovery/assessAccountRecoverySafety
 * docstrings this condition backs).
 *
 * Uses a throwaway drizzle instance purely to render `.toSQL()` text - the
 * connection string is never dialed (toSQL() does no network I/O), so this
 * needs no database and belongs in the unit project (same pattern as
 * server/services/hybridHealthQueries.static.test.ts's
 * buildEpisodeLevelPredicate/buildCandidateWhereClause tests).
 */
const db = drizzle("mysql://user:pass@localhost:3306/db", { mode: "default" });

function renderCondition(userId: number, excludeRequestId: number) {
  return db
    .select({ x: sql`1` })
    .from(accountRecoveryRequests)
    .where(buildOtherBlockingAccountRecoveryRequestsCondition(userId, excludeRequestId))
    .toSQL();
}

describe("buildOtherBlockingAccountRecoveryRequestsCondition", () => {
  it("filters by requesterUserId, excludes the current request id, and restricts status to exactly pending/approved", () => {
    const { sql: text, params } = renderCondition(42, 7);

    expect(text).toMatch(/`requesterUserId`\s*=\s*\?/i);
    expect(text).toMatch(/`id`\s*<>\s*\?/i);
    expect(text).toMatch(/`status`\s*in\s*\(\?,\s*\?\)/i);

    // Exactly [userId, excludeRequestId, "pending", "approved"] - order
    // matches the and(eq, ne, inArray) composition in db.ts. Asserting the
    // full param list (not just "contains") also proves no extra status
    // value snuck into the IN-list.
    expect(params).toEqual([42, 7, "pending", "approved"]);
  });

  it("never includes a terminal-but-unsuccessful status (rejected/cancelled/blocked) in the generated SQL text at all", () => {
    const { sql: text, params } = renderCondition(1, 1);
    expect(text.toLowerCase()).not.toContain("rejected");
    expect(text.toLowerCase()).not.toContain("cancelled");
    expect(text.toLowerCase()).not.toContain("blocked");
    expect(params).not.toContain("rejected");
    expect(params).not.toContain("cancelled");
    expect(params).not.toContain("blocked");
  });

  it("both pending and approved are present - neither one was dropped in favor of the other", () => {
    const { params } = renderCondition(1, 1);
    expect(params).toContain("pending");
    expect(params).toContain("approved");
  });

  it("different userId/excludeRequestId values are reflected verbatim in the params, in call order", () => {
    const { params } = renderCondition(999, 123);
    expect(params[0]).toBe(999);
    expect(params[1]).toBe(123);
  });
});
