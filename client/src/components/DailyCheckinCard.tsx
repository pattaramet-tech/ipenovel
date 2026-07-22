import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, CheckCircle2, Loader2, Coins } from "lucide-react";
import { toast } from "sonner";
import { getLoginUrl } from "@/const";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  resolveDailyCheckinCardState,
  formatPointsForDisplay,
  formatCouponDiscountLabel,
  type DailyCheckinStatusView,
} from "./dailyCheckinPresentation";

function formatExpiryDate(value: string | Date | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Daily check-in reward card. The server is the sole source of truth for
 * whether today's check-in is available (Asia/Bangkok business date), for
 * which reward mode is live, and for the reward itself - this component never
 * computes a discount, a point amount, or a "today" date. See
 * docs/DAILY_CHECKIN_ONE_POINT_ROLLOUT.md.
 *
 * Two reward kinds are rendered from the server's explicitly discriminated
 * `rewards[]` array:
 *   - kind "coupon" - the legacy reward; shows its code and expiry.
 *   - kind "points" - the 1-point reward; shows the amount and the new
 *     balance, and deliberately NEVER renders a coupon code (there is none).
 * All state selection lives in ./dailyCheckinPresentation.ts so it can be
 * unit-tested without a DOM harness.
 *
 * Mounted on ProfilePage only. ProfilePage already gates its whole
 * authenticated body behind `if (!user) return <login card>;`, so this
 * component's query is never fired for a signed-out visitor as a side effect
 * of that placement. It still handles `authenticated: false` defensively in
 * case it is ever reused elsewhere.
 *
 * Error states never render `error.message` (or any other server-provided
 * detail) - always a fixed, translated, generic string. The server already
 * never leaks SQL/DB details (see server/routers.ts dailyCheckin.*), but this
 * is a second, independent layer.
 *
 * The claim button disables itself immediately on click (isPending) as a UX
 * nicety against double-clicks - the actual "never reward twice" guarantee is
 * entirely server-side (one transaction + UNIQUE(userId, checkinDate,
 * campaignKey)), so a double-fired request is harmless, not merely prevented.
 */
export default function DailyCheckinCard() {
  const { t, language } = useLanguage();
  const locale = language === "th" ? "th-TH" : "en-US";
  const utils = trpc.useUtils();
  const {
    data: status,
    isLoading,
    isError,
    refetch,
  } = trpc.dailyCheckin.getStatus.useQuery(undefined, {
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const claimMutation = trpc.dailyCheckin.claim.useMutation({
    onSuccess: (result: any) => {
      utils.dailyCheckin.getStatus.invalidate();
      const pointsReward = (result?.rewards ?? []).find((r: any) => r.kind === "points");

      if (result.claimed && pointsReward) {
        toast.success(
          `${t("checkin.pointsClaimSuccess")} ${t("checkin.pointsEarned").replace(
            "{amount}",
            formatPointsForDisplay(pointsReward.pointsAmount)
          )}`
        );
      } else if (result.claimed) {
        toast.success(t("checkin.alreadyCheckedIn"));
      } else if (result.alreadyClaimed) {
        toast.info(t("checkin.alreadyCheckedIn"));
      }
      // A disabled-campaign result (claimed: false, alreadyClaimed: false)
      // intentionally shows no toast - there is nothing actionable to say,
      // and the card itself stops offering the button.
    },
    onError: () => {
      // Never surface err.message - same rule as the query error state below.
      toast.error(t("checkin.error"));
    },
  });

  const view = resolveDailyCheckinCardState({
    isLoading,
    isError,
    status: status as DailyCheckinStatusView | undefined,
  });

  if (view.state === "loading") {
    return (
      <div className="mb-8">
        <Skeleton className="h-24 sm:h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (view.state === "error") {
    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-slate-600">{t("checkin.error")}</p>
        <Button variant="outline" onClick={() => refetch()}>
          {t("checkin.retry")}
        </Button>
      </Card>
    );
  }

  if (view.state === "anonymous") {
    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <Gift className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold text-slate-900">{t("checkin.title")}</p>
            <p className="text-sm text-slate-600">{t("checkin.loginPrompt")}</p>
          </div>
        </div>
        <Button asChild className="rounded-full w-full sm:w-auto">
          <a href={getLoginUrl()}>{t("nav.login")}</a>
        </Button>
      </Card>
    );
  }

  if (view.state === "hidden") {
    return null;
  }

  // Already checked in today with a POINT reward. No coupon code exists and
  // none is rendered.
  if (view.state === "claimed_points") {
    const amount = formatPointsForDisplay(view.reward.pointsAmount);
    // The CURRENT balance, not the reward's historical balanceAfterGrant
    // snapshot - a user who earned this point and later spent it must see
    // their real current balance here, not the stale grant-time value.
    const balance = formatPointsForDisplay(view.pointsBalance);
    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-green-50 to-emerald-50 border-green-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <Coins className="w-8 h-8 text-green-600 flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">{t("checkin.alreadyCheckedIn")}</p>
            <p className="text-sm text-slate-600 break-words">
              {t("checkin.pointsEarned").replace("{amount}", amount)}
              {" · "}
              {t("checkin.pointsBalance").replace("{balance}", balance)}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  // Already checked in today with a legacy COUPON reward - including a user
  // who claimed a coupon earlier on the cutover date. They keep seeing their
  // coupon and are never told they received a point.
  if (view.state === "claimed_coupon") {
    const discountLabel = formatCouponDiscountLabel(view.reward, language);
    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-green-50 to-emerald-50 border-green-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">
              {t("checkin.alreadyCheckedIn")} · {discountLabel}
            </p>
            <p className="text-sm text-slate-600 break-words">
              {t("checkin.couponCode")}{" "}
              <span className="font-mono font-semibold">{view.reward.couponCode}</span>
              {view.reward.expiresAt &&
                ` · ${t("checkin.expires")} ${formatExpiryDate(view.reward.expiresAt, locale)}`}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const isPointsMode = view.state === "claimable_points";

  return (
    <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
      <div className="flex items-center gap-3 text-center sm:text-left">
        {isPointsMode ? (
          <Coins className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
        ) : (
          <Gift className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">{t("checkin.title")}</p>
          <p className="text-sm text-slate-600 break-words">
            {isPointsMode ? t("checkin.pointsDescription") : t("checkin.description")}
          </p>
        </div>
      </div>
      <Button
        className="rounded-full w-full sm:w-auto"
        disabled={claimMutation.isPending}
        aria-label={isPointsMode ? t("checkin.pointsClaimAriaLabel") : t("checkin.claimButton")}
        onClick={() => claimMutation.mutate()}
      >
        {claimMutation.isPending ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
            {t("checkin.claiming")}
          </>
        ) : (
          t("checkin.claimButton")
        )}
      </Button>
    </Card>
  );
}
