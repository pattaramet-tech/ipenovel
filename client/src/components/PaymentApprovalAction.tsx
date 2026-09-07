import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";

export function PaymentApprovalAction({ paymentId, onApproved }: { paymentId: number; onApproved: () => void }) {
 const [open, setOpen] = useState(false);
 const [reason, setReason] = useState("");
 const [confirmed, setConfirmed] = useState(false);
 const info = trpc.admin.payments.duplicateInfo.useQuery({paymentId});
 const approve = trpc.admin.payments.approve.useMutation({
  onSuccess: () => { setOpen(false); setReason(""); setConfirmed(false); void info.refetch(); onApproved(); toast.success("อนุมัติแล้ว"); },
  onError: (error) => { toast.error(error.message); setConfirmed(false); void info.refetch(); }
 });
 const duplicates = info.data?.duplicates ?? [];
 const records = <ul>{duplicates.map((r: any) => <li key={r.subjectType+":"+r.subjectId}>
  <a className="underline" target="_blank" rel="noreferrer" href={r.subjectType === "order" ? "/admin/orders/"+r.orderId : "/admin/wallet-topups/"+r.subjectId}>{r.label}</a>
  {" — "+r.status+" — "+r.amount+" บาท"}
  {r.approvedAt ? " — "+new Date(r.approvedAt).toLocaleString("th-TH") : ""}
 </li>)}</ul>;
 if (info.data?.status === "approved") return <span>อนุมัติแล้ว</span>;
 return <div className="space-y-2">
  {!!duplicates.length && <div className="rounded border border-amber-300 p-3 text-sm"><strong>สลิปซ้ำกับรายการที่อนุมัติแล้ว</strong>{records}</div>}
  {info.isError && <Button variant="outline" onClick={()=>void info.refetch()}>โหลดข้อมูลสลิปซ้ำอีกครั้ง</Button>}
  <Button disabled={!info.data || info.isError || info.isFetching || approve.isPending} onClick={()=>{
   if (duplicates.length) { setConfirmed(false); setReason(""); setOpen(true); }
   else approve.mutate({paymentId});
  }}>{duplicates.length ? "อนุมัติกรณีพิเศษ" : "Approve"}</Button>
  <Dialog open={open} onOpenChange={value=>{if(!approve.isPending)setOpen(value);}}>
   <DialogContent><DialogHeader><DialogTitle>ยืนยันอนุมัติกรณีพิเศษ</DialogTitle>
    <DialogDescription>สลิปนี้ถูกใช้แล้ว การยืนยันจะให้สิทธิ์แก่ออเดอร์นี้เพิ่มเติม กรุณาตรวจรายการเดิมและระบุเหตุผล</DialogDescription>
   </DialogHeader><p>รายการที่จะอนุมัติ: {info.data?.orderNumber} — {info.data?.amount} บาท</p>{records}
   <label>เหตุผล (5–1,000 ตัวอักษร)<textarea className="w-full rounded border p-2" maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} /></label>
   <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} /> ตรวจสอบแล้วและยืนยันให้สิทธิ์เพิ่มเติม</label>
   <Button disabled={!confirmed || reason.trim().length<5 || !info.data?.confirmationKey || info.isFetching || info.isError || approve.isPending}
    onClick={()=>approve.mutate({paymentId,duplicateException:{confirmed:true,reason:reason.trim(),confirmationKey:info.data!.confirmationKey!}})}>ยืนยันอนุมัติกรณีพิเศษ</Button>
   </DialogContent>
  </Dialog>
 </div>;
}
