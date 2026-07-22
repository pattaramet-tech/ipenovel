import { describe, it, expect } from "vitest";
import { findMissingSchemaObjects, REQUIRED_TABLES, REQUIRED_COLUMNS, REQUIRED_INDEXES } from "../../scripts/migrate.mjs";

/**
 * DB-independent regression coverage for a real bug found while running
 * Part 5's disposable-database scenario against a local MariaDB instance
 * (lower_case_table_names=1 - the default on Windows/macOS installs):
 * findMissingSchemaObjects()'s table check built a Set from
 * information_schema.tables.table_name and compared it against the
 * REQUIRED_TABLES literals with a plain, case-SENSITIVE `Set.has()`. The
 * WHERE clause itself already matches case-insensitively at the SQL level
 * (MariaDB/MySQL normalize table-name comparisons under
 * lower_case_table_names=1/2) and correctly returned every required row -
 * but each came back lowercased ("dailycheckins", not "dailyCheckins"), so
 * the JS-side Set lookup missed all five and scripts/migrate.mjs reported
 * a fully successful migration as failed. This module never touches a
 * real database - it feeds findMissingSchemaObjects a fake connection
 * that reproduces exactly that response shape.
 */

interface FakeQuery {
  sql: string;
  params: unknown[];
}

function fakeConn(tableNameCase: "camel" | "lower", tablesPresent: string[], columnsPresent: boolean, indexesPresent: string[]) {
  const calls: FakeQuery[] = [];
  const query = async (sql: string, params: unknown[] = []): Promise<[any[]]> => {
    calls.push({ sql, params });
    if (sql.includes("information_schema.tables")) {
      const rows = tablesPresent.map((t) => ({ name: tableNameCase === "lower" ? t.toLowerCase() : t }));
      return [rows];
    }
    if (sql.includes("information_schema.columns")) {
      return [columnsPresent ? [{ name: params[1] }] : []];
    }
    if (sql.includes("information_schema.statistics")) {
      const [, indexName] = params;
      return [indexesPresent.includes(String(indexName)) ? [{ name: indexName }] : []];
    }
    throw new Error(`unexpected query in fake connection: ${sql}`);
  };
  return { query, calls };
}

describe("findMissingSchemaObjects - required object lists", () => {
  it("requires exactly the five daily check-in tables", () => {
    expect(REQUIRED_TABLES).toEqual([
      "dailyCheckins",
      "dailyCheckinCampaigns",
      "dailyCheckinCouponTemplates",
      "dailyCheckinRewardRules",
      "dailyCheckinRewardGrants",
    ]);
  });

  it("requires coupons.maxDiscountAmount", () => {
    expect(REQUIRED_COLUMNS).toEqual([{ table: "coupons", column: "maxDiscountAmount" }]);
  });

  it("requires all four dailyCheckins indexes", () => {
    expect(REQUIRED_INDEXES.map((i) => i.index)).toEqual([
      "PRIMARY",
      "unique_daily_checkin_user_date_campaign",
      "unique_daily_checkins_coupon",
      "dailyCheckins_userId_idx",
    ]);
  });
});

describe("findMissingSchemaObjects - case-insensitive table name comparison (regression)", () => {
  it("reports nothing missing when information_schema returns table names in the exact declared case (typical MySQL/TiDB on a case-sensitive filesystem)", async () => {
    const { query } = fakeConn("camel", REQUIRED_TABLES, true, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual([]);
  });

  it("reports nothing missing when information_schema returns table names LOWERCASED (MariaDB/MySQL with lower_case_table_names=1 or 2 - the actual bug this covers)", async () => {
    const { query } = fakeConn("lower", REQUIRED_TABLES, true, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual([]);
  });

  it("still correctly reports a genuinely missing table, even under the lowercase-returning code path", async () => {
    const presentExceptOne = REQUIRED_TABLES.filter((t) => t !== "dailyCheckinRewardGrants");
    const { query } = fakeConn("lower", presentExceptOne, true, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toContain("table dailyCheckinRewardGrants");
    expect(missing).toHaveLength(1);
  });

  it("still correctly reports a genuinely missing index on a lowercase-returned, otherwise-present table", async () => {
    const { query } = fakeConn("lower", REQUIRED_TABLES, true, ["PRIMARY", "unique_daily_checkins_coupon", "dailyCheckins_userId_idx"]);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(["index dailyCheckins.unique_daily_checkin_user_date_campaign"]);
  });

  it("reports a missing column independently of the table-name casing bug", async () => {
    const { query } = fakeConn("lower", REQUIRED_TABLES, false, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(["column coupons.maxDiscountAmount"]);
  });

  it("does not report a missing index for a table that is itself missing (no duplicate root cause)", async () => {
    const presentExceptOne = REQUIRED_TABLES.filter((t) => t !== "dailyCheckins");
    const { query } = fakeConn("lower", presentExceptOne, true, []);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(["table dailyCheckins"]);
  });
});
