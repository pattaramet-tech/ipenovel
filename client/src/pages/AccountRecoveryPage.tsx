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
import { Loader2, AlertTriangle, CheckCircle2, LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { deriveAccountRecoveryViewState } from "./accountRecoveryPresentation";
import { shouldShowGoogleConnectSection } from "./profileGoogleConnectStatus";

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
 * spec). Reachable by any signed-in user, connected to Google or not - the
 * SUBMISSION form is still only ever offered once this session's own
 * `auth.googleConnectionCutoffStatus.googleConnected` reads true (see
 * accountRecoveryPresentation.ts's deriveAccountRecoveryViewState/
 * showForm), and the server independently re-enforces the same rule itself
 * regardless of what this page decided to show (accountRecovery.create
 * throws NOT_GOOGLE_LINKED otherwise - this page is a UX affordance, never
 * the security boundary). A signed-in visitor who is NOT yet connected and
 * has no existing request instead sees a guidance state pointing at
 * connecting Google / the upgrade-login page - never a broken form they
 * can't actually submit. This page never lets someone type an arbitrary
 * Google email and have that alone treated as proof of anything, and this
 * page's own docstring is never a substitute for the server's own checks.
 */
export default function AccountRecoveryPage() {
  const { isAuthenticated, loading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);

  // After an admin approves a recovery request, the Google identity has
  // moved to the TARGET account - but this browser's CURRENT session
  // cookie still authenticates as the SOURCE user (sessions are tied to
  // users.openId, which recovery never touches - see
  // server/services/accountRecoveryService.ts's finalizeAccountRecoveryTargetUser
  // docstring). The old session must never be silently upgraded/switched
  // to the target account - the only sanctioned way to reach the target
  // account is a fresh Google login, which now resolves to the target
  // because the identity moved. This handler does exactly that and
  // nothing more: end the current (source) session, then send the user to
  // /login to start a brand-new one.
  const handleLogoutAfterApproval = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  };

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login", { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate]);

  const requestsQuery = trpc.accountRecovery.myRequests.useQuery(undefined, { enabled: isAuthenticated });
  // The existing server-authoritative status query (see server/routers.ts's
  // auth.googleConnectionCutoffStatus, and client/src/components/
  // MigrationGate.tsx's identical use) - reused as-is rather than a new
  // endpoint, purely to read `googleConnected` for THIS page's own
  // form-vs-guidance decision (see accountRecoveryPresentation.ts's
  // deriveAccountRecoveryViewState). The server remains the final
  // authority either way - accountRecovery.create still independently
  // rejects a submission from a not-really-connected session with
  // NOT_GOOGLE_LINKED regardless of what this client-side read says.
  const statusQuery = trpc.auth.googleConnectionCutoffStatus.useQuery(undefined, { enabled: isAuthenticated });
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
  const { pendingRequest, mostRecentRequest, justApproved, showForm, showGuidance } = deriveAccountRecoveryViewState(
    requests as any,
    statusQuery.data?.googleConnected
  );
  // Only meaningful once neither the approved-banner nor the pending-status
  // block already claimed the space (see the priority order in this file's
  // render below) - true while the connection status itself hasn't
  // resolved yet, so neither showForm nor showGuidance can be decided.
  const isCheckingGoogleConnection =
    !justApproved && !pendingRequest && !requestsQuery.isLoading && statusQuery.isLoading;

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

          {!requestsQuery.isLoading && justApproved && (
            <div className="border border-green-200 bg-green-50 rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" aria-hidden="true" />
                <p className="font-medium text-green-900">คำขอกู้คืนบัญชีของคุณได้รับการอนุมัติแล้ว</p>
              </div>
              <p className="text-sm text-green-800 leading-relaxed">
                ทีมงานได้ย้ายการเชื่อมต่อ Google ไปยังบัญชีเดิมของคุณเรียบร้อยแล้ว บัญชีที่คุณกำลังใช้งานอยู่ตอนนี้
                <strong> จะไม่เปลี่ยนเป็นบัญชีเดิมโดยอัตโนมัติ</strong> กรุณา
                <strong>ออกจากระบบ แล้วเข้าสู่ระบบใหม่ด้วย Google</strong> อีกครั้งเพื่อเข้าถึงบัญชีเดิมของคุณ
              </p>
              {mostRecentRequest?.reviewReason && (
                <p className="text-xs text-green-700">หมายเหตุจากทีมงาน: {mostRecentRequest.reviewReason}</p>
              )}
              <Button size="lg" className="w-full" disabled={loggingOut} onClick={handleLogoutAfterApproval}>
                {loggingOut ? "กำลังออกจากระบบ..." : "ออกจากระบบ แล้วเข้าสู่ระบบใหม่ด้วย Google"}
              </Button>
            </div>
          )}

          {!requestsQuery.isLoading && !justApproved && pendingRequest && (
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

          {!requestsQuery.isLoading && showForm && (
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

          {isCheckingGoogleConnection && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" aria-hidden="true" />
            </div>
          )}

          {!requestsQuery.isLoading && !isCheckingGoogleConnection && showGuidance && (
            <div className="border border-slate-200 bg-slate-50 rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-2">
                <LifeBuoy className="w-5 h-5 text-slate-500" aria-hidden="true" />
                <p className="font-medium text-slate-900">ยังไม่สามารถส่งคำขอกู้คืนบัญชีได้</p>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                ฟังก์ชันนี้ใช้สำหรับกรณีที่คุณเข้าสู่ระบบด้วย Google แล้วระบบพาเข้าสู่บัญชีใหม่ที่ไม่มีข้อมูลเดิม
                กรุณาเชื่อมบัญชี Google หรือเข้าสู่ระบบด้วย Google ก่อน
              </p>
              <div className="flex flex-col gap-3 pt-1">
                {shouldShowGoogleConnectSection(import.meta.env.VITE_AUTH_PROVIDER) && (
                  <Button asChild size="lg" className="w-full">
                    <a href="/api/auth/google/connect/start">เชื่อมบัญชี Google</a>
                  </Button>
                )}
                <Button variant="outline" size="lg" className="w-full" onClick={() => navigate("/account/upgrade-login")}>
                  กลับไปหน้าอัปเกรดวิธีเข้าสู่ระบบ
                </Button>
              </div>
            </div>
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
