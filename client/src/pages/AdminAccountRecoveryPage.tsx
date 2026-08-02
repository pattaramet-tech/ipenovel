import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { useState } from "react";

function formatDate(date: Date | string | undefined | null): string {
  if (!date) return "-";
  try {
    return new Date(date).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

/**
 * /admin/account-recovery - the pending queue for the Admin Account
 * Recovery workflow. Deliberately lists ONLY pending requests (see
 * server's accountRecovery.admin.list) - approved/rejected/blocked/
 * cancelled requests are history, not a queue to work through, and aren't
 * shown here to keep this page's purpose narrow. Every row links to
 * /admin/account-recovery/:requestId for the actual review/approve flow.
 */
export default function AdminAccountRecoveryPage() {
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const { data, isLoading } = trpc.accountRecovery.admin.list.useQuery({ page, pageSize: 20 });

  return (
    <AdminLayout>
      <div className="space-y-4">
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-1">คำขอกู้คืนบัญชี (รอตรวจสอบ)</h2>
          <p className="text-xs text-muted-foreground mb-4">
            ผู้ใช้ที่เข้าสู่ระบบด้วย Google แล้วอีเมลไม่ตรงกับบัญชีเดิม สามารถส่งคำขอให้ย้ายการเชื่อมต่อ Google กลับไปยังบัญชีเดิมได้ที่นี่
          </p>

          {isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          )}

          {!isLoading && (data?.requests.length ?? 0) === 0 && (
            <p className="text-muted-foreground text-sm py-4">ไม่มีคำขอที่รอตรวจสอบ</p>
          )}

          {!isLoading && (data?.requests.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left py-2 px-3">ID</th>
                    <th className="text-left py-2 px-3">Requester User ID</th>
                    <th className="text-left py-2 px-3">User ID เดิมที่อ้างสิทธิ์</th>
                    <th className="text-left py-2 px-3">อีเมลเดิมที่อ้างสิทธิ์</th>
                    <th className="text-left py-2 px-3">ส่งเมื่อ</th>
                    <th className="text-left py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {data?.requests.map((r: any) => (
                    <tr key={r.id} className="border-b hover:bg-slate-50">
                      <td className="py-2 px-3">#{r.id}</td>
                      <td className="py-2 px-3">{r.requesterUserId}</td>
                      <td className="py-2 px-3">{r.requestedLegacyUserId ?? "-"}</td>
                      <td className="py-2 px-3">{r.claimedLegacyEmail ?? "-"}</td>
                      <td className="py-2 px-3">{formatDate(r.createdAt)}</td>
                      <td className="py-2 px-3">
                        <Button size="sm" onClick={() => navigate(`/admin/account-recovery/${r.id}`)}>
                          ตรวจสอบ
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-4">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ก่อนหน้า
              </Button>
              <span className="text-sm text-muted-foreground">
                หน้า {data.page} / {data.totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
                ถัดไป
              </Button>
            </div>
          )}
        </Card>
      </div>
    </AdminLayout>
  );
}
