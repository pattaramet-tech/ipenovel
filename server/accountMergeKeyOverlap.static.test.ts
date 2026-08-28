import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { buildAccountMergeKeyOverlapQuery } from "./db";

/**
 * Static SQL-shape test for buildAccountMergeKeyOverlapQuery() - same
 * connection-free `.toSQL()`-style dialect render already used by
 * server/findAccountRecoveryUserOwnedData.test.ts for
 * buildOtherBlockingAccountRecoveryRequestsCondition. No database needed:
 * rendering a query to its SQL text + bound params does no network I/O.
 *
 * The one thing this MUST prove: sourceUserId/targetUserId are real bound
 * parameters (`?` placeholders), never string-concatenated into the SQL
 * text - the only untrusted-shaped inputs this query ever takes.
 * table/userIdColumn/keyColumns are always literal constants from
 * server/db.ts's own ACCOUNT_MERGE_TABLE_CHECKS registry, never request
 * input, so embedding them as quoted identifiers is safe and expected.
 */
const db = drizzle("mysql://user:pass@localhost:3306/db", { mode: "default" });

function render(table: string, userIdColumn: string, keyColumns: string[], sourceUserId: number, targetUserId: number) {
  const query = buildAccountMergeKeyOverlapQuery(table, userIdColumn, keyColumns, sourceUserId, targetUserId);
  return (db as any).dialect.sqlToQuery(query) as { sql: string; params: unknown[] };
}

describe("buildAccountMergeKeyOverlapQuery", () => {
  it("single-column key: quotes the table/column identifiers and binds both user ids as parameters", () => {
    const { sql: text, params } = render("wishlists", "userId", ["novelId"], 10, 20);

    expect(text).toBe(
      "SELECT COUNT(*) AS cnt FROM `wishlists` s WHERE s.`userId` = ? AND EXISTS (SELECT 1 FROM `wishlists` t WHERE t.`userId` = ? AND s.`novelId` = t.`novelId`)"
    );
    expect(params).toEqual([10, 20]);
  });

  it("composite key: ANDs every key column pairwise between the source and target aliases", () => {
    const { sql: text, params } = render(
      "dailyCheckins",
      "userId",
      ["checkinDate", "campaignKey"],
      42,
      99
    );

    expect(text).toBe(
      "SELECT COUNT(*) AS cnt FROM `dailyCheckins` s WHERE s.`userId` = ? AND EXISTS (SELECT 1 FROM `dailyCheckins` t WHERE t.`userId` = ? AND s.`checkinDate` = t.`checkinDate` AND s.`campaignKey` = t.`campaignKey`)"
    );
    expect(params).toEqual([42, 99]);
  });

  it("a non-standard userIdColumn (coupons' ownerUserId) is quoted and used exactly as given, never assumed to be `userId`", () => {
    const { sql: text } = render("coupons", "ownerUserId", ["code"], 1, 2);
    expect(text).toContain("s.`ownerUserId` = ?");
    expect(text).toContain("t.`ownerUserId` = ?");
  });

  it("dailyCheckinRewardGrants' two-column composite key (ruleId + milestoneInstanceNumber) ANDs both key equalities", () => {
    const { sql: text } = render(
      "dailyCheckinRewardGrants",
      "userId",
      ["ruleId", "milestoneInstanceNumber"],
      5,
      6
    );
    expect(text).toContain("s.`ruleId` = t.`ruleId`");
    expect(text).toContain("s.`milestoneInstanceNumber` = t.`milestoneInstanceNumber`");
    // One AND joining "userId = ?" to the EXISTS clause, one AND joining
    // the EXISTS subquery's own userId match to the key equalities, and
    // one AND joining the two key equalities together.
    expect(text.match(/AND/g)?.length).toBe(3);
  });

  it("never interpolates the user id values directly into the SQL text - they are ALWAYS bound parameters", () => {
    const { sql: text } = render("wishlists", "userId", ["novelId"], 777, 888);
    expect(text).not.toMatch(/777|888/);
  });
});
