import React, { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export function AdminPaymentQrSettings() {
  const utils = trpc.useUtils();
  const query = trpc.admin.settings.paymentQr.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const [mode, setMode] = useState<"static" | "generated">("static");
  const [staticImageUrl, setStaticImageUrl] = useState("");
  const [merchantTemplate, setMerchantTemplate] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (query.data) {
      setMode(query.data.mode);
      setStaticImageUrl(query.data.staticImageUrl);
      setMerchantTemplate(query.data.merchantTemplate);
    }
  }, [query.data]);
  const update = trpc.admin.settings.paymentQr.update.useMutation({
    onSuccess: async () => {
      await Promise.all([query.refetch(), utils.paymentQr.get.invalidate()]);
      setReason("");
      toast.success("บันทึกการตั้งค่า QR แล้ว หน้าชำระเงินจะใช้ค่าล่าสุดเมื่อโหลดข้อมูลใหม่");
    },
    onError: error => { toast.error(error.message); },
  });
  const save = (emergency: boolean) => {
    if (!query.data) return;
    update.mutate(emergency
      ? { mode: "static", expectedRevision: query.data.revision, reason: "สลับกลับ QR เดิมจากปุ่มกู้คืน" }
      : { mode, staticImageUrl, merchantTemplate, reason, expectedRevision: query.data.revision });
  };
  return (
    <Card className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">การชำระเงิน — QR รับเงิน</h2>
      <p className="text-sm text-slate-600">เลือก QR ระบุยอด หรือ QR รูปเดิม เปลี่ยนได้โดยไม่ต้อง Restart หรือ Redeploy</p>
      {query.isLoading && <p role="status">กำลังโหลดการตั้งค่า...</p>}
      {query.isError && <p role="alert" className="text-red-700">อ่านการตั้งค่าไม่สำเร็จ</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!query.data || update.isPending} onClick={() => save(true)}>
          ใช้ QR เดิมทันที
        </Button>
        <Button type="button" variant="outline" disabled={update.isPending} onClick={() => { void query.refetch(); }}>โหลดค่าล่าสุด</Button>
      </div>
      <p className="text-xs text-slate-600">ปุ่มใช้ QR เดิมทำงานได้แม้ตัวเจนเสีย โดยไม่ต้องแก้ต้นแบบ QR ก่อน</p>
      <div>
        <Label htmlFor="payment-qr-mode">รูปแบบ QR</Label>
        <select id="payment-qr-mode" className="w-full border rounded p-2 bg-background" value={mode}
          onChange={e => setMode(e.target.value as "static" | "generated")}>
          <option value="static">QR รูปเดิม — ลูกค้ากรอกยอดเอง</option>
          <option value="generated">QR ระบุยอด — ใช้ตัวเจน</option>
        </select>
      </div>
      <div>
        <Label htmlFor="payment-qr-image">ลิงก์รูป QR เดิม (HTTPS)</Label>
        <Input id="payment-qr-image" value={staticImageUrl} onChange={e => setStaticImageUrl(e.target.value)} placeholder="เว้นว่างเพื่อใช้รูป QR เดิมของเว็บไซต์" />
      </div>
      <div>
        <Label htmlFor="payment-qr-template">ข้อความต้นแบบ QR ร้านค้า</Label>
        <Textarea id="payment-qr-template" rows={3} value={merchantTemplate} onChange={e => setMerchantTemplate(e.target.value)} />
        <p className="text-xs text-slate-600">ใช้ข้อความที่ถอดจาก QR ร้านค้าซึ่งตรวจสอบผู้รับแล้ว ต้องตั้งค่าก่อนเปิด QR ระบุยอด</p>
      </div>
      <div>
        <Label htmlFor="payment-qr-reason">เหตุผลที่เปลี่ยน</Label>
        <Input id="payment-qr-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={300} />
      </div>
      <Button type="button" disabled={!query.data || query.isError || update.isPending || !reason.trim()} onClick={() => save(false)}>
        {update.isPending ? "กำลังบันทึก..." : "บันทึก QR รับเงิน"}
      </Button>
      {query.data?.updatedAt && <p className="text-xs text-slate-500">แก้ไขล่าสุด: {new Date(query.data.updatedAt).toLocaleString("th-TH")} · แอดมิน #{query.data.updatedBy}</p>}
    </Card>
  );
}
