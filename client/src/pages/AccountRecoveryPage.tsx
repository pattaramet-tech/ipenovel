import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

const STATUS_LABELS: Record<string, string> = {
  pending: "รอตรวจสอบ",
  approved: "อนุมัติแล้ว",
  rejected: "ถูกปฏิเสธ",
  blocked: "ระงับ (ต้องติดต่อฝ่ายช่วยเหลือ)",
  cancelled: "ยกเลิกแล้ว",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  blocked: "bg-red-100 text-red-800",
  cancelled: "bg-slate-100 text-slate-600",
};

function formatDate(date: Date | string | undefined | null): string {
  if (!date) return "-";
  try {
    return new Date(date).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

/**
 * /account/recovery - the user-facing side of the Admin Account Recovery
 * workflow (see server/services/accountRecoveryService.ts for the full
 * spec). Only reachable by a signed-in user whose CURRENT session already
 * has a real, connected Google identity - the server enforces this itself
 * (accountRecovery.create throws NOT_GOOGLE_LINKED otherwise); this page
 * never lets someone type an arbitrary Google email and have that alone
 * treated as proof of anything.
 */
export default function AccountRecoveryPage() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login", { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate]);

  const requestsQuery = trpc.accountRecovery.myRequests.useQuery(undefined, { enabled: isAuthenticated });
  const utils = trpc.useUtils();

  const [requestedLegacyUserId, setRequestedLegacyUserId] = useState("");
  const [claimedLegacyEmail, setClaimedLegacyEmail] = useState("");
  const [claimedLegacyOpenId, setClaimedLegacyOpenId] = useState("");
  const [claimedDisplayName, setClaimedDisplayName] = useState("");
  const [referenceOrderNumber, setReferenceOrderNumber] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");

  const createMutation = trpc.accountRecovery.create.useMutation({
    onSuccess: () => {
      toast.success("ส่งคำขอกู้คืนบัญชีเรียบร้อยแล้ว ทีมงานจะตรวจสอบโดยเร็วที่สุด");
      setRequestedLegacyUserId("");
      setClaimedLegacyEmail("");
      setClaimedLegacyOpenId("");
      setClaimedDisplayName("");
      setReferenceOrderNumber("");
      setEvidenceNote("");
      utils.accountRecovery.myRequests.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "ไม่สามารถส่งคำขอได้ กรุณาลองใหม่อีกครั้ง");
    },
  });

  const cancelMutation = trpc.accountRecovery.cancel.useMutation({
    onSuccess: () => {
      toast.success("ยกเลิกคำขอแล้ว");
      utils.accountRecovery.myRequests.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "ไม่สามารถยกเลิกคำขอได้");
    },
  });

  if (authLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" aria-hidden="true" />
      </div>
    );
  }

  const requests = requestsQuery.data ?? [];
  const pendingRequest = requests.find((r: any) => r.status === "pending");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      requestedLegacyUserId: requestedLegacyUserId.trim() ? Number(requestedLegacyUserId.trim()) : undefined,
      claimedLegacyEmail: claimedLegacyEmail.trim() || undefined,
      claimedLegacyOpenId: claimedLegacyOpenId.trim() || undefined,
      claimedDisplayName: claimedDisplayName.trim() || undefined,
      referenceOrderNumber: referenceOrderNumber.trim() || undefined,
      evidenceNote: evidenceNote.trim() || undefined,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="max-w-2xl mx-auto space-y-6">
        <Card className="p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-3">กู้คืนบัญชีเดิม</h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            หากอีเมล Google ที่คุณใช้เข้าสู่ระบบไม่ตรงกับบัญชี IpeNovel เดิมของคุณ ระบบอาจสร้างบัญชีใหม่ให้แทนที่จะเข้าสู่บัญชีเดิม
            กรุณากรอกข้อมูลด้านล่างเพื่อให้ทีมงานตรวจสอบและย้ายการเชื่อมต่อ Google กลับไปยังบัญชีเดิมของคุณ
          </p>

          {requestsQuery.isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          )}

          {!requestsQuery.isLoading && pendingRequest && (
            <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />
                <p className="font-medium text-amber-900">คุณมีคำขอที่รอตรวจสอบอยู่แล้ว</p>
              </div>
              <p className="text-sm text-amber-800">
                ส่งเมื่อ {formatDate(pendingRequest.createdAt)} - ทีมงานจะตรวจสอบและติดต่อกลับโดยเร็วที่สุด
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate({ requestId: pendingRequest.id })}
              >
                {cancelMutation.isPending ? "กำลังยกเลิก..." : "ยกเลิกคำขอนี้"}
              </Button>
            </div>
          )}

          {!requestsQuery.isLoading && !pendingRequest && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="requestedLegacyUserId">User ID บัญชีเดิม (ถ้าทราบ)</Label>
                <Input
                  id="requestedLegacyUserId"
                  type="number"
                  value={requestedLegacyUserId}
                  onChange={(e) => setRequestedLegacyUserId(e.target.value)}
                  placeholder="เช่น 12345"
                />
              </div>
              <div>
                <Label htmlFor="claimedLegacyEmail">อีเมลบัญชีเดิม</Label>
                <Input
                  id="claimedLegacyEmail"
                  type="email"
                  value={claimedLegacyEmail}
                  onChange={(e) => setClaimedLegacyEmail(e.target.value)}
                  placeholder="เช่น old-email@example.com"
                />
              </div>
              <div>
                <Label htmlFor="claimedDisplayName">ชื่อที่แสดงในบัญชีเดิม</Label>
                <Input
                  id="claimedDisplayName"
                  value={claimedDisplayName}
                  onChange={(e) => setClaimedDisplayName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="referenceOrderNumber">เลขที่คำสั่งซื้อ (เพื่อยืนยันตัวตน)</Label>
                <Input
                  id="referenceOrderNumber"
                  value={referenceOrderNumber}
                  onChange={(e) => setReferenceOrderNumber(e.target.value)}
                  placeholder="ถ้ามี จะช่วยให้ตรวจสอบได้เร็วขึ้น"
                />
              </div>
              <div>
                <Label htmlFor="evidenceNote">รายละเอียดเพิ่มเติม</Label>
                <Textarea
                  id="evidenceNote"
                  value={evidenceNote}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                  placeholder="อธิบายเพิ่มเติมเพื่อช่วยให้ทีมงานตรวจสอบได้ง่ายขึ้น"
                  rows={4}
                />
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "กำลังส่งคำขอ..." : "ส่งคำขอกู้คืนบัญชี"}
              </Button>
            </form>
          )}
        </Card>

        {!requestsQuery.isLoading && requests.length > 0 && (
          <Card className="p-6">
            <h2 className="font-semibold text-slate-900 mb-3">ประวัติคำขอ</h2>
            <div className="space-y-2">
              {requests.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between border-b last:border-b-0 py-2 text-sm">
                  <div>
                    <p className="text-slate-700">{formatDate(r.createdAt)}</p>
                    {r.reviewReason && <p className="text-xs text-slate-500 mt-0.5">{r.reviewReason}</p>}
                  </div>
                  <Badge className={STATUS_COLORS[r.status] ?? "bg-slate-100 text-slate-600"}>
                    {STATUS_LABELS[r.status] ?? r.status}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
