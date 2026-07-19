import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getLoginUrl } from "@/const";
import { useLanguage } from "@/contexts/LanguageContext";

function formatExpiryDate(value: string | Date | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Daily check-in reward card. Server is the sole source of truth for
 * whether today's check-in is available (Asia/Bangkok business date) and
 * for the reward summary - this component never computes a discount or a
 * "today" date itself. See docs/DAILY_CHECKIN_COUPON.md.
 *
 * Mounted on ProfilePage only (see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md
 * PART C) - ProfilePage already gates its whole authenticated body behind
 * `if (!user) return <login card>;`, so this component's own query is never
 * fired for a signed-out visitor as a side effect of that placement. This
 * component still handles `authenticated: false` defensively in case it is
 * ever reused elsewhere.
 *
 * Error states never render `error.message` (or any other server-provided
 * detail) - always a fixed, translated, generic string. The server has
 * already been fixed to never leak SQL/DB details in the first place (see
 * server/routers.ts's dailyCheckin.getStatus/claim), but this is a second,
 * independent layer: even if a future server change ever regressed that,
 * this component would still never echo it to the page.
 *
 * The claim button disables itself immediately on click (isPending) purely
 * as a UX nicety against double-clicks - the actual "never issue two
 * coupons" guarantee is entirely server-side (a DB transaction + unique
 * constraint), so a double-fired request here is harmless, not just
 * prevented.
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
    onSuccess: (result) => {
      utils.dailyCheckin.getStatus.invalidate();
      if (result.claimed) {
        toast.success(t("checkin.alreadyCheckedIn"));
      } else if (result.alreadyClaimed) {
        toast.info(t("checkin.alreadyCheckedIn"));
      }
      // A disabled-campaign result (claimed: false, alreadyClaimed: false)
      // intentionally shows no toast - there is nothing actionable to tell
      // the user, and the card itself just stops offering the button (see
      // the campaignActive branch below).
    },
    onError: () => {
      // Never surface err.message - same rule as the query error state below.
      toast.error(t("checkin.error"));
    },
  });

  if (isLoading) {
    return (
      <div className="mb-8">
        <Skeleton className="h-24 sm:h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-slate-600">{t("checkin.error")}</p>
        <Button variant="outline" onClick={() => refetch()}>
          {t("checkin.retry")}
        </Button>
      </Card>
    );
  }

  if (!status || status.authenticated === false) {
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

  // Campaign disabled and nothing already issued today - nothing actionable
  // to show (a button that can't do anything is worse than no button).
  if (!status.campaignActive && !status.checkedInToday) {
    return null;
  }

  if (status.checkedInToday && status.reward) {
    const discountLabel =
      status.reward.discountType === "percentage"
        ? `${Number(status.reward.discountValue)}%${
            status.reward.maxDiscountAmount ? ` (${language === "th" ? "สูงสุด" : "max"} ฿${Number(status.reward.maxDiscountAmount).toFixed(0)})` : ""
          }`
        : `฿${Number(status.reward.discountValue).toFixed(0)}`;

    return (
      <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-green-50 to-emerald-50 border-green-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold text-slate-900">
              {t("checkin.alreadyCheckedIn")} · {discountLabel}
            </p>
            <p className="text-sm text-slate-600">
              {t("checkin.couponCode")} <span className="font-mono font-semibold">{status.reward.couponCode}</span>
              {status.reward.expiresAt && ` · ${t("checkin.expires")} ${formatExpiryDate(status.reward.expiresAt, locale)}`}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-8 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
      <div className="flex items-center gap-3 text-center sm:text-left">
        <Gift className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold text-slate-900">{t("checkin.title")}</p>
          <p className="text-sm text-slate-600">{t("checkin.description")}</p>
        </div>
      </div>
      <Button
        className="rounded-full w-full sm:w-auto"
        disabled={claimMutation.isPending}
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
