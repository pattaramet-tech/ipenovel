import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getLoginUrl } from "@/const";

function formatThaiDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Daily check-in reward card. Server is the sole source of truth for
 * whether today's check-in is available (Asia/Bangkok business date) and
 * for the reward summary - this component never computes a discount or a
 * "today" date itself. See docs/DAILY_CHECKIN_COUPON.md.
 *
 * The claim button disables itself immediately on click (isPending) purely
 * as a UX nicety against double-clicks - the actual "never issue two
 * coupons" guarantee is entirely server-side (a DB transaction + unique
 * constraint), so a double-fired request here is harmless, not just
 * prevented.
 */
export default function DailyCheckinCard() {
  const utils = trpc.useUtils();
  const {
    data: status,
    isLoading,
    isError,
    error,
    refetch,
  } = trpc.dailyCheckin.getStatus.useQuery(undefined, {
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const claimMutation = trpc.dailyCheckin.claim.useMutation({
    onSuccess: (result) => {
      utils.dailyCheckin.getStatus.invalidate();
      if (result.claimed) {
        toast.success("เช็กอินสำเร็จ! ได้รับคูปองส่วนลดแล้ว");
      } else if (result.alreadyClaimed) {
        toast.info("คุณเช็กอินวันนี้ไปแล้ว");
      } else {
        toast.error("ระบบเช็กอินปิดใช้งานชั่วคราว");
      }
    },
    onError: (err: any) => {
      toast.error(err?.message || "เช็กอินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    },
  });

  if (isLoading) {
    return (
      <div className="mb-12 sm:mb-16 md:mb-20">
        <Skeleton className="h-24 sm:h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="mb-12 sm:mb-16 md:mb-20 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-slate-600">
          โหลดข้อมูลเช็กอินไม่สำเร็จ{error?.message ? `: ${error.message}` : ""}
        </p>
        <Button variant="outline" onClick={() => refetch()}>
          ลองใหม่อีกครั้ง
        </Button>
      </Card>
    );
  }

  if (!status || status.authenticated === false) {
    return (
      <Card className="mb-12 sm:mb-16 md:mb-20 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <Gift className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold text-slate-900">เช็กอินรายวัน รับคูปองส่วนลดฟรี!</p>
            <p className="text-sm text-slate-600">เข้าสู่ระบบเพื่อรับคูปองส่วนลดทุกวัน</p>
          </div>
        </div>
        <Button asChild className="rounded-full w-full sm:w-auto">
          <a href={getLoginUrl()}>เข้าสู่ระบบ</a>
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
        ? `ส่วนลด ${Number(status.reward.discountValue)}%${
            status.reward.maxDiscountAmount ? ` (สูงสุด ฿${Number(status.reward.maxDiscountAmount).toFixed(0)})` : ""
          }`
        : `ส่วนลด ฿${Number(status.reward.discountValue).toFixed(0)}`;

    return (
      <Card className="mb-12 sm:mb-16 md:mb-20 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-green-50 to-emerald-50 border-green-100">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold text-slate-900">เช็กอินวันนี้แล้ว ได้รับคูปอง {discountLabel}</p>
            <p className="text-sm text-slate-600">
              รหัสคูปอง <span className="font-mono font-semibold">{status.reward.couponCode}</span>
              {status.reward.expiresAt && ` · หมดอายุ ${formatThaiDate(status.reward.expiresAt)}`}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-12 sm:mb-16 md:mb-20 p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-purple-50 border-blue-100">
      <div className="flex items-center gap-3 text-center sm:text-left">
        <Gift className="w-8 h-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold text-slate-900">เช็กอินวันนี้ รับคูปองส่วนลดฟรี!</p>
          <p className="text-sm text-slate-600">เช็กอินได้วันละ 1 ครั้ง</p>
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
            กำลังเช็กอิน...
          </>
        ) : (
          "เช็กอินรับคูปอง"
        )}
      </Button>
    </Card>
  );
}
