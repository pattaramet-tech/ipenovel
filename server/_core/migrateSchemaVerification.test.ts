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

/**
 * `indexesPresent` accepts either bare index names (matched on the name
 * alone) or explicit {table, index} pairs. The pair form exists because
 * PRIMARY is required on several different tables - saying "PRIMARY is
 * missing" by name alone cannot express "missing on paymentSlipLegacyUnknown
 * but present on dailyCheckins", which is exactly what the 0039 index checks
 * need. information_schema.statistics is scoped by table too, so the pair
 * form is also the more faithful fake.
 */
function fakeConn(
  tableNameCase: "camel" | "lower",
  tablesPresent: string[],
  columnsPresent: boolean,
  indexesPresent: Array<string | { table: string; index: string }>,
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
      const [tableName, indexName] = params;
      const present = indexesPresent.some((entry) =>
        typeof entry === "string"
          ? entry === String(indexName)
          : entry.table === String(tableName) && entry.index === String(indexName)
      );
      return [present ? [{ name: indexName }] : []];
    }
    throw new Error(`unexpected query in fake connection: ${sql}`);
  };
  return { query, calls };
}

/** Every migration-0039 object the running application hard-depends on. */
const LEGACY_REGISTRY_TABLES = ["paymentSlipLegacyCollisions", "paymentSlipLegacyUnknown"];
const LEGACY_REGISTRY_INDEXES = [
  { table: "paymentSlipLegacyCollisions", index: "PRIMARY" },
  { table: "paymentSlipLegacyCollisions", index: "paymentSlipLegacyCollisions_member_unique" },
  { table: "paymentSlipLegacyCollisions", index: "paymentSlipLegacyCollisions_identifierHash_idx" },
  { table: "paymentSlipLegacyUnknown", index: "PRIMARY" },
  { table: "paymentSlipLegacyUnknown", index: "paymentSlipLegacyUnknown_source_unique" },
  { table: "paymentSlipLegacyUnknown", index: "paymentSlipLegacyUnknown_sourceType_idx" },
];

describe("findMissingSchemaObjects - required object lists", () => {
  it("requires the five daily check-in tables plus coupons and the migration-0039 legacy registry", () => {
    expect(REQUIRED_TABLES).toEqual([
      "dailyCheckins",
      "dailyCheckinCampaigns",
      "dailyCheckinCouponTemplates",
      "dailyCheckinRewardRules",
      "dailyCheckinRewardGrants",
      "coupons",
      "paymentSlipLegacyCollisions",
      "paymentSlipLegacyUnknown",
    ]);
  });

  it("requires coupons.maxDiscountAmount/scope/ownerUserId and the daily check-in point-reward columns", () => {
    expect(REQUIRED_COLUMNS).toEqual([
      { table: "coupons", column: "maxDiscountAmount" },
      { table: "coupons", column: "scope" },
      { table: "coupons", column: "ownerUserId" },
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

  it("requires coupons_ownerUserId_idx plus the dailyCheckins indexes, reward-grant idempotency guards and the migration-0039 registry indexes", () => {
    expect(REQUIRED_INDEXES).toEqual([
      { table: "coupons", index: "coupons_ownerUserId_idx" },
      { table: "dailyCheckins", index: "PRIMARY" },
      { table: "dailyCheckins", index: "unique_daily_checkin_user_date_campaign" },
      { table: "dailyCheckins", index: "unique_daily_checkins_coupon" },
      { table: "dailyCheckins", index: "dailyCheckins_userId_idx" },
      { table: "dailyCheckinRewardGrants", index: "dailyCheckinRewardGrants_checkin_rule_unique" },
      {
        table: "dailyCheckinRewardGrants",
        index: "dailyCheckinRewardGrants_pointsTransactionId_unique",
      },
      { table: "dailyCheckinRewardRules", index: "dailyCheckinRewardRules_campaign_dedupe_unique" },
      { table: "dailyCheckinCampaigns", index: "dailyCheckinCampaigns_campaignKey_unique" },
      ...LEGACY_REGISTRY_INDEXES,
    ]);
  });

  it("actually checks coupons_ownerUserId_idx instead of silently skipping it (regression: the index-presence gate only runs for tables listed in REQUIRED_TABLES)", async () => {
    const allButCouponsIndex = REQUIRED_INDEXES.map((i) => i.index).filter((i) => i !== "coupons_ownerUserId_idx");
    const { query } = fakeConn("camel", REQUIRED_TABLES, true, allButCouponsIndex);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual(["index coupons.coupons_ownerUserId_idx"]);
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

/**
 * IPE-004-C08 P2 (acceptance A/B). Migration 0039 created the durable legacy
 * anti-replay registry - paymentSlipLegacyCollisions (what the live approval
 * path reads to decide `known_collision` in one indexed lookup) and
 * paymentSlipLegacyUnknown (what lets the backfill's completion gate treat a
 * permanently unresolvable historical row as classified rather than skipped).
 *
 * The reviewed head listed neither in REQUIRED_TABLES/REQUIRED_INDEXES, so a
 * database whose migration journal claims 0039 ran - but whose tables or
 * indexes are absent, partially applied, or were dropped - passed startup
 * verification and the server was allowed to open a port. Every payment
 * approval would then fail at query time: exactly the production incident
 * this task exists to end, except discovered by users instead of the deploy.
 */
describe("findMissingSchemaObjects - migration 0039 legacy registry (IPE-004)", () => {
  const allTables = REQUIRED_TABLES;
  const allIndexes = REQUIRED_INDEXES.map((i) => i.index);

  it("passes when the 0039 tables and every required index are present", async () => {
    const { query } = fakeConn("camel", allTables, true, allIndexes);
    expect(await findMissingSchemaObjects({ query })).toEqual([]);
  });

  for (const table of LEGACY_REGISTRY_TABLES) {
    it(`A. fails closed naming \`table ${table}\` when 0039 left it missing`, async () => {
      const present = allTables.filter((t) => t !== table);
      const { query } = fakeConn("camel", present, true, allIndexes);
      const missing = await findMissingSchemaObjects({ query });
      expect(missing).toContain(`table ${table}`);
      // The table is the root cause - its own indexes are not reported again.
      expect(missing.filter((m: string) => m.startsWith(`index ${table}.`))).toEqual([]);
    });
  }

  for (const { table, index } of LEGACY_REGISTRY_INDEXES) {
    it(`B. fails closed naming \`index ${table}.${index}\` when that index alone is missing`, async () => {
      // PRIMARY is required on both 0039 tables, so dropping it by name must
      // scope to the one table under test - the fake connection answers the
      // index probe per (table, index) pair exactly like information_schema.
      const presentIndexes = REQUIRED_INDEXES.filter(
        (i) => !(i.table === table && i.index === index)
      );
      const { query } = fakeConn("camel", allTables, true, presentIndexes);
      const missing = await findMissingSchemaObjects({ query });
      expect(missing).toEqual([`index ${table}.${index}`]);
    });
  }

  it("A/B. reports EVERY missing 0039 object at once, not just the first", async () => {
    const present = allTables.filter((t) => !LEGACY_REGISTRY_TABLES.includes(t));
    const { query } = fakeConn("camel", present, true, allIndexes);
    const missing = await findMissingSchemaObjects({ query });
    expect(missing).toEqual([
      "table paymentSlipLegacyCollisions",
      "table paymentSlipLegacyUnknown",
    ]);
  });

  it("A. finds the 0039 tables under lower_case_table_names too (same casing rule as the rest)", async () => {
    const { query } = fakeConn("lower", allTables, true, allIndexes);
    expect(await findMissingSchemaObjects({ query })).toEqual([]);
  });
});
