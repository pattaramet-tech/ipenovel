import { describe, expect, it } from "vitest";
import {
  buildSportsMatchCatalogView,
  normalizeSportsCatalogCode,
  resolveSportsTeamReference,
  SportsVoteValidationError,
  validateSportsRewardConfig,
  type SportsTeamLookup,
} from "./services/sportsVoteDomain";

const arsenal: SportsTeamLookup = {
  id: 1,
  code: "ARS",
  name: "Arsenal",
  logoImageUrl: "https://cdn.example/arsenal.webp",
  isActive: true,
};
const liverpool: SportsTeamLookup = {
  id: 2,
  code: "LIV",
  name: "Liverpool",
  logoImageUrl: "https://cdn.example/liverpool.webp",
  isActive: true,
};
const chelsea: SportsTeamLookup = {
  id: 3,
  code: "CHE",
  name: "Chelsea",
  logoImageUrl: "https://cdn.example/chelsea.webp",
  isActive: true,
};

describe("Sports Vote reward configuration", () => {
  it("normalizes a points reward and clears coupon-only fields", () => {
    expect(validateSportsRewardConfig({
      rewardKind: "points",
      rewardPointsAmount: "25",
      rewardDiscountType: "flat",
      rewardDiscountValue: "99",
    })).toEqual({
      rewardKind: "points",
      rewardPointsAmount: "25.00",
      rewardDiscountType: null,
      rewardDiscountValue: null,
      rewardMinPurchaseAmount: null,
      rewardCouponExpiresAt: null,
    });
  });

  it("keeps legacy coupon rewards backward-compatible", () => {
    const reward = validateSportsRewardConfig({
      rewardKind: "coupon",
      rewardDiscountType: "percentage",
      rewardDiscountValue: "15",
      rewardMinPurchaseAmount: "100",
    });
    expect(reward.rewardKind).toBe("coupon");
    expect(reward.rewardPointsAmount).toBeNull();
    expect(reward.rewardDiscountType).toBe("percentage");
    expect(reward.rewardDiscountValue).toBe("15.00");
    expect(reward.rewardMinPurchaseAmount).toBe("100.00");
  });

  it("rejects invalid points and coupon configurations", () => {
    expect(() => validateSportsRewardConfig({ rewardKind: "points", rewardPointsAmount: "0" })).toThrow(
      SportsVoteValidationError
    );
    expect(() => validateSportsRewardConfig({
      rewardKind: "coupon",
      rewardDiscountType: "percentage",
      rewardDiscountValue: "101",
    })).toThrow("cannot exceed 100");
  });
});

describe("Sports Vote canonical team resolution", () => {
  const allTeams = [arsenal, liverpool, chelsea];
  const premierLeagueTeams = [arsenal, liverpool];

  it("resolves members by stable id, code, or normalized name", () => {
    expect(resolveSportsTeamReference(1, premierLeagueTeams, allTeams).id).toBe(arsenal.id);
    expect(resolveSportsTeamReference("ars", premierLeagueTeams, allTeams).id).toBe(arsenal.id);
    expect(resolveSportsTeamReference("  Arsenal  ", premierLeagueTeams, allTeams).id).toBe(arsenal.id);
  });

  it("rejects an existing but non-member team with a row-safe error", () => {
    expect(() => resolveSportsTeamReference("CHE", premierLeagueTeams, allTeams)).toThrow(
      "is not a member of the selected competition"
    );
  });

  it("rejects unknown and ambiguous team names", () => {
    expect(() => resolveSportsTeamReference("UNKNOWN", premierLeagueTeams, allTeams)).toThrow("Unknown team reference");

    const unitedA: SportsTeamLookup = { id: 4, code: "UNA", name: "United", isActive: true };
    const unitedB: SportsTeamLookup = { id: 5, code: "UNB", name: "United", isActive: true };
    expect(() => resolveSportsTeamReference("United", [unitedA, unitedB], [unitedA, unitedB])).toThrow(
      "Ambiguous team name"
    );
  });

  it("reuses one canonical team identity and logo across multiple competitions", () => {
    const premierLeague = [arsenal, liverpool];
    const championsLeague = [arsenal, chelsea];
    const fromLeague = resolveSportsTeamReference("ARS", premierLeague, allTeams);
    const fromCup = resolveSportsTeamReference("ARS", championsLeague, allTeams);
    expect(fromLeague.id).toBe(fromCup.id);
    expect(fromLeague.logoImageUrl).toBe(fromCup.logoImageUrl);
  });

  it("normalizes catalog codes deterministically and rejects digit-only codes so IDs stay unambiguous", () => {
    expect(normalizeSportsCatalogCode("  epl-2026 ")).toBe("EPL-2026");
    expect(() => normalizeSportsCatalogCode("bad code")).toThrow("must use 1-80 characters");
    expect(() => normalizeSportsCatalogCode("123", "team code")).toThrow("must include at least one letter");
  });
});

describe("Sports Vote legacy display fallback", () => {
  const legacyMatch = {
    id: 99,
    leagueName: "Legacy League",
    homeTeamName: "Legacy Home",
    awayTeamName: "Legacy Away",
    homeTeamImageUrl: "legacy-home.webp",
    awayTeamImageUrl: "legacy-away.webp",
  };

  it("keeps pre-catalog match names and images readable", () => {
    const view = buildSportsMatchCatalogView(legacyMatch);
    expect(view.competitionName).toBe("Legacy League");
    expect(view.homeTeamName).toBe("Legacy Home");
    expect(view.awayTeamName).toBe("Legacy Away");
    expect(view.homeTeamImageUrl).toBe("legacy-home.webp");
  });

  it("uses canonical catalog data when references exist", () => {
    const view = buildSportsMatchCatalogView(
      legacyMatch,
      { code: "EPL", name: "Premier League", competitionType: "league" },
      arsenal,
      liverpool
    );
    expect(view.competitionName).toBe("Premier League");
    expect(view.homeTeamName).toBe("Arsenal");
    expect(view.homeTeamImageUrl).toBe(arsenal.logoImageUrl);
    expect(view.awayTeamName).toBe("Liverpool");
  });
});
