import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
export function AdminProviderAutoApprove() {
 const query = trpc.admin.settings.providerAutoApprove.get.useQuery();
 const update = trpc.admin.settings.providerAutoApprove.update.useMutation();
 const [enabled,setEnabled] = useState<boolean | null>(null);
 const [reason,setReason] = useState("");
 const busy = query.isFetching || update.isPending;
 async function save() {
  if (!query.data) return;
  try {
   await update.mutateAsync({enabled: enabled ?? query.data.enabled, expectedRevision: query.data.revision, reason});
   await query.refetch(); setEnabled(null); setReason(""); toast.success("บันทึกการอนุมัติอัตโนมัติแล้ว");
  } catch(e: any) { toast.error(e.message || "บันทึกไม่สำเร็จ"); }
 }
 return <Card className="p-6 space-y-4">
  <h2 className="text-xl font-semibold">การชำระเงิน — อนุมัติอัตโนมัติผ่าน API</h2>
  <p>ใช้กับคำสั่งซื้อและเติม Wallet เมื่อสลิปตรวจผ่านผู้รับและยอดเงิน ไม่อนุมัติรายการค้างย้อนหลังจากการเปิดสวิตช์</p>
  {query.error && <p role="alert">{query.error.message}</p>}
  {query.data && <label className="flex items-center gap-3">
   <input type="checkbox" checked={enabled ?? query.data.enabled} disabled={busy}
    onChange={e => setEnabled(e.target.checked)} /> เปิด Auto Approve
  </label>}
  <label htmlFor="auto-reason" className="block">เหตุผลที่เปลี่ยน</label>
  <Input id="auto-reason" value={reason} maxLength={300} disabled={busy} onChange={e=>setReason(e.target.value)} />
  <Button disabled={busy || !!query.error || !query.data || !reason.trim()} onClick={save}>บันทึกการอนุมัติอัตโนมัติ</Button>
  <Button variant="outline" disabled={busy} onClick={async()=>{await query.refetch();setEnabled(null);}}>โหลดค่าล่าสุด</Button>
  <p className="text-sm">มีผลกับการประมวลผลครั้งถัดไป ไม่ต้อง Restart หรือ Redeploy</p>
  {query.data?.updatedAt && <p className="text-sm">แก้ไขล่าสุด: {query.data.updatedAt} · แอดมิน #{query.data.updatedBy}</p>}
 </Card>;
}
