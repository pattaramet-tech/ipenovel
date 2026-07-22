/**
 * Pure presentation logic for DailyCheckinCard, extracted so every card state
 * can be unit-tested without a DOM harness (this repo has no client component
 * test runner - see client/src/pages/checkoutOutcome.ts for the same pattern).
 *
 * The component NEVER decides what the reward is worth. The server sends an
 * explicitly discriminated `rewards[]` array; this module only chooses which
 * copy to render for it.
 */

export type DailyCheckinRewardView =
  | {
      kind: "points";
      pointsAmount: string;
      pointsTransactionId: number;
      balanceAfter: string;
      streakCountAtGrant: number;
    }
  | {
      kind: "coupon";
      couponId: number;
      couponCode: string;
      discountType: string;
      discountValue: string;
      maxDiscountAmount: string | null;
      minPurchaseAmount: string;
      expiresAt: string | Date | null;
      status: string;
    };

export interface DailyCheckinStatusView {
  authenticated?: boolean;
  checkedInToday?: boolean;
  campaignActive?: boolean;
  rewardMode?: "legacy_coupon" | "points" | "disabled";
  pointsBalance?: string;
  rewards?: DailyCheckinRewardView[];
  reward?: unknown;
}

export type DailyCheckinCardState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "anonymous" }
  | { state: "hidden" }
  | { state: "claimable_points" }
  | { state: "claimable_coupon" }
  | { state: "claimed_points"; reward: Extract<DailyCheckinRewardView, { kind: "points" }> }
  | { state: "claimed_coupon"; reward: Extract<DailyCheckinRewardView, { kind: "coupon" }> };

/**
 * The single decision function for what the card renders.
 *
 * Note the claimed-coupon branch is checked before the reward MODE: a user
 * who claimed a coupon earlier on the cutover date must keep seeing their
 * coupon for the rest of that Bangkok day, even though the server has already
 * switched to point mode. They must not be shown "you received 1 point",
 * because they did not.
 */
export function resolveDailyCheckinCardState(params: {
  isLoading: boolean;
  isError: boolean;
  status: DailyCheckinStatusView | null | undefined;
}): DailyCheckinCardState {
  const { isLoading, isError, status } = params;

  if (isLoading) return { state: "loading" };
  if (isError) return { state: "error" };
  if (!status || status.authenticated === false) return { state: "anonymous" };

  const rewards = status.rewards ?? [];

  if (status.checkedInToday) {
    const points = rewards.find((r) => r.kind === "points");
    if (points) return { state: "claimed_points", reward: points };

    const coupon = rewards.find((r) => r.kind === "coupon");
    if (coupon) return { state: "claimed_coupon", reward: coupon };

    // Checked in, but the reward could not be read. Showing nothing is
    // better than inventing a reward the user may not have.
    return { state: "hidden" };
  }

  // Nothing claimed yet and claiming is switched off - a button that cannot
  // do anything is worse than no card at all.
  if (!status.campaignActive) return { state: "hidden" };

  return status.rewardMode === "points" ? { state: "claimable_points" } : { state: "claimable_coupon" };
}

/** Trims a decimal string for display: "1.00" -> "1", "12.50" -> "12.5". */
export function formatPointsForDisplay(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "0";
  return String(Number(amount.toFixed(2)));
}

/** Human-readable coupon discount label; never used for a point reward. */
export function formatCouponDiscountLabel(
  reward: Extract<DailyCheckinRewardView, { kind: "coupon" }>,
  language: string
): string {
  if (reward.discountType === "percentage") {
    const cap = reward.maxDiscountAmount
      ? ` (${language === "th" ? "สูงสุด" : "max"} ฿${Number(reward.maxDiscountAmount).toFixed(0)})`
      : "";
    return `${Number(reward.discountValue)}%${cap}`;
  }
  return `฿${Number(reward.discountValue).toFixed(0)}`;
}
