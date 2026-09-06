import { trpc } from "@/lib/trpc";
import { QR_PAYMENT_IMAGE } from "@/constants/payment";
import { qrAmountSatang, type PaymentQrRequest, type PaymentQrResult } from "@shared/paymentQr";
import React, { useState } from "react";

export const paymentQrQueryOptions = {
  staleTime: 0, refetchInterval: 15_000, refetchOnWindowFocus: "always" as const,
  refetchOnMount: "always" as const, retry: false as const,
};
export function PaymentQrView({ data, expectedAmount, loading, failed, retry }: {
  data?: PaymentQrResult; expectedAmount: string; loading: boolean; failed: boolean; retry: () => void;
}) {
  const [brokenImage, setBrokenImage] = useState<string | null>(null);
  let mismatch = false;
  try { mismatch = !!data?.amount && qrAmountSatang(data.amount) !== qrAmountSatang(expectedAmount); } catch { mismatch = true; }
  // An error must suppress React Query's retained data, including an old QR.
  if (failed || data?.error === "GENERATOR_UNAVAILABLE") return (
    <div role="alert" className="space-y-2 text-center text-sm text-amber-800">
      <p>QR รับเงินไม่พร้อมใช้งาน กรุณาลองใหม่หรือติดต่อแอดมิน</p>
      <button type="button" className="underline" onClick={retry}>ลองโหลด QR ใหม่</button>
    </div>
  );
  if (loading || !data) return <p role="status" className="text-center text-sm">กำลังโหลด QR รับเงิน...</p>;
  if (mismatch) return <p role="alert" className="text-center text-sm text-amber-800">ยอดชำระเปลี่ยนแล้ว กรุณาโหลดหน้าชำระเงินใหม่ก่อนโอน</p>;
  if (data.error === "NO_AMOUNT") return <p className="text-center text-sm">ไม่มียอดที่ต้องโอน</p>;
  const src = data.imageUrl || (data.mode === "static" ? QR_PAYMENT_IMAGE : "");
  if (!src || brokenImage === src) return <p role="alert" className="text-center text-sm">ไม่สามารถแสดงรูป QR ได้ กรุณาติดต่อแอดมิน</p>;
  return (
    <div className="space-y-3 text-center">
      <img src={src} alt="QR รับเงิน" className="w-full max-w-sm max-h-[32rem] object-contain mx-auto rounded bg-white"
        onError={() => setBrokenImage(src)} />
      <p className="font-semibold">ยอดชำระ {data.amount} บาท</p>
      <p className="text-sm text-slate-600">
        {data.mode === "static" ? "QR รูปเดิม: กรุณากรอกยอด " + data.amount + " บาทในแอปธนาคาร"
          : "ตรวจสอบชื่อผู้รับและยอดเงินในแอปธนาคารก่อนยืนยัน"}
      </p>
    </div>
  );
}
export function PaymentQr({ request, expectedAmount }: { request: PaymentQrRequest; expectedAmount: string }) {
  const query = trpc.paymentQr.get.useQuery(request, paymentQrQueryOptions);
  return <PaymentQrView data={query.data} expectedAmount={expectedAmount} loading={query.isLoading}
    failed={query.isError} retry={() => { void query.refetch(); }} />;
}
