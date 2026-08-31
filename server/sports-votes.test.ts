import { describe, expect, it } from "vitest";
import {
  parseStrictNonNegativeDecimal,
  parseStrictPositiveDecimal,
} from "./db";
import {
  buildSportsMatchCatalogView,
  normalizeSportsCatalogCode,
  resolveSportsTeamReference,
  validateSportsRewardConfig,
  type SportsTeamLookup,
} from "./services/sportsVoteDomain";

describe("Sports Votes - Numeric Validation", () => {
  describe("parseStrictNonNegativeDecimal", () => {
    it("accepts valid non-negative decimals", () => {
      expect(parseStrictNonNegativeDecimal("10.50", "test")).toBe(10.5);
      expect(parseStrictNonNegativeDecimal("0", "test")).toBe(0);
      expect(parseStrictNonNegativeDecimal("100", "test")).toBe(100);
    });

    it("rejects invalid formats", () => {
      for (const invalid of ["10abc", "", "   ", "1e3", "0x10", "-1"]) {
        expect(() => parseStrictNonNegativeDecimal(invalid, "test")).toThrow();
      }
    });

    it("returns zero for undefined/null legacy optional values", () => {
      expect(parseStrictNonNegativeDecimal(undefined, "test")).toBe(0);
      expect(parseStrictNonNegativeDecimal(null, "test")).toBe(0);
    });
  });

  describe("parseStrictPositiveDecimal", () => {
    it("accepts valid positive decimals", () => {
      expect(parseStrictPositiveDecimal("10.50", "test")).toBe(10.5);
      expect(parseStrictPositiveDecimal("0.01", "test")).toBe(0.01);
      expect(parseStrictPositiveDecimal("100", "test")).toBe(100);
    });

    it("rejects zero, negative, missing, and malformed values", () => {
      for (const invalid of ["0", "-1", "10abc", "", "1e3", undefined, null]) {
        expect(() => parseStrictPositiveDecimal(invalid, "test")).toThrow();
      }
    });
  });
});

describe("Sports Votes - Executable domain policies", () => {
  const arsenal: SportsTeamLookup = { id: 1, code: "ARS", name: "Arsenal", logoImageUrl: "ars.webp", isActive: true };
  const liverpool: SportsTeamLookup = { id: 2, code: "LIV", name: "Liverpool", logoImageUrl: "liv.webp", isActive: true };
  const chelsea: SportsTeamLookup = { id: 3, code: "CHE", name: "Chelsea", logoImageUrl: "che.webp", isActive: true };

  it("keeps digit-only references reserved for IDs by rejecting digit-only catalog codes", () => {
    expect(normalizeSportsCatalogCode("EPL-2026")).toBe("EPL-2026");
    expect(() => normalizeSportsCatalogCode("123", "team code")).toThrow("must include at least one letter");
  });

  it("resolves a competition member by ID/code/name and rejects a non-member", () => {
    const members = [arsenal, liverpool];
    const all = [arsenal, liverpool, chelsea];
    expect(resolveSportsTeamReference(1, members, all).id).toBe(1);
    expect(resolveSportsTeamReference("ars", members, all).id).toBe(1);
    expect(resolveSportsTeamReference(" Arsenal ", members, all).id).toBe(1);
    expect(() => resolveSportsTeamReference("CHE", members, all)).toThrow("not a member");
  });

  it("reports ambiguous names instead of silently picking a canonical team", () => {
    const unitedA: SportsTeamLookup = { id: 4, code: "UNA", name: "United", isActive: true };
    const unitedB: SportsTeamLookup = { id: 5, code: "UNB", name: "United", isActive: true };
    expect(() => resolveSportsTeamReference("United", [unitedA, unitedB], [unitedA, unitedB])).toThrow("Ambiguous team name");
  });

  it("normalizes a points reward with no coupon fields and keeps coupon validation", () => {
    expect(validateSportsRewardConfig({ rewardKind: "points", rewardPointsAmount: "25" })).toEqual({
      rewardKind: "points",
      rewardPointsAmount: "25.00",
      rewardDiscountType: null,
      rewardDiscountValue: null,
      rewardMinPurchaseAmount: null,
      rewardCouponExpiresAt: null,
    });
    expect(validateSportsRewardConfig({
      rewardKind: "coupon",
      rewardDiscountType: "flat",
      rewardDiscountValue: "15",
      rewardMinPurchaseAmount: "100",
    })).toMatchObject({
      rewardKind: "coupon",
      rewardPointsAmount: null,
      rewardDiscountType: "flat",
      rewardDiscountValue: "15.00",
      rewardMinPurchaseAmount: "100.00",
    });
  });

  it("preserves legacy match display fields when no catalog records exist", () => {
    const view = buildSportsMatchCatalogView({
      leagueName: "Legacy League",
      homeTeamName: "Legacy Home",
      awayTeamName: "Legacy Away",
      homeTeamImageUrl: "legacy-home.webp",
      awayTeamImageUrl: "legacy-away.webp",
    });
    expect(view).toMatchObject({
      competitionName: "Legacy League",
      homeTeamName: "Legacy Home",
      awayTeamName: "Legacy Away",
      homeTeamImageUrl: "legacy-home.webp",
      awayTeamImageUrl: "legacy-away.webp",
    });
  });
});
