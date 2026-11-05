import { describe, expect, it } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "../../drizzle/schema";
import {
  ADMIN_USER_DELETION_CLASSIFICATION,
  ADMIN_USER_DELETION_INDIRECT_TABLES,
} from "./adminUserDeletionClassification";
import { ADMIN_USER_DELETE_CHECKS } from "../db";

/**
 * Exhaustive, REFLECTION-based (not hand-maintained-list-based) proof that
 * every user-referencing column in drizzle/schema.ts has been deliberately
 * classified for the Admin Users Management hard-delete safety check - see
 * adminUserDeletionClassification.ts's own top-of-file docstring. Mirrors
 * server/services/accountRecoveryDataClassification.test.ts's pattern
 * exactly, applied to this feature's own (deliberately separate)
 * classification list.
 */

const USER_REFERENCE_COLUMN_NAME_PATTERN =
  /userid|ownerid|createdby|reviewedby|approvedby|actorid|adminid|recipientid|requesterid/i;

type DiscoveredColumn = { table: string; column: string };

function discoverUserReferenceColumns(): DiscoveredColumn[] {
  const found: DiscoveredColumn[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, MySqlTable)) continue;
    const columns = getTableColumns(value as any);
    for (const [columnKey, column] of Object.entries(columns)) {
      const col = column as { dataType?: string };
      if (col.dataType !== "number") continue;
      if (!USER_REFERENCE_COLUMN_NAME_PATTERN.test(columnKey)) continue;
      found.push({ table: exportName, column: columnKey });
    }
  }
  return found;
}

function discoverAllTableNames(): Set<string> {
  const names = new Set<string>();
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, MySqlTable)) continue;
    names.add(exportName);
  }
  return names;
}

describe("ADMIN_USER_DELETION_CLASSIFICATION is exhaustive and up to date", () => {
  const discovered = discoverUserReferenceColumns();
  const discoveredKeys = new Set(discovered.map((d) => `${d.table}.${d.column}`));
  const classifiedKeys = new Set(
    ADMIN_USER_DELETION_CLASSIFICATION.map((c) => `${c.table}.${c.column}`)
  );

  it("discovery actually found something (sanity check that reflection itself works, not silently returning an empty list)", () => {
    expect(discovered.length).toBeGreaterThan(20);
  });

  it("every discovered user-referencing column in the schema has a classification entry - fails when a new column is added without a classification decision", () => {
    const unclassified = discovered.filter((d) => !classifiedKeys.has(`${d.table}.${d.column}`));
    expect(unclassified).toEqual([]);
  });

  it("every classification entry corresponds to a real, currently-existing table+column - fails when one is renamed/removed and this file goes stale", () => {
    const stale = ADMIN_USER_DELETION_CLASSIFICATION.filter(
      (c) => !discoveredKeys.has(`${c.table}.${c.column}`)
    );
    expect(stale).toEqual([]);
  });

  it("no duplicate (table, column) entries in the classification list", () => {
    const keys = ADMIN_USER_DELETION_CLASSIFICATION.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every classification entry has a non-empty reason", () => {
    for (const entry of ADMIN_USER_DELETION_CLASSIFICATION) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("exactly one entry is classified as login_data (authIdentities.userId) - never treated as a blocker", () => {
    const loginData = ADMIN_USER_DELETION_CLASSIFICATION.filter((c) => c.category === "login_data");
    expect(loginData).toEqual([
      expect.objectContaining({ table: "authIdentities", column: "userId" }),
    ]);
  });

  it("actor/admin reference columns that Account Recovery deliberately ignores are treated as blockers here (audit_or_actor) - deletion has a strictly stricter policy", () => {
    const actorTables = ADMIN_USER_DELETION_CLASSIFICATION.filter((c) => c.category === "audit_or_actor").map(
      (c) => `${c.table}.${c.column}`
    );
    expect(actorTables).toEqual(
      expect.arrayContaining([
        "orderHistory.actorUserId",
        "payments.reviewedByUserId",
        "payments.approvedByAdminId",
        "topupLogs.createdBy",
        "walletTopups.reviewedByUserId",
        "walletTopups.approvedByAdminId",
        "dailyCheckinCampaigns.createdBy",
      ])
    );
  });

  it("workspacePublishRuns.requestedByUserId is audit_or_actor so a requesting Admin cannot be hard-deleted", () => {
    const entry = ADMIN_USER_DELETION_CLASSIFICATION.find(
      (c) => c.table === "workspacePublishRuns" && c.column === "requestedByUserId"
    );
    expect(entry?.category).toBe("audit_or_actor");
  });

  it("[review finding on PR #45] adminUserAuditLogs.actorAdminId (WHO performed a past edit/delete) is audit_or_actor - a former admin's identity must remain protected even after they're demoted to role=\"user\"", () => {
    const entry = ADMIN_USER_DELETION_CLASSIFICATION.find(
      (c) => c.table === "adminUserAuditLogs" && c.column === "actorAdminId"
    );
    expect(entry?.category).toBe("audit_or_actor");
  });

  it("adminUserAuditLogs.targetUserId (WHAT was done to a user) stays never_blocks - the record of a past action on this account must survive its deletion, unlike who performed it", () => {
    const entry = ADMIN_USER_DELETION_CLASSIFICATION.find(
      (c) => c.table === "adminUserAuditLogs" && c.column === "targetUserId"
    );
    expect(entry?.category).toBe("never_blocks");
  });
});

describe("indirect (no-direct-column) tables are documented and real", () => {
  const allTableNames = discoverAllTableNames();

  it("every ADMIN_USER_DELETION_INDIRECT_TABLES entry names a real table export", () => {
    for (const entry of ADMIN_USER_DELETION_INDIRECT_TABLES) {
      expect(allTableNames.has(entry.table)).toBe(true);
    }
  });

  it("cartItems, orderItems, and payments (no direct userId column) are present in the indirect inventory", () => {
    const tableNames = ADMIN_USER_DELETION_INDIRECT_TABLES.map((e) => e.table);
    expect(tableNames).toContain("cartItems");
    expect(tableNames).toContain("orderItems");
    expect(tableNames).toContain("payments");
  });
});

describe("R2: ADMIN_USER_DELETE_CHECKS runtime registry matches the engagement classification (no drift)", () => {
  // The runtime registry (server/db.ts) is now exported; every engagement
  // classification entry must map to exactly one registry check covering
  // the same table/column/category/reference, via the introspectable
  // coversColumns metadata (OR-grouped entries are allowed to list several
  // columns in one check - engagement entries are all single-column).
  const engagement = ADMIN_USER_DELETION_CLASSIFICATION.filter((e) =>
    e.table.startsWith("engagement") ||
    e.table.startsWith("supportTicket") ||
    e.table === "contentReports" ||
    e.table === "contentReportDecisions" ||
    e.table === "novelComments" ||
    e.table === "novelCommentModerationAudit" ||
    e.table === "novelRatings"
  );

  it("all 12 engagement classification columns have a runtime registry check", () => {
    expect(engagement).toHaveLength(12);
    const registryByKey = new Map(
      ADMIN_USER_DELETE_CHECKS.flatMap((check) =>
        (check.coversColumns ?? []).map((column) => [check.table + "." + column, check] as const)
      )
    );
    for (const entry of engagement) {
      const check = registryByKey.get(entry.table + "." + entry.column);
      expect({ table: entry.table, column: entry.column, covered: !!check }).toEqual({
        table: entry.table, column: entry.column, covered: true,
      });
    }
  });

  it("registry category and reference labels match the classification exactly", () => {
    const registryByKey = new Map(
      ADMIN_USER_DELETE_CHECKS.flatMap((check) =>
        (check.coversColumns ?? []).map((column) => [check.table + "." + column, check] as const)
      )
    );
    for (const entry of engagement) {
      const check = registryByKey.get(entry.table + "." + entry.column)!;
      expect({
        table: entry.table, column: entry.column,
        category: check.category, reference: check.reference,
      }).toEqual({
        table: entry.table, column: entry.column,
        category: entry.category, reference: entry.reference,
      });
    }
  });

  it("OR grouping: engagement registry entries are single-column (7 user_owned + 5 audit_or_actor as separate entries)", () => {
    const engagementChecks = ADMIN_USER_DELETE_CHECKS.filter((check) =>
      (check.coversColumns ?? []).length > 0 &&
      (check.table.startsWith("engagement") || check.table.startsWith("supportTicket") ||
        check.table === "contentReports" || check.table === "contentReportDecisions" ||
        check.table === "novelComments" || check.table === "novelCommentModerationAudit" ||
        check.table === "novelRatings")
    );
    expect(engagementChecks).toHaveLength(12);
    // 7 user_owned (one per user-owned column) + 5 audit_or_actor
    expect(engagementChecks.filter((c) => c.category === "user_owned")).toHaveLength(7);
    expect(engagementChecks.filter((c) => c.category === "audit_or_actor")).toHaveLength(5);
    // every coversColumns entry is single-column: no OR-merged engagement entry exists
    for (const check of engagementChecks) {
      expect((check.coversColumns ?? []).length).toBe(1);
    }
  });

  it("assessment safety: engagement ownership or actor references never yield canDelete=true", () => {
    // The registry entries feed getAdminUserDeleteAssessment - a non-empty
    // engagement blocker list must not be reported as deletable. This is a
    // static wiring assertion: every engagement blocker category is one of
    // the unconditional block categories ("user_owned"/"audit_or_actor"),
    // never "never_blocks"/"login_data".
    const engagementChecks = ADMIN_USER_DELETE_CHECKS.filter(
      (check) => (check.coversColumns ?? []).length > 0 &&
        (check.table.startsWith("engagement") || check.table.startsWith("supportTicket") ||
          check.table === "contentReports" || check.table === "contentReportDecisions" ||
          check.table === "novelComments" || check.table === "novelCommentModerationAudit" ||
          check.table === "novelRatings")
    );
    expect(engagementChecks.length).toBeGreaterThan(0);
    for (const check of engagementChecks) {
      expect(["user_owned", "audit_or_actor"]).toContain(check.category);
    }
  });
});

// ============================================================================
// R3 hard-delete runtime proof: getAdminUserDeleteAssessment() driven through
// an INJECTED MOCK DATABASE (passed as the tx parameter - the documented
// injection point). The mock captures every executed table + WHERE SQL so
// the test can prove the REAL query conditions for all 12 engagement
// references, and prove canDelete=false whenever any engagement reference
// holds data. Mock tests do NOT prove database concurrency/atomicity -
// that evidence requires disposable-DB integration runs.
// ============================================================================
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import { getAdminUserDeleteAssessment } from "../db";

const ENGAGEMENT_TABLE_PREFIXES = [
  "engagement", "supportTicket", "contentReports", "contentReportDecisions",
  "novelComments", "novelCommentModerationAudit", "novelRatings",
];
const isEngagementRegistryCheck = (check: { table: string; coversColumns?: string[] }) =>
  (check.coversColumns ?? []).length > 0 &&
  ENGAGEMENT_TABLE_PREFIXES.some((p) => check.table.startsWith(p));

function makeMockDb(countFor: (tableName: string, whereSql: string) => number) {
  const captured: Array<{ table: string; whereSql: string; params: unknown[] }> = [];
  const dialect = new MySqlDialect();
  const db = {
    select(_selection: unknown) {
      return {
        from(table: any) {
          const tableName = getTableName(table);
          return {
            where(condition: any) {
              const query = dialect.sqlToQuery(condition);
              captured.push({ table: tableName, whereSql: query.sql, params: query.params });
              const hitCount = countFor(tableName, query.sql);
              return Promise.resolve([{ value: hitCount }]);
            },
          };
        },
      };
    },
  };
  return { db, captured };
}

describe("R3: hard-delete runtime proof over the engagement registries (mock DB)", () => {
  const engagementChecks = ADMIN_USER_DELETE_CHECKS.filter(isEngagementRegistryCheck);

  it("all 12 engagement references are registered runtime checks with coversColumns metadata", () => {
    expect(engagementChecks).toHaveLength(12);
    for (const check of engagementChecks) {
      expect((check.coversColumns ?? []).length).toBe(1);
    }
  });

  it("WHERE conditions of every engagement check reference its classified table+column (coversColumns == real query SQL)", () => {
    const { db, captured } = makeMockDb(() => 0);
    for (const check of engagementChecks) {
      void db.select({ value: 1 }).from(check.from).where(check.condition(7));
    }
    for (const check of engagementChecks) {
      const expectedColumnRef = "`" + check.table + "`.`" + check.coversColumns![0] + "`";
      // supportTickets appears twice (owner + assignment checks): pair by the
      // covered column appearing in the captured WHERE SQL, not by table alone
      const capture = captured.find(
        (c) => c.table === check.table && c.whereSql.includes(expectedColumnRef)
      );
      expect({ table: check.table, column: check.coversColumns![0], executed: !!capture }).toEqual({
        table: check.table, column: check.coversColumns![0], executed: true,
      });
      expect(capture!.whereSql).toContain(expectedColumnRef);
    }
  });

  it("USER-OWNED case: engagement data present -> canDelete=false with the engagement blocker", async () => {
    const { db } = makeMockDb((tableName) => (tableName === "engagementFeedback" ? 2 : 0));
    const assessment = await getAdminUserDeleteAssessment(7, db as any);
    expect(assessment.canDelete).toBe(false);
    const blocker = assessment.blockers.find((b: any) => b.table === "engagementFeedback");
    expect(blocker).toEqual(expect.objectContaining({ count: 2, category: "user_owned" }));
  });

  it("AUDIT/ACTOR case: moderation audit actor reference present -> canDelete=false", async () => {
    const { db } = makeMockDb((tableName) => (tableName === "novelCommentModerationAudit" ? 3 : 0));
    const assessment = await getAdminUserDeleteAssessment(7, db as any);
    expect(assessment.canDelete).toBe(false);
    const blocker = assessment.blockers.find((b: any) => b.table === "novelCommentModerationAudit");
    expect(blocker).toEqual(expect.objectContaining({ count: 3, category: "audit_or_actor" }));
  });

  it("empty engagement state -> canDelete=true (no engagement blockers reported)", async () => {
    const { db } = makeMockDb(() => 0);
    const assessment = await getAdminUserDeleteAssessment(7, db as any);
    expect(assessment.canDelete).toBe(true);
    expect(
      assessment.blockers.filter((b: any) =>
        ENGAGEMENT_TABLE_PREFIXES.some((p) => b.table.startsWith(p))
      )
).toHaveLength(0);
  });
});

describe("R4 table-driven hard-delete proof: every engagement reference blocks deletion (mock DB)", () => {
  // Each case: simulate a hit ONLY on the tested (table, column) reference by
  // inspecting the captured WHERE SQL; the assessment must report
  // canDelete=false with exactly one blocker carrying the classification's
  // category and reference label. ownerUserId and assignedAdminId on
  // supportTickets are verified as two SEPARATE cases (different categories
  // from the same table).
  const CASES = [
    { table: "engagementFeedback", column: "userId", category: "user_owned", reference: "Feedback Submissions" },
    { table: "supportTickets", column: "ownerUserId", category: "user_owned", reference: "Support Tickets" },
    { table: "supportTickets", column: "assignedAdminId", category: "audit_or_actor", reference: "Ticket Assignment" },
    { table: "supportTicketMessages", column: "actorUserId", category: "user_owned", reference: "Support Ticket Messages" },
    { table: "supportTicketStatusEvents", column: "actorUserId", category: "audit_or_actor", reference: "Ticket Status Events" },
    { table: "supportTicketMessageRedactions", column: "redactedByAdminUserId", category: "audit_or_actor", reference: "Ticket Message Redactions" },
    { table: "contentReports", column: "reporterUserId", category: "user_owned", reference: "Content Reports" },
    { table: "contentReportDecisions", column: "adminUserId", category: "audit_or_actor", reference: "Content Report Decisions" },
    { table: "novelComments", column: "authorUserId", category: "user_owned", reference: "Novel Comments" },
    { table: "novelCommentModerationAudit", column: "actorUserId", category: "audit_or_actor", reference: "Comment Moderation Audit" },
    { table: "novelRatings", column: "userId", category: "user_owned", reference: "Novel Ratings" },
    { table: "engagementIdempotencyRecords", column: "userId", category: "user_owned", reference: "Engagement Idempotency Records" },
  ];

  it.each(CASES)("$table.$column hit -> canDelete=false, blocker category=$category", async ({ table, column, category, reference }) => {
    const captured: Array<{ table: string; whereSql: string }> = [];
    const dialect = new MySqlDialect();
    const db = {
      select(_selection: unknown) {
        return {
          from(t: any) {
            const tableName = getTableName(t);
            return {
              where(condition: any) {
                const query = dialect.sqlToQuery(condition);
                const whereSql = query.sql;
                captured.push({ table: tableName, whereSql });
                // hit ONLY the tested reference: this table + this exact column
                const testedColumnRef = "`" + table + "`." + "`" + column + "`";
                const isTestedReference = tableName === table && whereSql.includes(testedColumnRef);
                return Promise.resolve([{ value: isTestedReference ? 1 : 0 }]);
              },
            };
          },
        };
      },
    };

    const assessment = await getAdminUserDeleteAssessment(7, db as any);

    expect(assessment.canDelete).toBe(false);
    const matchingBlockers = assessment.blockers.filter(
      (b: any) => b.table === table && b.category === category && b.count >= 1
    );
    expect(matchingBlockers).toHaveLength(1);
    expect(matchingBlockers[0].reference).toBe(reference);
    // the tested column's WHERE SQL was actually executed against the registry
    const testedCapture = captured.find(
      (c) => c.table === table && c.whereSql.includes("`" + table + "`." + "`" + column + "`")
    );
    expect(testedCapture).toBeDefined();
  });
});
