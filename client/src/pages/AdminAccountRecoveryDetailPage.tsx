import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { buildAccountMergeConfirmationText } from "@shared/accountMergeConfirmation";
import {
  Loader2,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

function formatDate(date: Date | string | undefined | null): string {
  if (!date) return "-";
  try {
    return new Date(date).toLocaleString("th-TH", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function BalanceProjection({
  label,
  source,
  target,
  projected,
}: {
  label: string;
  source: string;
  target: string;
  projected: string;
}) {
  return (
    <div className="rounded-lg border p-3 text-sm">
      <p className="font-medium mb-2">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-xs text-muted-foreground">Source ก่อน</p>
          <p className="font-mono font-semibold">{source}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Target ก่อน</p>
          <p className="font-mono font-semibold">{target}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Target หลังรวม</p>
          <p className="font-mono font-semibold text-green-700">{projected}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Admin Account Recovery detail. Pending requests keep the original simple
 * Account Recovery approval path. BLOCKED requests expose the separate,
 * irreversible Advanced Account Merge flow introduced by IPE-008.
 */
export default function AdminAccountRecoveryDetailPage() {
  const [, params] = useRoute("/admin/account-recovery/:requestId");
  const [, navigate] = useLocation();
  const requestId = params?.requestId
    ? parseInt(params.requestId, 10)
    : undefined;
  const utils = trpc.useUtils();

  const [searchMode, setSearchMode] = useState<"id" | "email" | "openId">("id");
  const [searchValue, setSearchValue] = useState("");
  const [searchInput, setSearchInput] = useState<{
    mode: "id" | "email" | "openId";
    value: string;
  } | null>(null);
  const [targetUserId, setTargetUserId] = useState<number | null>(null);

  const [showReasonDialog, setShowReasonDialog] = useState<
    "reject" | "block" | null
  >(null);
  const [reasonText, setReasonText] = useState("");

  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approveReason, setApproveReason] = useState("");
  const [approveConfirmTypedId, setApproveConfirmTypedId] = useState("");

  const [mergeReason, setMergeReason] = useState("");
  const [mergeConfirmation, setMergeConfirmation] = useState("");

  const { data, isLoading } = trpc.accountRecovery.admin.detail.useQuery(
    { requestId: requestId ?? 0 },
    { enabled: Boolean(requestId) }
  );

  const requestStatus = data?.request.status;
  const isPending = requestStatus === "pending";
  const isBlocked = requestStatus === "blocked";

  const searchQuery = trpc.accountRecovery.admin.searchLegacyAccount.useQuery(
    searchInput as any,
    {
      enabled: searchInput !== null,
    }
  );

  const simplePreviewQuery =
    trpc.accountRecovery.admin.previewApproval.useQuery(
      { requestId: requestId ?? 0, targetUserId: targetUserId ?? 0 },
      { enabled: Boolean(requestId) && Boolean(targetUserId) && isPending }
    );

  const mergePreviewQuery = trpc.accountMerge.admin.preview.useQuery(
    { requestId: requestId ?? 0, targetUserId: targetUserId ?? 0 },
    { enabled: Boolean(requestId) && Boolean(targetUserId) && isBlocked }
  );

  const mergeStatusQuery = trpc.accountMerge.admin.status.useQuery(
    { requestId: requestId ?? 0 },
    { enabled: Boolean(requestId) && isBlocked }
  );

  const invalidateAll = () => {
    if (!requestId) return;
    utils.accountRecovery.admin.detail.invalidate({ requestId });
    utils.accountRecovery.admin.list.invalidate();
    utils.accountMerge.admin.status.invalidate({ requestId });
  };

  const approveMutation = trpc.accountRecovery.admin.approve.useMutation({
    onSuccess: () => {
      toast.success("อนุมัติคำขอกู้คืนบัญชีเรียบร้อยแล้ว");
      setShowApproveDialog(false);
      invalidateAll();
      navigate("/admin/account-recovery");
    },
    onError: error => toast.error(error.message || "ไม่สามารถอนุมัติคำขอได้"),
  });

  const rejectMutation = trpc.accountRecovery.admin.reject.useMutation({
    onSuccess: () => {
      toast.success("ปฏิเสธคำขอแล้ว");
      setShowReasonDialog(null);
      invalidateAll();
      navigate("/admin/account-recovery");
    },
    onError: error => toast.error(error.message || "ไม่สามารถปฏิเสธคำขอได้"),
  });

  const blockMutation = trpc.accountRecovery.admin.block.useMutation({
    onSuccess: () => {
      toast.success(
        "ระงับคำขอแล้ว — สามารถตรวจสอบ Advanced Account Merge ต่อได้"
      );
      setShowReasonDialog(null);
      invalidateAll();
    },
    onError: error => toast.error(error.message || "ไม่สามารถระงับคำขอได้"),
  });

  const mergeMutation = trpc.accountMerge.admin.execute.useMutation({
    onSuccess: result => {
      toast.success(
        result.alreadyCompleted
          ? "บัญชีนี้ถูกรวมเรียบร้อยแล้วก่อนหน้านี้"
          : "Advanced Account Merge สำเร็จ"
      );
      invalidateAll();
    },
    onError: error => toast.error(error.message || "ไม่สามารถรวมบัญชีได้"),
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

  const {
    request,
    requester,
    requesterHasGoogleIdentity,
    economicDataFindings,
    userOwnedDataFindings,
  } = data;
  const confirmationText = targetUserId
    ? buildAccountMergeConfirmationText(request.requesterUserId, targetUserId)
    : "";
  const mergeCompleted = mergeStatusQuery.data?.status === "completed";
  const mergePreviewReady = Boolean(
    mergePreviewQuery.data?.isPreviewValid &&
    mergePreviewQuery.data.targetValidation.isValid
  );

  const handleSearch = () => {
    if (!searchValue.trim()) return;
    setSearchInput({ mode: searchMode, value: searchValue.trim() });
  };

  const renderTargetSearch = () => (
    <Card className="p-6">
      <h3 className="font-semibold mb-3">
        ค้นหาบัญชี Target — ค้นหาแบบตรงทั้งหมดเท่านั้น
      </h3>
      <div className="flex gap-2">
        <Select value={searchMode} onValueChange={v => setSearchMode(v as any)}>
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
          onChange={e => setSearchValue(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          placeholder="ค่าที่ต้องการค้นหา (ตรงทั้งหมด)"
        />
        <Button onClick={handleSearch} disabled={searchQuery.isFetching}>
          {searchQuery.isFetching ? "กำลังค้นหา..." : "ค้นหา"}
        </Button>
      </div>

      {searchInput && !searchQuery.isFetching && (
        <div className="mt-4">
          {!searchQuery.data?.user && (
            <p className="text-sm text-muted-foreground">
              ไม่พบบัญชีที่ตรงกับเงื่อนไข
            </p>
          )}
          {searchQuery.data?.user && (
            <div className="border rounded-lg p-3 flex items-center justify-between">
              <div className="text-sm">
                <p className="font-medium">
                  User ID #{searchQuery.data.user.id}
                </p>
                <p className="text-muted-foreground">
                  {searchQuery.data.user.maskedEmail ?? "-"} ·{" "}
                  {searchQuery.data.user.name ?? "-"} ·{" "}
                  {searchQuery.data.user.role}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Google Identity:{" "}
                  {searchQuery.data.hasGoogleIdentity
                    ? "มีแล้ว (ห้ามใช้เป็น Target)"
                    : "ไม่มี"}
                </p>
              </div>
              <Button
                size="sm"
                disabled={
                  searchQuery.data.hasGoogleIdentity ||
                  searchQuery.data.user.role === "admin" ||
                  mergeCompleted
                }
                onClick={() => {
                  setTargetUserId(searchQuery.data!.user!.id);
                  setMergeConfirmation("");
                }}
              >
                ใช้เป็น Target
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );

  return (
    <AdminLayout>
      <div className="space-y-4 max-w-5xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/admin/account-recovery")}
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> กลับไปยังรายการ
        </Button>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              คำขอกู้คืนบัญชี #{request.id}
            </h2>
            <Badge>{request.status}</Badge>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">
                Requester User ID (Source)
              </p>
              <p className="font-medium">{request.requesterUserId}</p>
            </div>
            <div>
              <p className="text-muted-foreground">
                มี Google Identity จริงหรือไม่
              </p>
              <p className="font-medium">
                {requesterHasGoogleIdentity
                  ? "มี ✓"
                  : mergeCompleted
                    ? "ย้ายไป Target แล้ว ✓"
                    : "ไม่มี ✗ (ผิดปกติ)"}
              </p>
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
              <p className="font-medium">
                {request.requestedLegacyUserId ?? "-"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">เลขที่คำสั่งซื้ออ้างอิง</p>
              <p className="font-medium">
                {request.referenceOrderNumber ?? "-"}
              </p>
            </div>
          </div>

          {request.evidenceNote && (
            <div className="mt-3">
              <p className="text-muted-foreground text-sm">
                รายละเอียดเพิ่มเติมจากผู้ใช้
              </p>
              <p className="text-sm mt-1 whitespace-pre-wrap">
                {request.evidenceNote}
              </p>
            </div>
          )}

          {economicDataFindings.length > 0 && (
            <div className="mt-4 border border-red-200 bg-red-50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-red-800 font-medium">
                <AlertTriangle className="w-4 h-4" /> พบข้อมูลทางการเงิน/สิทธิ์
              </div>
              <p className="text-xs text-red-700 mt-1">
                ตาราง:{" "}
                {economicDataFindings.map((f: any) => f.table).join(", ")} —
                Simple Recovery ห้ามย้ายอัตโนมัติ
              </p>
            </div>
          )}
          {userOwnedDataFindings.length > 0 && (
            <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-amber-800 font-medium">
                <AlertTriangle className="w-4 h-4" /> พบข้อมูลของผู้ใช้ที่ต้อง
                reconcile
              </div>
              <p className="text-xs text-amber-700 mt-1">
                ตาราง:{" "}
                {userOwnedDataFindings.map((f: any) => f.table).join(", ")}
              </p>
            </div>
          )}
        </Card>

        {isPending && renderTargetSearch()}

        {isPending && targetUserId && (
          <Card className="p-6">
            <p className="text-sm font-medium mb-2">
              Simple Recovery Target: User ID #{targetUserId}
            </p>
            {simplePreviewQuery.isFetching && (
              <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            )}
            {simplePreviewQuery.data && (
              <div className="space-y-2">
                {simplePreviewQuery.data.blockReasons.length > 0 && (
                  <div className="border border-red-200 bg-red-50 rounded-lg p-3 text-sm text-red-800">
                    <p className="font-medium mb-1">
                      ไม่สามารถอนุมัติ Simple Recovery ได้:
                    </p>
                    <ul className="list-disc list-inside">
                      {simplePreviewQuery.data.blockReasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {simplePreviewQuery.data.canApprove && (
                  <div className="flex items-center gap-2 text-green-700 text-sm">
                    <CheckCircle2 className="w-4 h-4" /> ผ่านเงื่อนไข Simple
                    Recovery
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
              disabled={!targetUserId || !simplePreviewQuery.data?.canApprove}
              onClick={() => setShowApproveDialog(true)}
            >
              อนุมัติและย้าย Google Identity
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => setShowReasonDialog("reject")}
            >
              ปฏิเสธ
            </Button>
            <Button
              size="lg"
              variant="destructive"
              onClick={() => setShowReasonDialog("block")}
            >
              ระงับเพื่อใช้ Advanced Account Merge
            </Button>
          </div>
        )}

        {isBlocked && (
          <Card className="p-6 border-blue-200">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-blue-700 mt-0.5" />
              <div>
                <h3 className="font-semibold text-blue-950">
                  Advanced Account Merge
                </h3>
                <p className="text-sm text-blue-900 mt-1">
                  Recovery request นี้ยังคงสถานะ <strong>blocked</strong>{" "}
                  เป็นหลักฐานย้อนหลัง การรวมบัญชีเป็น workflow
                  แยกและมีสถานะ/audit ของตัวเอง
                </p>
              </div>
            </div>
          </Card>
        )}

        {isBlocked && mergeStatusQuery.isLoading && (
          <Card className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> กำลังตรวจสอบสถานะ
            Advanced Merge…
          </Card>
        )}

        {isBlocked && mergeCompleted && mergeStatusQuery.data && (
          <Card
            id="advanced-merge-audit"
            className="p-6 border-green-300 bg-green-50/40"
          >
            <div className="flex items-center gap-2 text-green-800 font-semibold mb-3">
              <CheckCircle2 className="w-5 h-5" /> Advanced Account Merge
              สำเร็จแล้ว
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Merge Case</p>
                <p className="font-medium">
                  #{mergeStatusQuery.data.mergeCaseId}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Source</p>
                <p className="font-medium">
                  #{mergeStatusQuery.data.sourceUserId}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Target</p>
                <p className="font-medium">
                  #{mergeStatusQuery.data.targetUserId}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Completed</p>
                <p className="font-medium">
                  {formatDate(mergeStatusQuery.data.completedAt)}
                </p>
              </div>
            </div>
            {"auditLogId" in mergeStatusQuery.data && (
              <p className="text-sm mt-3">
                Audit reference:{" "}
                <a
                  className="underline font-medium"
                  href="#advanced-merge-audit"
                >
                  accountMergeAuditLogs #{mergeStatusQuery.data.auditLogId}
                </a>
              </p>
            )}
          </Card>
        )}

        {isBlocked && !mergeCompleted && renderTargetSearch()}

        {isBlocked && !mergeCompleted && targetUserId && (
          <Card className="p-6 space-y-5">
            <div>
              <h3 className="font-semibold">
                Final Preview — Source #{request.requesterUserId} → Target #
                {targetUserId}
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                หน้านี้เป็น read-only preview เท่านั้น Server จะ re-run preview
                อีกครั้งภายใต้ final locks ก่อน write จริงทุกครั้ง
              </p>
            </div>

            {mergePreviewQuery.isFetching && (
              <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            )}
            {mergePreviewQuery.data && (
              <>
                {mergePreviewQuery.data.targetValidation.blockers.length >
                  0 && (
                  <div className="border border-red-300 bg-red-50 rounded-lg p-4 text-sm text-red-900">
                    <p className="font-semibold mb-1">Blockers</p>
                    <ul className="list-disc list-inside">
                      {mergePreviewQuery.data.targetValidation.blockers.map(
                        (reason, i) => (
                          <li key={i}>{reason}</li>
                        )
                      )}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <BalanceProjection
                    label="Wallet"
                    source={
                      mergePreviewQuery.data.walletProjection.sourceBalance
                    }
                    target={
                      mergePreviewQuery.data.walletProjection.targetBalance
                    }
                    projected={
                      mergePreviewQuery.data.walletProjection
                        .projectedMergedBalance
                    }
                  />
                  <BalanceProjection
                    label="Points"
                    source={
                      mergePreviewQuery.data.pointsProjection.sourceBalance
                    }
                    target={
                      mergePreviewQuery.data.pointsProjection.targetBalance
                    }
                    projected={
                      mergePreviewQuery.data.pointsProjection
                        .projectedMergedBalance
                    }
                  />
                </div>

                <div>
                  <p className="font-medium text-sm mb-2">
                    Per-table reconciliation preview
                  </p>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-left">
                        <tr>
                          <th className="p-2">Table</th>
                          <th className="p-2">Source</th>
                          <th className="p-2">Target</th>
                          <th className="p-2">Conflict</th>
                          <th className="p-2">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mergePreviewQuery.data.tableFindings.map(finding => (
                          <tr key={finding.table} className="border-t">
                            <td className="p-2 font-mono text-xs">
                              {finding.table}
                            </td>
                            <td className="p-2">{finding.sourceCount}</td>
                            <td className="p-2">{finding.targetCount}</td>
                            <td className="p-2">{finding.conflictCount}</td>
                            <td className="p-2">{finding.projectedAction}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {mergePreviewQuery.data.hardBlockers.length > 0 && (
                  <div className="border border-amber-300 bg-amber-50 rounded-lg p-4 text-sm text-amber-900">
                    <p className="font-semibold mb-1">
                      รายการที่ต้อง reconciliation ภายใน final transaction
                    </p>
                    <ul className="list-disc list-inside">
                      {mergePreviewQuery.data.hardBlockers.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                    <p className="text-xs mt-2">
                      รายการเหล่านี้ไม่ใช่ bypass: Phase-4 reconciliation
                      จะจัดการตาม deterministic rules หรือ fail closed หาก
                      semantics กำกวม
                    </p>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  paymentSlipClaims preserved:{" "}
                  {mergePreviewQuery.data.paymentSlipClaims.sourceCount} row(s)
                  — anti-replay evidence จะไม่ถูกย้าย/ลบ/เขียนใหม่
                </p>
              </>
            )}

            <div className="border border-red-300 bg-red-50 rounded-lg p-4">
              <div className="flex items-center gap-2 text-red-900 font-semibold">
                <AlertTriangle className="w-5 h-5" />{" "}
                การดำเนินการนี้ย้อนกลับไม่ได้จากหน้า Admin
              </div>
              <p className="text-sm text-red-800 mt-1">
                ระบบจะรวม Wallet/Points/สิทธิ์/ข้อมูลผู้ใช้ แล้วจึงย้าย Google
                Identity เป็นขั้นสุดท้ายใน transaction เดียว Source user
                จะถูกเก็บไว้ แต่ session เก่าจะถูกบังคับให้ sign out/re-login
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mergeReason">เหตุผลการรวมบัญชี (จำเป็น)</Label>
              <Textarea
                id="mergeReason"
                rows={3}
                value={mergeReason}
                onChange={e => setMergeReason(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mergeConfirmation">
                พิมพ์ข้อความนี้ให้ตรงทุกตัวอักษรเพื่อยืนยัน
              </Label>
              <div className="rounded bg-slate-100 p-2 font-mono text-sm select-all">
                {confirmationText}
              </div>
              <Input
                id="mergeConfirmation"
                className="font-mono"
                value={mergeConfirmation}
                onChange={e => setMergeConfirmation(e.target.value)}
                autoComplete="off"
              />
            </div>

            <Button
              size="lg"
              variant="destructive"
              className="w-full"
              disabled={
                !mergePreviewReady ||
                !mergeReason.trim() ||
                mergeConfirmation.trim() !== confirmationText ||
                mergeMutation.isPending
              }
              onClick={() => {
                if (!targetUserId) return;
                mergeMutation.mutate({
                  requestId,
                  targetUserId,
                  reason: mergeReason.trim(),
                  confirmation: mergeConfirmation.trim(),
                });
              }}
            >
              {mergeMutation.isPending
                ? "กำลังรวมบัญชี…"
                : "ยืนยัน Advanced Account Merge"}
            </Button>
          </Card>
        )}
      </div>

      <Dialog
        open={showReasonDialog !== null}
        onOpenChange={open => !open && setShowReasonDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {showReasonDialog === "reject" ? "ปฏิเสธคำขอ" : "ระงับคำขอ"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="reasonText">เหตุผล (จำเป็น)</Label>
            <Textarea
              id="reasonText"
              value={reasonText}
              onChange={e => setReasonText(e.target.value)}
              rows={4}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowReasonDialog(null)}
              >
                ยกเลิก
              </Button>
              <Button
                disabled={
                  !reasonText.trim() ||
                  rejectMutation.isPending ||
                  blockMutation.isPending
                }
                onClick={() => {
                  if (showReasonDialog === "reject") {
                    rejectMutation.mutate({
                      requestId,
                      reason: reasonText.trim(),
                    });
                  } else if (showReasonDialog === "block") {
                    blockMutation.mutate({
                      requestId,
                      reason: reasonText.trim(),
                    });
                  }
                }}
              >
                ยืนยัน
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยืนยัน Simple Account Recovery</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="border rounded-lg p-3 text-sm space-y-1 bg-slate-50">
              <p>
                <span className="font-medium">Source User ID:</span>{" "}
                {request.requesterUserId}
              </p>
              <p>
                <span className="font-medium">Target User ID:</span>{" "}
                {targetUserId}
              </p>
            </div>
            <div>
              <Label htmlFor="approveConfirmTypedId">
                พิมพ์ Target User ID ({targetUserId}) เพื่อยืนยัน
              </Label>
              <Input
                id="approveConfirmTypedId"
                value={approveConfirmTypedId}
                onChange={e => setApproveConfirmTypedId(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="approveReason">เหตุผล (จำเป็น)</Label>
              <Textarea
                id="approveReason"
                value={approveReason}
                onChange={e => setApproveReason(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowApproveDialog(false)}
              >
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
                  approveMutation.mutate({
                    requestId,
                    targetUserId,
                    reason: approveReason.trim(),
                  });
                }}
              >
                {approveMutation.isPending
                  ? "กำลังอนุมัติ..."
                  : "ยืนยันการอนุมัติ"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
