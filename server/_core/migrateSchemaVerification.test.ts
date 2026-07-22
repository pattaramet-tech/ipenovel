import { describe, it, expect } from "vitest";
import {
  findMissingSchemaObjects,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  REQUIRED_NULLABLE_COLUMNS,
} from "../../scripts/migrate.mjs";

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

function fakeConn(
  tableNameCase: "camel" | "lower",
  tablesPresent: string[],
  columnsPresent: boolean,
  indexesPresent: string[],
  nullableColumnsAreNullable = true
) {
  const calls: FakeQuery[] = [];
  const query = async (sql: string, params: unknown[] = []): Promise<[any[]]> => {
    calls.push({ sql, params });
    if (sql.includes("information_schema.tables")) {
      const rows = tablesPresent.map((t) => ({ name: tableNameCase === "lower" ? t.toLowerCase() : t }));
      return [rows];
    }
    if (sql.includes("information_schema.columns")) {
      // Two different probes hit information_schema.columns: the presence
      // check selects column_name, the nullability check selects
      // is_nullable. They must be told apart here, or the nullability check
      // silently reads `undefined` and reports every column as NOT NULL.
      if (sql.includes("is_nullable")) {
        return [columnsPresent ? [{ nullable: nullableColumnsAreNullable ? "YES" : "NO" }] : []];
      }
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

  it("requires coupons.maxDiscountAmount and the daily check-in point-reward columns", () => {
    expect(REQUIRED_COLUMNS).toEqual([
      { table: "coupons", column: "maxDiscountAmount" },
      { table: "dailyCheckins", column: "couponId" },
      { table: "dailyCheckinRewardGrants", column: "pointsTransactionId" },
      { table: "dailyCheckinRewardGrants", column: "streakCountAtGrant" },
    ]);
  });

  it("requires dailyCheckins.couponId to be NULLABLE (migration 0031)", () => {
    // A point-only check-in mints no coupon. On a database still at 0030 the
    // column is NOT NULL and every point claim would fail at INSERT time, so
    // this is verified at boot and fails the deploy closed instead.
    expect(REQUIRED_NULLABLE_COLUMNS).toEqual([{ table: "dailyCheckins", column: "couponId" }]);
  });

  it("requires the dailyCheckins indexes plus the reward-grant idempotency guards", () => {
    expect(REQUIRED_INDEXES.map((i) => i.index)).toEqual([
      "PRIMARY",
      "unique_daily_checkin_user_date_campaign",
      "unique_daily_checkins_coupon",
      "dailyCheckins_userId_idx",
      "dailyCheckinRewardGrants_checkin_rule_unique",
      "dailyCheckinRewardGrants_pointsTransactionId_unique",
      "dailyCheckinRewardRules_campaign_dedupe_unique",
      "dailyCheckinCampaigns_campaignKey_unique",
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
    const presentExceptOne = REQUIRED_TABLES.filter((t) => t !== "dailyCheckinCouponTemplates");
    const { query } = fakeConn("lower", presentExceptOne, true, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    // dailyCheckinCouponTemplates has no required column or index of its own,
    // so its absence produces exactly one finding and nothing downstream.
    expect(missing).toEqual(["table dailyCheckinCouponTemplates"]);
  });

  it("still correctly reports a genuinely missing index on a lowercase-returned, otherwise-present table", async () => {
    const allButOne = REQUIRED_INDEXES.map((i) => i.index).filter(
      (i) => i !== "unique_daily_checkin_user_date_campaign"
    );
    const { query } = fakeConn("lower", REQUIRED_TABLES, true, allButOne);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(["index dailyCheckins.unique_daily_checkin_user_date_campaign"]);
  });

  it("reports every missing column independently of the table-name casing bug", async () => {
    const { query } = fakeConn("lower", REQUIRED_TABLES, false, REQUIRED_INDEXES.map((i) => i.index));
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(REQUIRED_COLUMNS.map((c) => `column ${c.table}.${c.column}`));
  });

  it("reports a NOT NULL dailyCheckins.couponId as missing nullability (database still at migration 0030)", async () => {
    const { query } = fakeConn("lower", REQUIRED_TABLES, true, REQUIRED_INDEXES.map((i) => i.index), false);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual([
      "column dailyCheckins.couponId must be nullable (migration 0031 not applied)",
    ]);
  });

  it("does not report a missing index for a table that is itself missing (no duplicate root cause)", async () => {
    const presentExceptOne = REQUIRED_TABLES.filter((t) => t !== "dailyCheckins");
    const { query } = fakeConn("lower", presentExceptOne, true, []);
    const missing = await findMissingSchemaObjects({ query });
    // The missing table is reported once; its four indexes are NOT reported
    // again as separate findings. The reward-grant/rule/campaign indexes do
    // still surface, because those tables are present.
    expect(missing).toContain("table dailyCheckins");
    expect(missing.filter((m: string) => m.startsWith("index dailyCheckins."))).toEqual([]);
  });
});
