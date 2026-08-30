import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as db from "./db";
import { createTestUser, uniqueTestTag } from "./test-helpers/fixtures";
import { getTestDb } from "./test-helpers/testDb";
import {
  coupons,
  pointsTransactions,
  sportsCompetitionTeams,
  sportsCompetitions,
  sportsMatchRewards,
  sportsMatches,
  sportsMatchVotes,
  sportsTeams,
  users,
} from "../drizzle/schema";

/**
 * IPE-009 behavioral coverage against the real disposable ipenovel_test DB.
 * The integration project's global setup refuses to run unless
 * TEST_DATABASE_URL is explicitly configured and live-verified as
 * `ipenovel_test`, so these tests can never fall back to production.
 */

function testDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("sports-vote-catalog.integration.test.ts requires TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

function insertedId(result: any): number {
  const id = result?.[0]?.insertId ?? result?.insertId;
  if (!id) throw new Error("Failed to extract integration fixture insert id");
  return Number(id);
}

const created = {
  users: [] as number[],
  matches: [] as number[],
  teams: [] as number[],
  competitions: [] as number[],
};

function future(minutes = 60): Date {
  return new Date(Date.now() + minutes * 60_000);
}

async function createCompetition(prefix: string, type: "league" | "cup" = "league") {
  const tag = uniqueTestTag(prefix).toUpperCase();
  const result = await db.createSportsCompetition({
    code: `${prefix.toUpperCase()}_${tag}`.slice(0, 80),
    name: `${prefix} ${tag}`,
    competitionType: type,
  });
  created.competitions.push(result.id);
  return result.id;
}

async function createTeam(prefix: string, name: string, logoImageUrl: string | null = null) {
  const tag = uniqueTestTag(prefix).toUpperCase();
  const result = await db.createSportsTeam({
    code: `${prefix.toUpperCase()}_${tag}`.slice(0, 80),
    name,
    logoImageUrl,
  });
  created.teams.push(result.id);
  return result.id;
}

async function createCatalogMatch(params: {
  competitionId: number;
  homeTeamId: number;
  awayTeamId: number;
  rewardKind?: "coupon" | "points";
  rewardPointsAmount?: string | null;
  rewardDiscountType?: "flat" | "percentage" | null;
  rewardDiscountValue?: string | null;
  rewardMinPurchaseAmount?: string | null;
  status?: "draft" | "open" | "closed";
}) {
  const tag = uniqueTestTag("match");
  const result = await db.createSportsMatch({
    title: `Fixture ${tag}`,
    competitionId: params.competitionId,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    voteDeadlineAt: future(),
    voteCostPoints: "0",
    rewardKind: params.rewardKind ?? "points",
    rewardPointsAmount: params.rewardKind === "coupon" ? null : params.rewardPointsAmount ?? "10",
    rewardDiscountType: params.rewardKind === "coupon" ? params.rewardDiscountType ?? "flat" : null,
    rewardDiscountValue: params.rewardKind === "coupon" ? params.rewardDiscountValue ?? "10" : null,
    rewardMinPurchaseAmount: params.rewardKind === "coupon" ? params.rewardMinPurchaseAmount ?? "0" : null,
    status: params.status ?? "draft",
  });
  created.matches.push(result.id);
  return result.id;
}

async function createUser() {
  const user = await createTestUser();
  created.users.push(user.id);
  return user.id;
}

afterEach(async () => {
  const t = testDb();

  for (const matchId of created.matches.splice(0)) {
    await t.delete(sportsMatchRewards).where(eq(sportsMatchRewards.matchId, matchId));
    await t.delete(sportsMatchVotes).where(eq(sportsMatchVotes.matchId, matchId));
    await t.delete(sportsMatches).where(eq(sportsMatches.id, matchId));
  }

  for (const userId of created.users.splice(0)) {
    await t.delete(sportsMatchRewards).where(eq(sportsMatchRewards.userId, userId));
    await t.delete(sportsMatchVotes).where(eq(sportsMatchVotes.userId, userId));
    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, userId));
    await t.delete(coupons).where(eq(coupons.ownerUserId, userId));
    await t.delete(users).where(eq(users.id, userId));
  }

  for (const competitionId of created.competitions.splice(0)) {
    await t.delete(sportsCompetitionTeams).where(eq(sportsCompetitionTeams.competitionId, competitionId));
    await t.delete(sportsCompetitions).where(eq(sportsCompetitions.id, competitionId));
  }

  for (const teamId of created.teams.splice(0)) {
    await t.delete(sportsCompetitionTeams).where(eq(sportsCompetitionTeams.teamId, teamId));
    await t.delete(sportsTeams).where(eq(sportsTeams.id, teamId));
  }
});

describe.sequential("IPE-009 competition/team catalog behavior", () => {
  it("creates and updates competitions/teams, reuses one canonical team across competitions, and constrains new matches to membership", async () => {
    const premierLeagueId = await createCompetition("EPL", "league");
    const championsLeagueId = await createCompetition("UCL", "cup");
    const arsenalId = await createTeam("ARS", "Arsenal", "https://cdn.example/arsenal.webp");
    const liverpoolId = await createTeam("LIV", "Liverpool", "https://cdn.example/liverpool.webp");
    const madridId = await createTeam("RMA", "Real Madrid", "https://cdn.example/madrid.webp");

    await db.updateSportsCompetition(championsLeagueId, { name: "Champions League" });
    await db.updateSportsTeam(arsenalId, { logoImageUrl: "https://cdn.example/arsenal-v2.webp" });

    await db.setSportsCompetitionTeamMembership({ competitionId: premierLeagueId, teamId: arsenalId, isMember: true });
    await db.setSportsCompetitionTeamMembership({ competitionId: premierLeagueId, teamId: liverpoolId, isMember: true });
    await db.setSportsCompetitionTeamMembership({ competitionId: championsLeagueId, teamId: arsenalId, isMember: true });
    await db.setSportsCompetitionTeamMembership({ competitionId: championsLeagueId, teamId: madridId, isMember: true });

    const competitions = await db.getAdminSportsCompetitions();
    const premierLeague = competitions.find((item: any) => item.id === premierLeagueId)!;
    const championsLeague = competitions.find((item: any) => item.id === championsLeagueId)!;
    const arsenalInLeague = premierLeague.teams.find((team: any) => team.id === arsenalId)!;
    const arsenalInCup = championsLeague.teams.find((team: any) => team.id === arsenalId)!;

    expect(championsLeague.name).toBe("Champions League");
    expect(arsenalInLeague.id).toBe(arsenalInCup.id);
    expect(arsenalInLeague.logoImageUrl).toBe("https://cdn.example/arsenal-v2.webp");
    expect(arsenalInCup.logoImageUrl).toBe(arsenalInLeague.logoImageUrl);

    const matchId = await createCatalogMatch({
      competitionId: premierLeagueId,
      homeTeamId: arsenalId,
      awayTeamId: liverpoolId,
    });
    const match = await db.getSportsMatchById(matchId);
    expect(match).toMatchObject({
      competitionId: premierLeagueId,
      homeTeamId: arsenalId,
      awayTeamId: liverpoolId,
      homeTeamName: "Arsenal",
      awayTeamName: "Liverpool",
      homeTeamImageUrl: "https://cdn.example/arsenal-v2.webp",
    });

    await expect(db.createSportsMatch({
      title: "Legacy bypass attempt",
      voteDeadlineAt: future(),
      voteCostPoints: "0",
      rewardKind: "points",
      rewardPointsAmount: "5",
    } as any)).rejects.toThrow("New Sports Vote matches require competitionId, homeTeamId, and awayTeamId");

    await expect(db.createSportsMatch({
      title: "Non-member attempt",
      competitionId: premierLeagueId,
      homeTeamId: arsenalId,
      awayTeamId: madridId,
      voteDeadlineAt: future(),
      voteCostPoints: "0",
      rewardKind: "points",
      rewardPointsAmount: "5",
    })).rejects.toThrow("Away team is not a member of the selected competition");
  });

  it("rejects digit-only canonical codes so numeric fixture references are always IDs", async () => {
    await expect(db.createSportsTeam({ code: "123", name: "Numeric Code Team" })).rejects.toThrow(
      "must include at least one letter"
    );
  });

  it("keeps pre-existing legacy name/image rows readable and editable without permitting new legacy creation", async () => {
    const t = testDb();
    const tag = uniqueTestTag("legacy");
    const insertResult = await t.insert(sportsMatches).values({
      title: `Legacy ${tag}`,
      leagueName: "Legacy League",
      homeTeamName: "Legacy Home",
      awayTeamName: "Legacy Away",
      homeTeamImageUrl: "legacy-home.webp",
      awayTeamImageUrl: "legacy-away.webp",
      voteDeadlineAt: future(),
      voteCostPoints: "0.00",
      rewardKind: "coupon",
      rewardDiscountType: "flat",
      rewardDiscountValue: "10.00",
      rewardMinPurchaseAmount: "0.00",
      status: "draft",
      isActive: true,
    });
    const matchId = insertedId(insertResult);
    created.matches.push(matchId);

    const publicRows = await db.getPublicSportsMatches();
    const legacy = publicRows.find((row: any) => row.id === matchId)!;
    expect(legacy.competitionId).toBeNull();
    expect(legacy.competitionName).toBe("Legacy League");
    expect(legacy.homeTeamName).toBe("Legacy Home");
    expect(legacy.homeTeamImageUrl).toBe("legacy-home.webp");

    await db.updateSportsMatch(matchId, { displayOrder: 42 });
    expect((await db.getSportsMatchById(matchId))?.displayOrder).toBe(42);
  });
});

describe.sequential("IPE-009 bulk fixture behavior", () => {
  it("reuses known teams across many fixtures without image columns and makes invalid batches all-or-nothing", async () => {
    const competitionId = await createCompetition("BULK", "league");
    const arsenalId = await createTeam("BARS", "Arsenal", "https://cdn.example/arsenal.webp");
    const liverpoolId = await createTeam("BLIV", "Liverpool", "https://cdn.example/liverpool.webp");
    const nonMemberId = await createTeam("BNON", "Non Member", "https://cdn.example/nonmember.webp");
    const unitedAId = await createTeam("BUA", "United", null);
    const unitedBId = await createTeam("BUB", "United", null);

    for (const teamId of [arsenalId, liverpoolId, unitedAId, unitedBId]) {
      await db.setSportsCompetitionTeamMembership({ competitionId, teamId, isMember: true });
    }

    const valid = await db.bulkCreateSportsFixtures({
      competitionId,
      rows: [
        {
          title: "Round 1",
          homeTeamRef: "Arsenal",
          awayTeamRef: "Liverpool",
          voteDeadlineAt: future(90),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
        {
          title: "Round 2",
          homeTeamRef: liverpoolId,
          awayTeamRef: arsenalId,
          voteDeadlineAt: future(120),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
      ],
    });
    expect(valid.success).toBe(true);
    expect(valid.createdCount).toBe(2);
    if (valid.success) created.matches.push(...valid.ids);

    const teamRows = await testDb().select().from(sportsTeams).where(eq(sportsTeams.id, arsenalId));
    expect(teamRows).toHaveLength(1);
    expect(teamRows[0].logoImageUrl).toBe("https://cdn.example/arsenal.webp");

    const beforeInvalid = await testDb().select().from(sportsMatches).where(eq(sportsMatches.competitionId, competitionId));
    const invalid = await db.bulkCreateSportsFixtures({
      competitionId,
      rows: [
        {
          rowNumber: 10,
          title: "Unknown",
          homeTeamRef: "UNKNOWN",
          awayTeamRef: "Arsenal",
          voteDeadlineAt: future(150),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
        {
          rowNumber: 11,
          title: "Ambiguous",
          homeTeamRef: "United",
          awayTeamRef: "Arsenal",
          voteDeadlineAt: future(180),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
        {
          rowNumber: 12,
          title: "Non-member",
          homeTeamRef: nonMemberId,
          awayTeamRef: "Arsenal",
          voteDeadlineAt: future(210),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
      ],
    });

    expect(invalid.success).toBe(false);
    expect(invalid.createdCount).toBe(0);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 10, field: "homeTeamRef", message: expect.stringContaining("Unknown team") }),
      expect.objectContaining({ rowNumber: 11, field: "homeTeamRef", message: expect.stringContaining("Ambiguous team name") }),
      expect.objectContaining({ rowNumber: 12, field: "homeTeamRef", message: expect.stringContaining("not a member") }),
    ]));

    const afterInvalid = await testDb().select().from(sportsMatches).where(eq(sportsMatches.competitionId, competitionId));
    expect(afterInvalid).toHaveLength(beforeInvalid.length);

    const duplicate = await db.bulkCreateSportsFixtures({
      competitionId,
      rows: [
        {
          rowNumber: 20,
          title: "Duplicate",
          homeTeamRef: arsenalId,
          awayTeamRef: liverpoolId,
          matchStartAt: future(300),
          voteDeadlineAt: future(240),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
        {
          rowNumber: 21,
          title: "Duplicate",
          homeTeamRef: arsenalId,
          awayTeamRef: liverpoolId,
          matchStartAt: future(300),
          voteDeadlineAt: future(240),
          voteCostPoints: "0",
          rewardKind: "points",
          rewardPointsAmount: "5",
        },
      ],
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 21, message: "Duplicate fixture row in this import" }),
    ]));
  });
});

describe.sequential("IPE-009 coupon and points settlement behavior", () => {
  async function setupVote(rewardKind: "coupon" | "points") {
    const competitionId = await createCompetition(rewardKind === "coupon" ? "CPN" : "PTS");
    const homeTeamId = await createTeam(rewardKind === "coupon" ? "CH" : "PH", "Home Team");
    const awayTeamId = await createTeam(rewardKind === "coupon" ? "CA" : "PA", "Away Team");
    await db.setSportsCompetitionTeamMembership({ competitionId, teamId: homeTeamId, isMember: true });
    await db.setSportsCompetitionTeamMembership({ competitionId, teamId: awayTeamId, isMember: true });
    const matchId = await createCatalogMatch({
      competitionId,
      homeTeamId,
      awayTeamId,
      rewardKind,
      rewardPointsAmount: rewardKind === "points" ? "25" : null,
      rewardDiscountType: rewardKind === "coupon" ? "flat" : null,
      rewardDiscountValue: rewardKind === "coupon" ? "15" : null,
      status: "open",
    });
    const userId = await createUser();
    await db.castSportsVote(userId, matchId, "home_win");
    await db.updateSportsMatch(matchId, { status: "closed" });
    return { matchId, userId };
  }

  it("retains coupon settlement behavior", async () => {
    const { matchId, userId } = await setupVote("coupon");
    const settled = await db.settleSportsMatch(matchId, "home_win");
    expect(settled).toMatchObject({ success: true, winnerCount: 1, idempotent: false });

    const rewards = await testDb().select().from(sportsMatchRewards).where(eq(sportsMatchRewards.matchId, matchId));
    expect(rewards).toHaveLength(1);
    expect(rewards[0].rewardKind).toBe("coupon");
    expect(rewards[0].couponId).not.toBeNull();
    expect(rewards[0].pointsTransactionId).toBeNull();

    const couponRows = await testDb().select().from(coupons).where(eq(coupons.ownerUserId, userId));
    expect(couponRows).toHaveLength(1);
  });

  it("credits a point winner exactly once, creates no coupon, and makes exact-result retry read-only", async () => {
    const { matchId, userId } = await setupVote("points");

    const first = await db.settleSportsMatch(matchId, "home_win");
    expect(first).toMatchObject({ success: true, winnerCount: 1, idempotent: false });

    const firstRewards = await testDb().select().from(sportsMatchRewards).where(eq(sportsMatchRewards.matchId, matchId));
    const firstPointRewards = await testDb().select().from(pointsTransactions).where(and(
      eq(pointsTransactions.userId, userId),
      eq(pointsTransactions.referenceType, "sports_reward")
    ));
    const couponsAfterFirst = await testDb().select().from(coupons).where(eq(coupons.ownerUserId, userId));

    expect(firstRewards).toHaveLength(1);
    expect(firstRewards[0].rewardKind).toBe("points");
    expect(String(firstRewards[0].pointsAmount)).toBe("25.00");
    expect(firstRewards[0].couponId).toBeNull();
    expect(firstRewards[0].pointsTransactionId).toBe(firstPointRewards[0].id);
    expect(firstPointRewards).toHaveLength(1);
    expect(String(firstPointRewards[0].amount)).toBe("25.00");
    expect(await db.getUserPointsBalance(userId)).toBe("25.00");
    expect(couponsAfterFirst).toHaveLength(0);

    const retry = await db.settleSportsMatch(matchId, "home_win");
    expect(retry).toMatchObject({ success: true, winnerCount: 1, idempotent: true });

    const rewardsAfterRetry = await testDb().select().from(sportsMatchRewards).where(eq(sportsMatchRewards.matchId, matchId));
    const pointRewardsAfterRetry = await testDb().select().from(pointsTransactions).where(and(
      eq(pointsTransactions.userId, userId),
      eq(pointsTransactions.referenceType, "sports_reward")
    ));
    const couponsAfterRetry = await testDb().select().from(coupons).where(eq(coupons.ownerUserId, userId));

    expect(rewardsAfterRetry).toHaveLength(1);
    expect(pointRewardsAfterRetry).toHaveLength(1);
    expect(couponsAfterRetry).toHaveLength(0);
    expect(await db.getUserPointsBalance(userId)).toBe("25.00");

    const rewardView = await db.getSportsRewardsForUser(userId);
    expect(rewardView).toHaveLength(1);
    expect(rewardView[0]).toMatchObject({
      rewardKind: "points",
      rewardStatus: "granted",
      couponCode: null,
    });
    expect(String(rewardView[0].pointsAmount)).toBe("25.00");

    await expect(db.settleSportsMatch(matchId, "away_win")).rejects.toThrow("already settled with result home_win");
  });
});
