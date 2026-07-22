import { describe, it, expect } from "vitest";
import {
  resolveDailyCheckinCardState,
  formatPointsForDisplay,
  formatCouponDiscountLabel,
  type DailyCheckinStatusView,
} from "./dailyCheckinPresentation";

/**
 * Card-state coverage for DailyCheckinCard. This repo has no DOM/component
 * test harness, so the component's decision logic lives in a pure module and
 * is tested directly here - the same pattern as
 * client/src/pages/checkoutOutcome.ts.
 */

const pointsReward = {
  kind: "points" as const,
  pointsAmount: "1.00",
  pointsTransactionId: 42,
  // Deliberately different from statusOf()'s default pointsBalance ("0.00")
  // in the tests below that combine the two - this is the fixed historical
  // snapshot from grant time, never what the card should display.
  balanceAfterGrant: "6.00",
  streakCountAtGrant: 3,
};

const couponReward = {
  kind: "coupon" as const,
  couponId: 7,
  couponCode: "CHKIN20260722U1ABC",
  discountType: "percentage",
  discountValue: "5.00",
  maxDiscountAmount: "10.00",
  minPurchaseAmount: "50.00",
  expiresAt: "2026-07-29T00:00:00.000Z",
  status: "issued",
};

function statusOf(overrides: Partial<DailyCheckinStatusView>): DailyCheckinStatusView {
  return {
    authenticated: true,
    checkedInToday: false,
    campaignActive: true,
    rewardMode: "legacy_coupon",
    pointsBalance: "0.00",
    rewards: [],
    reward: null,
    ...overrides,
  };
}

describe("resolveDailyCheckinCardState", () => {
  it("loading takes priority over everything", () => {
    expect(resolveDailyCheckinCardState({ isLoading: true, isError: true, status: null }).state).toBe("loading");
  });

  it("error state when the query failed", () => {
    expect(resolveDailyCheckinCardState({ isLoading: false, isError: true, status: null }).state).toBe("error");
  });

  it("anonymous when unauthenticated", () => {
    expect(
      resolveDailyCheckinCardState({ isLoading: false, isError: false, status: { authenticated: false } }).state
    ).toBe("anonymous");
  });

  it("anonymous when the status payload is missing entirely", () => {
    expect(resolveDailyCheckinCardState({ isLoading: false, isError: false, status: null }).state).toBe("anonymous");
  });

  it("claimable in POINT mode", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ rewardMode: "points" }),
    });
    expect(view.state).toBe("claimable_points");
  });

  it("claimable in LEGACY COUPON mode", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ rewardMode: "legacy_coupon" }),
    });
    expect(view.state).toBe("claimable_coupon");
  });

  it("scheduled-but-not-started still renders the coupon CTA (server reports legacy_coupon)", () => {
    // The scheduled state is invisible to the user by design: until the
    // Bangkok start date the server is still in legacy mode.
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ rewardMode: "legacy_coupon" }),
    });
    expect(view.state).toBe("claimable_coupon");
  });

  it("claimed POINT reward", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewardMode: "points", rewards: [pointsReward], pointsBalance: "6.00" }),
    });
    expect(view.state).toBe("claimed_points");
    if (view.state === "claimed_points") {
      expect(view.reward.pointsAmount).toBe("1.00");
      expect(view.reward.balanceAfterGrant).toBe("6.00");
      expect(view.pointsBalance).toBe("6.00");
    }
  });

  it("POST-SPEND: a user who earned 1 point and later spent it shows the reward as received, but the CURRENT balance - not the grant-time snapshot", () => {
    // statusOf's default pointsBalance is "0.00"; pointsReward's
    // balanceAfterGrant is fixed at "6.00" (the balance at grant time,
    // before any later spend). The card must show 0.00, not 6.00.
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewardMode: "points", rewards: [pointsReward], pointsBalance: "0.00" }),
    });
    expect(view.state).toBe("claimed_points");
    if (view.state === "claimed_points") {
      // The reward itself still honestly reports 1 point was received.
      expect(view.reward.pointsAmount).toBe("1.00");
      // The grant-time snapshot is untouched by the later spend.
      expect(view.reward.balanceAfterGrant).toBe("6.00");
      // But the balance the card must actually DISPLAY is current, not historical.
      expect(view.pointsBalance).toBe("0.00");
    }
  });

  it("claimed COUPON reward", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewards: [couponReward] }),
    });
    expect(view.state).toBe("claimed_coupon");
    if (view.state === "claimed_coupon") {
      expect(view.reward.couponCode).toBe("CHKIN20260722U1ABC");
    }
  });

  it("CUTOVER DAY: a coupon claimed earlier still shows the coupon, even though the server is now in point mode", () => {
    // Product rule: that user did NOT receive a point, so they must never be
    // told they did - and must not be offered a second claim.
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewardMode: "points", rewards: [couponReward] }),
    });
    expect(view.state).toBe("claimed_coupon");
  });

  it("hidden when the campaign is disabled and nothing was claimed today", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ campaignActive: false, rewardMode: "disabled" }),
    });
    expect(view.state).toBe("hidden");
  });

  it("a reward claimed before the campaign was disabled is still shown", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ campaignActive: false, rewardMode: "disabled", checkedInToday: true, rewards: [pointsReward] }),
    });
    expect(view.state).toBe("claimed_points");
  });

  it("hidden rather than inventing a reward when checked in but rewards[] is empty", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewards: [] }),
    });
    expect(view.state).toBe("hidden");
  });

  it("never surfaces a coupon code for a point reward", () => {
    const view = resolveDailyCheckinCardState({
      isLoading: false,
      isError: false,
      status: statusOf({ checkedInToday: true, rewardMode: "points", rewards: [pointsReward] }),
    });
    expect(JSON.stringify(view)).not.toMatch(/couponCode/);
  });
});

describe("formatPointsForDisplay", () => {
  it('renders "1.00" as "1"', () => {
    expect(formatPointsForDisplay("1.00")).toBe("1");
  });

  it('renders "6.00" as "6"', () => {
    expect(formatPointsForDisplay("6.00")).toBe("6");
  });

  it('keeps a real fraction: "12.50" -> "12.5"', () => {
    expect(formatPointsForDisplay("12.50")).toBe("12.5");
  });

  it("handles null/undefined/garbage without throwing", () => {
    expect(formatPointsForDisplay(null)).toBe("0");
    expect(formatPointsForDisplay(undefined)).toBe("0");
    expect(formatPointsForDisplay("not-a-number")).toBe("0");
  });
});

describe("formatCouponDiscountLabel", () => {
  it("percentage with a cap (Thai)", () => {
    expect(formatCouponDiscountLabel(couponReward, "th")).toBe("5% (สูงสุด ฿10)");
  });

  it("percentage with a cap (English)", () => {
    expect(formatCouponDiscountLabel(couponReward, "en")).toBe("5% (max ฿10)");
  });

  it("percentage with no cap", () => {
    expect(formatCouponDiscountLabel({ ...couponReward, maxDiscountAmount: null }, "en")).toBe("5%");
  });

  it("flat discount", () => {
    expect(formatCouponDiscountLabel({ ...couponReward, discountType: "flat", discountValue: "25.00" }, "en")).toBe("฿25");
  });
});
