import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("IPE-009 Sports Vote schema contracts", () => {
  const schema = source("drizzle/schema.ts");

  it("defines canonical competitions, teams, and reusable competition membership", () => {
    expect(schema).toContain('export const sportsCompetitions = mysqlTable(');
    expect(schema).toContain('export const sportsTeams = mysqlTable(');
    expect(schema).toContain('export const sportsCompetitionTeams = mysqlTable(');
    expect(schema).toContain('uniqueIndex("sportsCompetitionTeams_competition_team_unique")');
    expect(schema).toContain('uniqueIndex("sportsTeams_code_unique")');
  });

  it("keeps legacy match snapshots while adding nullable catalog references", () => {
    expect(schema).toContain('competitionId: int("competitionId")');
    expect(schema).toContain('homeTeamId: int("homeTeamId")');
    expect(schema).toContain('awayTeamId: int("awayTeamId")');
    expect(schema).toContain('homeTeamName: varchar("homeTeamName", { length: 255 }).notNull()');
    expect(schema).toContain('homeTeamImageUrl: text("homeTeamImageUrl")');
  });

  it("supports point rewards without requiring a coupon and links the exact points transaction", () => {
    expect(schema).toContain('rewardKind: mysqlEnum("rewardKind", ["coupon", "points"])');
    expect(schema).toContain('rewardPointsAmount: decimal("rewardPointsAmount"');
    expect(schema).toContain('couponId: int("couponId")');
    expect(schema).toContain('pointsTransactionId: int("pointsTransactionId")');
    expect(schema).toContain('uniqueIndex("unique_sports_match_rewards_points_tx")');
  });
});

describe("IPE-009 Sports Vote bulk import contracts", () => {
  const db = source("server/db.ts");
  const router = source("server/routers.ts");
  const adminUi = source("client/src/pages/AdminSportsVotesPage.tsx");

  it("resolves fixture teams against competition membership and fails the batch before any transaction on row errors", () => {
    const bulkStart = db.indexOf("export async function bulkCreateSportsFixtures");
    const bulkEnd = db.indexOf("// Strict numeric validation helpers", bulkStart);
    const bulkSource = db.slice(bulkStart, bulkEnd);
    expect(bulkSource).toContain("resolveSportsTeamReference(row.homeTeamRef, competitionTeams, allTeams)");
    expect(bulkSource).toContain("resolveSportsTeamReference(row.awayTeamRef, competitionTeams, allTeams)");
    expect(bulkSource).toContain("Duplicate fixture row in this import");
    expect(bulkSource.indexOf("if (errors.length) return")).toBeLessThan(bulkSource.indexOf("database.transaction"));
  });

  it("does not update canonical team assets unless the admin explicitly opts in", () => {
    const bulkStart = db.indexOf("export async function bulkCreateSportsFixtures");
    const bulkEnd = db.indexOf("// Strict numeric validation helpers", bulkStart);
    const bulkSource = db.slice(bulkStart, bulkEnd);
    expect(bulkSource).toContain("if (input.updateTeamAssets)");
    expect(router).toContain("updateTeamAssets: z.boolean().optional()");
    expect(adminUi).toContain("Explicitly update canonical team logos");
    expect(adminUi).toContain("Off by default");
  });

  it("exposes XLSX/CSV bulk fixture upload and catalog-only team selectors", () => {
    expect(adminUi).toContain('import * as XLSX from "xlsx"');
    expect(adminUi).toContain('accept=".xlsx,.xls,.csv"');
    expect(adminUi).toContain("Select from competition");
    expect(adminUi).toContain("Known teams need no image columns");
    expect(router).toContain("bulkCreate: adminProcedure");
  });
});

describe("IPE-009 Sports Vote settlement contracts", () => {
  const db = source("server/db.ts");

  it("treats an exact retry of an already-settled result as an idempotent success", () => {
    const start = db.indexOf("export async function settleSportsMatch");
    const end = db.indexOf("export async function cancelSportsMatch", start);
    const settle = db.slice(start, end);
    expect(settle).toContain('if (match.status === "settled")');
    expect(settle).toContain("if (match.result !== result)");
    expect(settle).toContain("idempotent: true");
  });

  it("credits point winners through the auditable points ledger and creates no coupon in the point branch", () => {
    const settleStart = db.indexOf("export async function settleSportsMatch");
    const winnerRewardCheck = db.indexOf("if (existingReward.length)", settleStart);
    const start = db.indexOf("if (rewardKind === \"points\")", winnerRewardCheck);
    const end = db.indexOf("} else {", start);
    const pointsBranch = db.slice(start, end);
    const settle = db.slice(settleStart, end);
    expect(settle).toContain("lockPointsAccountRowsForUpdate(pointWinnerUserIds, tx)");
    expect(pointsBranch).not.toContain("lockUserForPoints(vote.userId, tx)");
    expect(pointsBranch).toContain("recordPointsTransactionReturningId");
    expect(pointsBranch).toContain('referenceType: "sports_reward"');
    expect(pointsBranch).toContain("couponId: null");
    expect(pointsBranch).not.toContain("tx.insert(coupons)");
  });

  it("retains the legacy coupon settlement branch", () => {
    const start = db.indexOf("export async function settleSportsMatch");
    const end = db.indexOf("export async function cancelSportsMatch", start);
    const settle = db.slice(start, end);
    expect(settle).toContain("tx.insert(coupons).values");
    expect(settle).toContain('rewardKind: "coupon"');
    expect(settle).toContain("rewardCouponCode: code");
  });
});

describe("IPE-009 non-destructive migration contracts", () => {
  const migration = source("drizzle/0044_add_sports_vote_catalog_points_rewards.sql");
  const migrateRunner = source("scripts/migrate.mjs");

  it("adds the catalog and points-reward schema without dropping legacy columns or tables", () => {
    expect(migration).toContain("CREATE TABLE `sportsCompetitions`");
    expect(migration).toContain("CREATE TABLE `sportsTeams`");
    expect(migration).toContain("CREATE TABLE `sportsCompetitionTeams`");
    expect(migration).toContain("ALTER TABLE `sportsMatches` ADD `rewardKind`");
    expect(migration).toContain("ALTER TABLE `sportsMatchRewards` MODIFY COLUMN `couponId` int;");
    expect(migration).not.toContain("ALTER TABLE `sportsMatchRewards` MODIFY COLUMN `couponId` int NOT NULL");
    expect(migration.toUpperCase()).not.toContain("DROP TABLE");
    expect(migration.toUpperCase()).not.toContain("DROP COLUMN");
  });

  it("makes startup fail closed when critical IPE-009 schema objects are missing", () => {
    expect(migrateRunner).toContain('"sportsCompetitions"');
    expect(migrateRunner).toContain('{ table: "sportsMatches", column: "rewardKind" }');
    expect(migrateRunner).toContain('{ table: "sportsMatchRewards", index: "unique_sports_match_rewards_points_tx" }');
    expect(migrateRunner).toContain('{ table: "sportsMatchRewards", column: "couponId" }');
  });
});
