import { useMemo, useState } from "react";
import AdminLayout from "@/components/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

type Action = "NOVEL_GIFT" | "WALLET_CREDIT" | "WALLET_CLAWBACK";

export default function AdminGiftWalletAdjustmentPage() {
  const [action, setAction] = useState<Action>("NOVEL_GIFT");
  const [targetUserId, setTargetUserId] = useState("");
  const [novelId, setNovelId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [originalId, setOriginalId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const utils = trpc.useUtils();

  const expectedConfirmation = useMemo(() => {
    if (!preview) return "";
    if (action === "NOVEL_GIFT") {
      return `CONFIRM USER ${preview.targetUserId} NOVEL ${preview.novelId}`;
    }
    return `CONFIRM USER ${preview.targetUserId} ${action} ${preview.amount}`;
  }, [action, preview]);

  const previewQuery = trpc.admin.giftWalletAdjustment.preview.useQuery({
    action,
    targetUserId: Number(targetUserId || 0),
    amount: action === "NOVEL_GIFT" ? undefined : amount,
    novelId: action === "NOVEL_GIFT" ? Number(novelId || 0) : undefined,
    linkedOriginalAdjustmentId: originalId ? Number(originalId) : undefined,
  }, { enabled: false });

  const executeMutation = trpc.admin.giftWalletAdjustment.execute.useMutation({
    onSuccess: async (data) => {
      toast.success(data.replayed ? "Request already applied (idempotent replay)" : "Adjustment applied");
      setPreview(null);
      setConfirmation("");
      await utils.admin.giftWalletAdjustment.history.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const history = trpc.admin.giftWalletAdjustment.history.useQuery({
    targetUserId: targetUserId ? Number(targetUserId) : undefined,
    action: undefined,
    limit: 30,
  });

  async function handlePreview() {
    setPreview(null);
    setConfirmation("");
    const result = await previewQuery.refetch();
    if (result.error) return toast.error(result.error.message);
    setPreview(result.data);
    setIdempotencyKey(`ipe048-${Date.now()}-${targetUserId}`);
  }

  function handleExecute() {
    if (!preview) return toast.error("Preview is required before execution");
    if (reason.trim().length < 3) return toast.error("Reason must be at least 3 characters");
    if (confirmation !== expectedConfirmation) return toast.error("Confirmation phrase does not match");
    executeMutation.mutate({
      action,
      targetUserId: Number(targetUserId),
      amount: action === "NOVEL_GIFT" ? undefined : amount,
      novelId: action === "NOVEL_GIFT" ? Number(novelId) : undefined,
      linkedOriginalAdjustmentId: originalId ? Number(originalId) : undefined,
      reason,
      idempotencyKey,
      confirmation,
      expectedBalance: preview.currentBalance,
    });
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Gift + Wallet Adjustment</h1>
          <p className="text-slate-600">Preview-first complimentary access, wallet credit, and wallet clawback.</p>
        </div>

        <Card>
          <CardHeader><CardTitle>Action</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 md:grid-cols-3">
              {(["NOVEL_GIFT", "WALLET_CREDIT", "WALLET_CLAWBACK"] as Action[]).map(value => (
                <Button key={value} variant={action === value ? "default" : "outline"}
                  onClick={() => { setAction(value); setPreview(null); setConfirmation(""); }}>
                  {value}
                </Button>
              ))}
            </div>
            <Input placeholder="Target user ID" value={targetUserId}
              onChange={e => { setTargetUserId(e.target.value); setPreview(null); setConfirmation(""); }} />
            {action === "NOVEL_GIFT" ? (
              <Input placeholder="Novel ID" value={novelId}
                onChange={e => { setNovelId(e.target.value); setPreview(null); setConfirmation(""); }} />
            ) : (
              <>
                <Input placeholder="Amount" value={amount}
                  onChange={e => { setAmount(e.target.value); setPreview(null); setConfirmation(""); }} />
                {action === "WALLET_CLAWBACK" && (
                  <Input placeholder="Original adjustment ID (optional)" value={originalId}
                    onChange={e => { setOriginalId(e.target.value); setPreview(null); }} />
                )}
              </>
            )}
            <Input placeholder="Reason (required)" value={reason} onChange={e => setReason(e.target.value)} />
            <Button onClick={handlePreview} disabled={previewQuery.isFetching || !targetUserId}>
              {previewQuery.isFetching ? "Previewing..." : "Preview"}
            </Button>
          </CardContent>
        </Card>

        {preview && (
          <Card>
            <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <pre className="overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(preview, null, 2)}</pre>
              {!preview.executable && action === "WALLET_CLAWBACK" && (
                <p className="text-sm font-medium text-red-600">Clawback cannot execute because it would require unsupported negative wallet/debt state.</p>
              )}
              <p className="text-sm">Type exactly: <code>{expectedConfirmation}</code></p>
              <Input placeholder="Confirmation phrase" value={confirmation} onChange={e => setConfirmation(e.target.value)} />
              <Button variant={action === "WALLET_CLAWBACK" ? "destructive" : "default"}
                disabled={executeMutation.isPending || confirmation !== expectedConfirmation || preview.executable === false}
                onClick={handleExecute}>
                {executeMutation.isPending ? "Executing..." : "Execute adjustment"}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {history.isLoading && <p className="text-sm text-slate-500">Loading history...</p>}
            {(history.data ?? []).map((row: any) => (
              <div key={row.id} className="rounded border p-3 text-sm">
                <div className="flex flex-wrap gap-3 font-medium">
                  <span>#{row.id}</span><span>{row.action}</span><span>User {row.targetUserId}</span>
                  {row.amount && <span>{row.amount}</span>}
                </div>
                <div className="mt-1 text-slate-600">{row.reason}</div>
                <div className="mt-1 text-xs text-slate-500">
                  actor={row.actorAdminId} · original={row.linkedOriginalAdjustmentId ?? "-"} · {String(row.createdAt)}
                </div>
              </div>
            ))}
            {!history.isLoading && (history.data ?? []).length === 0 && (
              <p className="text-sm text-slate-500">No adjustment history found.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
