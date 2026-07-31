import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Loader2, ArrowLeft, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

function formatDate(date: Date | string | undefined | null): string {
  if (!date) return "-";
  try {
    return new Date(date).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

/**
 * /admin/account-recovery/:requestId - review + resolve ONE recovery
 * request. Every mutation here (approve/reject/block) requires a reason;
 * approve additionally requires the admin to TYPE the target user id into
 * the confirmation modal - see server/services/accountRecoveryService.ts's
 * executeAccountRecovery for what actually happens once confirmed (a
 * single locked transaction, re-checking every safety rule against the
 * final locked snapshot - never trusting whatever this page showed a
 * moment earlier).
 */
export default function AdminAccountRecoveryDetailPage() {
  const [, params] = useRoute("/admin/account-recovery/:requestId");
  const [, navigate] = useLocation();
  const requestId = params?.requestId ? parseInt(params.requestId, 10) : undefined;
  const utils = trpc.useUtils();

  const [searchMode, setSearchMode] = useState<"id" | "email" | "openId">("id");
  const [searchValue, setSearchValue] = useState("");
  const [searchInput, setSearchInput] = useState<{ mode: "id" | "email" | "openId"; value: string } | null>(null);
  const [targetUserId, setTargetUserId] = useState<number | null>(null);

  const [showReasonDialog, setShowReasonDialog] = useState<"reject" | "block" | null>(null);
  const [reasonText, setReasonText] = useState("");

  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approveReason, setApproveReason] = useState("");
  const [approveConfirmTypedId, setApproveConfirmTypedId] = useState("");

  const { data, isLoading } = trpc.accountRecovery.admin.detail.useQuery(
    { requestId: requestId ?? 0 },
    { enabled: Boolean(requestId) }
  );

  const searchQuery = trpc.accountRecovery.admin.searchLegacyAccount.useQuery(searchInput as any, {
    enabled: searchInput !== null,
  });

  const previewQuery = trpc.accountRecovery.admin.previewApproval.useQuery(
    { requestId: requestId ?? 0, targetUserId: targetUserId ?? 0 },
    { enabled: Boolean(requestId) && Boolean(targetUserId) }
  );

  const invalidateAll = () => {
    utils.accountRecovery.admin.detail.invalidate({ requestId });
    utils.accountRecovery.admin.list.invalidate();
  };

  const approveMutation = trpc.accountRecovery.admin.approve.useMutation({
    onSuccess: () => {
      toast.success("อนุมัติคำขอกู้คืนบัญชีเรียบร้อยแล้ว");
      setShowApproveDialog(false);
      invalidateAll();
      navigate("/admin/account-recovery");
    },
    onError: (error) => toast.error(error.message || "ไม่สามารถอนุมัติคำขอได้"),
  });

  const rejectMutation = trpc.accountRecovery.admin.reject.useMutation({
    onSuccess: () => {
      toast.success("ปฏิเสธคำขอแล้ว");
      setShowReasonDialog(null);
      invalidateAll();
      navigate("/admin/account-recovery");
    },
    onError: (error) => toast.error(error.message || "ไม่สามารถปฏิเสธคำขอได้"),
  });

  const blockMutation = trpc.accountRecovery.admin.block.useMutation({
    onSuccess: () => {
      toast.success("ระงับคำขอแล้ว");
      setShowReasonDialog(null);
      invalidateAll();
      navigate("/admin/account-recovery");
    },
    onError: (error) => toast.error(error.message || "ไม่สามารถระงับคำขอได้"),
  });

  if (!requestId) {
    return (
      <AdminLayout>
        <p className="text-muted-foreground">ไม่พบคำขอ</p>
      </AdminLayout>
    );
  }

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout>
        <p className="text-muted-foreground">ไม่พบคำขอ</p>
      </AdminLayout>
    );
  }

  const { request, requester, requesterHasGoogleIdentity, economicDataFindings, userOwnedDataFindings } = data;
  const isPending = request.status === "pending";

  const handleSearch = () => {
    if (!searchValue.trim()) return;
    setSearchInput({ mode: searchMode, value: searchValue.trim() });
  };

  return (
    <AdminLayout>
      <div className="space-y-4 max-w-4xl">
        <Button variant="ghost" size="sm" onClick={() => navigate("/admin/account-recovery")}>
          <ArrowLeft className="w-4 h-4 mr-1" /> กลับไปยังรายการ
        </Button>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">คำขอกู้คืนบัญชี #{request.id}</h2>
            <Badge>{request.status}</Badge>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Requester User ID (source)</p>
              <p className="font-medium">{request.requesterUserId}</p>
            </div>
            <div>
              <p className="text-muted-foreground">มี Google Identity จริงหรือไม่</p>
              <p className="font-medium">{requesterHasGoogleIdentity ? "มี ✓" : "ไม่มี ✗ (ผิดปกติ)"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">อีเมล requester</p>
              <p className="font-medium">{requester?.maskedEmail ?? "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">ส่งเมื่อ</p>
              <p className="font-medium">{formatDate(request.createdAt)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">User ID เดิมที่อ้างสิทธิ์</p>
              <p className="font-medium">{request.requestedLegacyUserId ?? "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">อีเมลเดิมที่อ้างสิทธิ์</p>
              <p className="font-medium">{request.claimedLegacyEmail ?? "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">ชื่อเดิมที่อ้างสิทธิ์</p>
              <p className="font-medium">{request.claimedDisplayName ?? "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">เลขที่คำสั่งซื้ออ้างอิง</p>
              <p className="font-medium">{request.referenceOrderNumber ?? "-"}</p>
            </div>
          </div>
          {request.evidenceNote && (
            <div className="mt-3">
              <p className="text-muted-foreground text-sm">รายละเอียดเพิ่มเติมจากผู้ใช้</p>
              <p className="text-sm mt-1 whitespace-pre-wrap">{request.evidenceNote}</p>
            </div>
          )}

          {economicDataFindings.length > 0 && (
            <div className="mt-4 border border-red-200 bg-red-50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-red-800 font-medium">
                <AlertTriangle className="w-4 h-4" /> พบข้อมูลทางการเงิน/สิทธิ์ - ห้ามย้ายอัตโนมัติ
              </div>
              <p className="text-xs text-red-700 mt-1">
                ตาราง: {economicDataFindings.map((f: any) => f.table).join(", ")} - ต้องใช้กระบวนการ Advanced Account Merge เท่านั้น
              </p>
            </div>
          )}
          {userOwnedDataFindings.length > 0 && (
            <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-amber-800 font-medium">
                <AlertTriangle className="w-4 h-4" /> พบข้อมูลของผู้ใช้ที่อาจสูญหาย
              </div>
              <p className="text-xs text-amber-700 mt-1">
                ตาราง: {userOwnedDataFindings.map((f: any) => f.table).join(", ")} - ตรวจสอบก่อนอนุมัติ
              </p>
            </div>
          )}
        </Card>

        {isPending && (
          <Card className="p-6">
            <h3 className="font-semibold mb-3">ค้นหาบัญชีเดิม (target) - ค้นหาแบบตรงทั้งหมดเท่านั้น</h3>
            <div className="flex gap-2">
              <Select value={searchMode} onValueChange={(v) => setSearchMode(v as any)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="id">User ID</SelectItem>
                  <SelectItem value="email">อีเมล</SelectItem>
                  <SelectItem value="openId">Open ID</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="ค่าที่ต้องการค้นหา (ตรงทั้งหมด)"
              />
              <Button onClick={handleSearch} disabled={searchQuery.isFetching}>
                {searchQuery.isFetching ? "กำลังค้นหา..." : "ค้นหา"}
              </Button>
            </div>

            {searchInput && !searchQuery.isFetching && (
              <div className="mt-4">
                {!searchQuery.data?.user && <p className="text-sm text-muted-foreground">ไม่พบบัญชีที่ตรงกับเงื่อนไข</p>}
                {searchQuery.data?.user && (
                  <div className="border rounded-lg p-3 flex items-center justify-between">
                    <div className="text-sm">
                      <p className="font-medium">User ID #{searchQuery.data.user.id}</p>
                      <p className="text-muted-foreground">
                        {searchQuery.data.user.maskedEmail ?? "-"} · {searchQuery.data.user.name ?? "-"} ·{" "}
                        {searchQuery.data.user.role}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Google Identity: {searchQuery.data.hasGoogleIdentity ? "มีแล้ว (ไม่สามารถเป็น target ได้)" : "ไม่มี"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={searchQuery.data.hasGoogleIdentity || searchQuery.data.user.role === "admin"}
                      onClick={() => setTargetUserId(searchQuery.data!.user!.id)}
                    >
                      ใช้เป็น Target
                    </Button>
                  </div>
                )}
              </div>
            )}

            {targetUserId && (
              <div className="mt-4 border-t pt-4">
                <p className="text-sm font-medium mb-2">Target ที่เลือก: User ID #{targetUserId}</p>
                {previewQuery.isFetching && <Loader2 className="w-5 h-5 animate-spin text-blue-600" />}
                {previewQuery.data && (
                  <div className="space-y-2">
                    {previewQuery.data.blockReasons.length > 0 && (
                      <div className="border border-red-200 bg-red-50 rounded-lg p-3 text-sm text-red-800">
                        <p className="font-medium mb-1">ไม่สามารถอนุมัติได้:</p>
                        <ul className="list-disc list-inside">
                          {previewQuery.data.blockReasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {previewQuery.data.warnings.length > 0 && (
                      <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 text-sm text-amber-800">
                        <p className="font-medium mb-1">คำเตือน:</p>
                        <ul className="list-disc list-inside">
                          {previewQuery.data.warnings.map((warning, i) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {previewQuery.data.canApprove && (
                      <div className="flex items-center gap-2 text-green-700 text-sm">
                        <CheckCircle2 className="w-4 h-4" /> ผ่านเงื่อนไขความปลอดภัยพื้นฐาน สามารถอนุมัติได้
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {isPending && (
          <div className="flex gap-3">
            <Button
              size="lg"
              disabled={!targetUserId || !previewQuery.data?.canApprove}
              onClick={() => setShowApproveDialog(true)}
            >
              อนุมัติและย้าย Google Identity
            </Button>
            <Button size="lg" variant="outline" onClick={() => setShowReasonDialog("reject")}>
              ปฏิเสธ
            </Button>
            <Button size="lg" variant="destructive" onClick={() => setShowReasonDialog("block")}>
              ระงับ (ต้องใช้ Advanced Account Merge)
            </Button>
          </div>
        )}
      </div>

      {/* Reject/Block reason dialog */}
      <Dialog open={showReasonDialog !== null} onOpenChange={(open) => !open && setShowReasonDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{showReasonDialog === "reject" ? "ปฏิเสธคำขอ" : "ระงับคำขอ"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="reasonText">เหตุผล (จำเป็น)</Label>
            <Textarea id="reasonText" value={reasonText} onChange={(e) => setReasonText(e.target.value)} rows={4} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowReasonDialog(null)}>
                ยกเลิก
              </Button>
              <Button
                disabled={!reasonText.trim() || rejectMutation.isPending || blockMutation.isPending}
                onClick={() => {
                  if (showReasonDialog === "reject") {
                    rejectMutation.mutate({ requestId, reason: reasonText.trim() });
                  } else if (showReasonDialog === "block") {
                    blockMutation.mutate({ requestId, reason: reasonText.trim() });
                  }
                }}
              >
                ยืนยัน
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Approve confirmation dialog - requires typing the target user id */}
      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยืนยันการอนุมัติ</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="border rounded-lg p-3 text-sm space-y-1 bg-slate-50">
              <p>
                <span className="font-medium">Source User ID:</span> {request.requesterUserId}
              </p>
              <p>
                <span className="font-medium">Target User ID:</span> {targetUserId}
              </p>
            </div>
            <div>
              <Label htmlFor="approveConfirmTypedId">พิมพ์ Target User ID ({targetUserId}) เพื่อยืนยัน</Label>
              <Input
                id="approveConfirmTypedId"
                value={approveConfirmTypedId}
                onChange={(e) => setApproveConfirmTypedId(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="approveReason">เหตุผล (จำเป็น)</Label>
              <Textarea id="approveReason" value={approveReason} onChange={(e) => setApproveReason(e.target.value)} rows={3} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowApproveDialog(false)}>
                ยกเลิก
              </Button>
              <Button
                disabled={
                  !targetUserId ||
                  approveConfirmTypedId.trim() !== String(targetUserId) ||
                  !approveReason.trim() ||
                  approveMutation.isPending
                }
                onClick={() => {
                  if (!targetUserId) return;
                  approveMutation.mutate({ requestId, targetUserId, reason: approveReason.trim() });
                }}
              >
                {approveMutation.isPending ? "กำลังอนุมัติ..." : "ยืนยันการอนุมัติ"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
