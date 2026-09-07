import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { validReceiver, type ReceiverConfig } from "../../../shared/paymentReceiver";

export function AdminPaymentReceiverSettings() {
  const query = trpc.admin.settings.paymentReceiver.get.useQuery();
  const update = trpc.admin.settings.paymentReceiver.update.useMutation();
  const [draft, setDraft] = useState<ReceiverConfig | null>(null);
  const [reason, setReason] = useState("");
  const current = draft ?? query.data;
  const busy = update.isPending || query.isFetching;
  async function save() {
    if (!current) return;
    try {
      const saved = await update.mutateAsync({ accountType: current.accountType, accountNumber: current.accountNumber,
        expectedRevision: current.revision, reason });
      setDraft(saved); setReason(""); await query.refetch();
      toast.success("บันทึกผู้รับสำหรับตรวจสลิปแล้ว");
    } catch (e: any) { toast.error(e.message || "บันทึกไม่สำเร็จ"); }
  }
  return <Card className="p-6 space-y-4">
    <h2 className="text-xl font-semibold">การชำระเงิน — ผู้รับสำหรับตรวจสลิป API</h2>
    <p>ตั้งบัญชีหรือรหัสร้านที่ต้องรับเงินจริง ใช้ตรวจทั้งคำสั่งซื้อและเติมเงิน มีผลกับการตรวจครั้งถัดไป การตั้ง QR รับเงินแยกจากส่วนนี้</p>
    <Button variant="outline" disabled={busy} onClick={async () => {
      const result = await query.refetch(); if (result.data) { setDraft(result.data); setReason(""); }
    }}>โหลดค่าล่าสุด</Button>
    {query.error && <p role="alert">{query.error.message}</p>}
    {current && <>
      <label className="block" htmlFor="receiver-type">ประเภทผู้รับ (KSHOP ใช้ 03000)</label>
      <Input id="receiver-type" value={current.accountType} maxLength={5} disabled={busy}
        onChange={e => setDraft({ ...current, accountType: e.target.value })} placeholder="03000" />
      <label className="block" htmlFor="receiver-number">รหัสร้าน / เลขบัญชีผู้รับ</label>
      <Input id="receiver-number" value={current.accountNumber} maxLength={32} disabled={busy}
        onChange={e => setDraft({ ...current, accountNumber: e.target.value })} />
      <p className="text-sm">KSHOP: ใช้รหัสร้านจาก QR ต้นฉบับ ไม่ใช่เลขบัญชีผู้โอนหรือข้อความ QR ทั้งบรรทัด บัญชีธนาคารทั่วไปใช้รหัสประเภทจากคู่มือผู้ให้บริการและเลขบัญชีตัวเลข</p>
      <label className="block" htmlFor="receiver-reason">เหตุผลที่เปลี่ยน</label>
      <Input id="receiver-reason" value={reason} maxLength={300} disabled={busy} onChange={e => setReason(e.target.value)} />
      <Button onClick={save} disabled={busy || !!query.error || !reason.trim() || !validReceiver(current.accountType.trim(), current.accountNumber.trim())}>
        บันทึกผู้รับสำหรับตรวจสลิป
      </Button>
      <p className="text-sm">การบันทึกไม่อนุมัติรายการเดิม และไม่เปิดอนุมัติอัตโนมัติ</p>
    </>}
  </Card>;
}
