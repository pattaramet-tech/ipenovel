import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { useLanguage } from "@/contexts/LanguageContext";
import { getCountdownText, formatDateThai } from "@/lib/utils";
import { toast } from "sonner";
import { useState } from "react";
import { Zap, Eye, AlertTriangle, Clock } from "lucide-react";

const emptyForm = {
  title: "",
  leagueName: "",
  homeTeamName: "",
  awayTeamName: "",
  homeTeamImageUrl: "",
  awayTeamImageUrl: "",
  coverImageUrl: "",
  matchStartAt: "",
  voteDeadlineAt: "",
  voteCostPoints: "10",
  rewardDiscountType: "flat" as "flat" | "percentage",
  rewardDiscountValue: "10",
  rewardMinPurchaseAmount: "50",
  rewardCouponExpiresAt: "",
  status: "draft" as "draft" | "open" | "closed",
  isActive: true,
  displayOrder: "0",
};

const worldCupTemplate = {
  ...emptyForm,
  leagueName: "FIFA World Cup 2026",
  voteCostPoints: "10",
  rewardDiscountType: "flat" as const,
  rewardDiscountValue: "10",
  rewardMinPurchaseAmount: "50",
  status: "open" as const,
  isActive: true,
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function AdminSportsVotesPage() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const utils = trpc.useUtils();
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [settleResultById, setSettleResultById] = useState<Record<number, "home_win" | "draw" | "away_win">>({});
  const [settleConfirmId, setSettleConfirmId] = useState<number | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<number | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<number | null>(null);

  const { data: matches = [], isLoading } = trpc.admin.sportsMatches.list.useQuery(undefined, {
    enabled: !!user && user.role === "admin",
  });

  const createMutation = trpc.admin.sportsMatches.create.useMutation({
    onSuccess: () => {
      toast.success(t("common.success"));
      setForm(emptyForm);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });

  const updateMutation = trpc.admin.sportsMatches.update.useMutation({
    onSuccess: () => {
      toast.success(t("common.success"));
      setEditingId(null);
      setForm(emptyForm);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });

  const uploadMutation = trpc.admin.sportsMatches.uploadImage.useMutation({
    onError: (error) => toast.error(error.message || t("common.error")),
  });

  const settleMutation = trpc.admin.sportsMatches.settle.useMutation({
    onSuccess: (result) => {
      toast.success(`Match settled. Winners: ${result.winnerCount}`);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });

  const cancelMutation = trpc.admin.sportsMatches.cancel.useMutation({
    onSuccess: (result) => {
      toast.success(`Match cancelled. Refunded: ${result.refundedCount}`);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });

  if (!isAuthenticated || user?.role !== "admin") {
    return <div className="min-h-screen flex items-center justify-center">Admin access required</div>;
  }

  const uploadImage = async (file: File, field: "coverImageUrl" | "homeTeamImageUrl" | "awayTeamImageUrl") => {
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
      toast.error("Only JPG, PNG, or WEBP images are allowed");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be 2MB or smaller");
      return;
    }
    const fileBase64 = await fileToBase64(file);
    const uploaded = await uploadMutation.mutateAsync({ fileName: file.name, mimeType: file.type as any, fileBase64 });
    setForm((prev) => ({ ...prev, [field]: uploaded.url }));
    toast.success(t("common.success"));
  };

  const save = () => {
    if (!form.title || !form.homeTeamName || !form.awayTeamName || !form.voteDeadlineAt) {
      toast.error("Title, teams, and vote deadline are required");
      return;
    }

    // Validate deadline for open matches
    if (form.status === "open") {
      const deadlineTime = new Date(form.voteDeadlineAt).getTime();
      const nowTime = Date.now();

      if (deadlineTime <= nowTime) {
        toast.error("Deadline must be in the future for open matches");
        return;
      }
    }

    const payload = {
      title: form.title,
      leagueName: form.leagueName || undefined,
      homeTeamName: form.homeTeamName,
      awayTeamName: form.awayTeamName,
      homeTeamImageUrl: form.homeTeamImageUrl || undefined,
      awayTeamImageUrl: form.awayTeamImageUrl || undefined,
      coverImageUrl: form.coverImageUrl || undefined,
      matchStartAt: form.matchStartAt ? new Date(form.matchStartAt) : undefined,
      voteDeadlineAt: new Date(form.voteDeadlineAt),
      voteCostPoints: form.voteCostPoints,
      rewardDiscountType: form.rewardDiscountType,
      rewardDiscountValue: form.rewardDiscountValue,
      rewardMinPurchaseAmount: form.rewardMinPurchaseAmount || undefined,
      rewardCouponExpiresAt: form.rewardCouponExpiresAt ? new Date(form.rewardCouponExpiresAt) : undefined,
      status: form.status,
      isActive: form.isActive,
      displayOrder: Number(form.displayOrder) || 0,
    };

    if (editingId) updateMutation.mutate({ matchId: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  // Calculate summary stats
  const openCount = matches.filter((m: any) => m.status === "open").length;
  const totalVotes = matches.reduce((sum: number, m: any) => sum + m.voteCount, 0);
  const pendingCount = matches.filter((m: any) => m.status === "open").length;
  const settledCount = matches.filter((m: any) => m.status === "settled").length;

  // Filter matches by status
  const filteredMatches =
    statusFilter === "all"
      ? matches
      : matches.filter((m: any) => m.status === statusFilter);

  const loadWorldCupTemplate = () => {
    setForm(worldCupTemplate);
    toast.success("World Cup template loaded");
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 space-y-6">
        <h1 className="text-3xl font-bold">⚽ {t("sports.title")} - Admin</h1>

        {/* Summary Cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-slate-600 mb-1">Open Matches</p>
              <p className="text-2xl font-bold">{openCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-slate-600 mb-1">Total Votes</p>
              <p className="text-2xl font-bold">{totalVotes}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-slate-600 mb-1">Pending Matches</p>
              <p className="text-2xl font-bold">{pendingCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-slate-600 mb-1">Settled</p>
              <p className="text-2xl font-bold">{settledCount}</p>
            </CardContent>
          </Card>
        </div>

        {/* World Cup Quick Setup */}
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-600" /> World Cup Quick Setup
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600 mb-4">
              Click to fill default values for World Cup matches. Still need to enter team names and deadline.
            </p>
            <Button onClick={loadWorldCupTemplate} className="bg-amber-600 hover:bg-amber-700">
              Load World Cup Template
            </Button>
          </CardContent>
        </Card>

        {/* Create/Edit Form */}
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit Match" : "Create Match"}</CardTitle>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Match Title *</label>
              <Input
                placeholder="e.g., Quarterfinals"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">League</label>
              <Input
                placeholder="e.g., FIFA World Cup 2026"
                value={form.leagueName}
                onChange={(e) => setForm({ ...form, leagueName: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Home Team *</label>
              <Input
                placeholder="e.g., France"
                value={form.homeTeamName}
                onChange={(e) => setForm({ ...form, homeTeamName: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Away Team *</label>
              <Input
                placeholder="e.g., Sweden"
                value={form.awayTeamName}
                onChange={(e) => setForm({ ...form, awayTeamName: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Match Start Time</label>
              <Input
                type="datetime-local"
                value={form.matchStartAt}
                onChange={(e) => setForm({ ...form, matchStartAt: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Voting Status *</label>
              <Select value={form.status} onValueChange={(value: "draft" | "open" | "closed") => setForm({ ...form, status: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">แบบร่าง</SelectItem>
                  <SelectItem value="open">เปิดรับโหวต</SelectItem>
                  <SelectItem value="closed">ปิดรับโหวต</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                {form.status === "draft" && "ยังไม่แสดงเป็นแมตช์ที่เปิดให้ทาย"}
                {form.status === "open" && "ผู้ใช้สามารถทายได้จนถึงเวลาปิดรับ"}
                {form.status === "closed" && "ผู้ใช้จะทายเพิ่มไม่ได้ แต่ยังประกาศผลภายหลังได้"}
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">เวลาปิดรับโหวต *</label>
              <Input
                type="datetime-local"
                value={form.voteDeadlineAt}
                onChange={(e) => setForm({ ...form, voteDeadlineAt: e.target.value })}
              />
              <p className="text-xs text-slate-500 mt-1">
                เมื่อถึงเวลานี้ ผู้ใช้จะไม่สามารถทายผลเพิ่มได้ แม้สถานะยังเป็นเปิดรับโหวต
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Vote Cost (Points)</label>
              <Input
                placeholder="e.g., 10"
                value={form.voteCostPoints}
                onChange={(e) => setForm({ ...form, voteCostPoints: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Reward Value</label>
              <Input
                placeholder="e.g., 10"
                value={form.rewardDiscountValue}
                onChange={(e) => setForm({ ...form, rewardDiscountValue: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Reward Type</label>
              <Select value={form.rewardDiscountType} onValueChange={(value: any) => setForm({ ...form, rewardDiscountType: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="flat">Flat Amount</SelectItem>
                  <SelectItem value="percentage">Percentage Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Min Purchase</label>
              <Input
                placeholder="0 for no minimum"
                value={form.rewardMinPurchaseAmount}
                onChange={(e) => setForm({ ...form, rewardMinPurchaseAmount: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Coupon Expiration</label>
              <Input
                type="datetime-local"
                value={form.rewardCouponExpiresAt}
                onChange={(e) => setForm({ ...form, rewardCouponExpiresAt: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Display Order</label>
              <Input
                placeholder="0"
                value={form.displayOrder}
                onChange={(e) => setForm({ ...form, displayOrder: e.target.value })}
              />
            </div>

            <div>
              <label className="text-sm font-semibold">Cover Image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "coverImageUrl")} />
            </div>
            <div>
              <label className="text-sm font-semibold">Home Team Image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "homeTeamImageUrl")} />
            </div>
            <div>
              <label className="text-sm font-semibold">Away Team Image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "awayTeamImageUrl")} />
            </div>

            <div className="md:col-span-2 flex gap-2">
              <Button onClick={save}>{editingId ? "Update" : "Create"}</Button>
              {editingId && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingId(null);
                    setForm(emptyForm);
                  }}
                >
                  Cancel Edit
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Status Filter */}
        <div className="flex gap-2 items-center">
          <label className="text-sm font-semibold">Filter by Status:</label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="settled">Settled</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Matches List */}
        <div className="grid lg:grid-cols-2 gap-4">
          {filteredMatches.map((match: any) => (
            <Card key={match.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex gap-3">
                  <img
                    src={match.coverImageUrl || match.homeTeamImageUrl || "/placeholder.svg"}
                    className="w-20 h-20 rounded-lg object-cover bg-slate-100"
                  />
                  <div className="flex-1">
                    <h3 className="font-bold">{match.title}</h3>
                    <p className="text-sm text-slate-600">
                      {match.homeTeamName} vs {match.awayTeamName}
                    </p>
                    <p className="text-xs text-slate-500">Status: {match.status} | Votes: {match.voteCount}</p>
                    <p className="text-xs text-slate-500">
                      🏠 {match.homeVoteCount} 🤝 {match.drawVoteCount} 🚗 {match.awayVoteCount}
                    </p>
                    {match.voteDeadlineAt && (
                      <div className="text-xs text-slate-500 flex items-center gap-1 mt-1">
                        <Clock className="w-3 h-3" />
                        {new Date(match.voteDeadlineAt).getTime() > Date.now()
                          ? `เหลือเวลา: ${getCountdownText(match.voteDeadlineAt)}`
                          : "ครบเวลาปิดรับโหวตแล้ว"}
                      </div>
                    )}
                    {match.status === "open" && new Date(match.voteDeadlineAt).getTime() <= Date.now() && (
                      <div className="text-xs text-orange-600 flex items-center gap-1 mt-1 bg-orange-50 p-1 rounded">
                        <AlertTriangle className="w-3 h-3" />
                        ครบเวลาแล้ว ควรกดปิดรับโหวตหรือประกาศผล
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={match.status === "settled" || match.status === "cancelled"}
                    onClick={() => {
                      setEditingId(match.id);
                      setForm({
                        ...emptyForm,
                        ...match,
                        matchStartAt: match.matchStartAt ? new Date(match.matchStartAt).toISOString().slice(0, 16) : "",
                        voteDeadlineAt: match.voteDeadlineAt ? new Date(match.voteDeadlineAt).toISOString().slice(0, 16) : "",
                        rewardCouponExpiresAt: match.rewardCouponExpiresAt ? new Date(match.rewardCouponExpiresAt).toISOString().slice(0, 16) : "",
                        voteCostPoints: String(match.voteCostPoints || "0"),
                        rewardDiscountValue: String(match.rewardDiscountValue || "0"),
                        rewardMinPurchaseAmount: String(match.rewardMinPurchaseAmount || "0"),
                        displayOrder: String(match.displayOrder || "0"),
                      });
                    }}
                  >
                    Edit
                  </Button>

                  {match.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-orange-600 hover:text-orange-700"
                      onClick={() => setCloseConfirmId(match.id)}
                    >
                      <Eye className="w-3 h-3 mr-1" /> Close Vote
                    </Button>
                  )}

                  <Select value={settleResultById[match.id] || "home_win"} onValueChange={(value: any) => setSettleResultById({ ...settleResultById, [match.id]: value })}>
                    <SelectTrigger className="w-36 h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="home_win">Home Win</SelectItem>
                      <SelectItem value="draw">Draw</SelectItem>
                      <SelectItem value="away_win">Away Win</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button size="sm" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => setSettleConfirmId(match.id)}>
                    Settle
                  </Button>

                  <Button size="sm" variant="destructive" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => setCancelConfirmId(match.id)}>
                    Cancel
                  </Button>

                  {/* Settle Confirmation */}
                  <AlertDialog open={settleConfirmId === match.id} onOpenChange={(open) => !open && setSettleConfirmId(null)}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Settle Match?</AlertDialogTitle>
                        <AlertDialogDescription>This will finalize the result and generate reward coupons. Cannot be undone.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="bg-blue-50 p-3 rounded text-sm space-y-1">
                        <p>
                          <strong>Match:</strong> {match.homeTeamName} vs {match.awayTeamName}
                        </p>
                        <p>
                          <strong>Result:</strong> {settleResultById[match.id] || "home_win"}
                        </p>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            settleMutation.mutate({ matchId: match.id, result: settleResultById[match.id] || "home_win" });
                            setSettleConfirmId(null);
                          }}
                        >
                          Settle
                        </AlertDialogAction>
                      </div>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Cancel Confirmation */}
                  <AlertDialog open={cancelConfirmId === match.id} onOpenChange={(open) => !open && setCancelConfirmId(null)}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Cancel Match?</AlertDialogTitle>
                        <AlertDialogDescription>This will refund all pending votes. Users will receive their points back. Cannot be undone.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="bg-red-50 p-3 rounded text-sm">
                        <p>
                          <strong>Match:</strong> {match.homeTeamName} vs {match.awayTeamName}
                        </p>
                        <p className="text-red-700 font-semibold mt-2">All pending votes will be refunded.</p>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            cancelMutation.mutate({ matchId: match.id });
                            setCancelConfirmId(null);
                          }}
                          className="bg-red-600 hover:bg-red-700"
                        >
                          Cancel Match
                        </AlertDialogAction>
                      </div>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Close Vote Confirmation */}
                  <AlertDialog open={closeConfirmId === match.id} onOpenChange={(open) => !open && setCloseConfirmId(null)}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Close Voting?</AlertDialogTitle>
                        <AlertDialogDescription>Users will no longer be able to vote on this match.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="bg-orange-50 p-3 rounded text-sm">
                        <p>
                          <strong>Match:</strong> {match.homeTeamName} vs {match.awayTeamName}
                        </p>
                        <p className="text-orange-700 font-semibold mt-2">Voting will be closed immediately.</p>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            updateMutation.mutate({
                              matchId: match.id,
                              status: "closed",
                            });
                            setCloseConfirmId(null);
                          }}
                          className="bg-orange-600 hover:bg-orange-700"
                        >
                          Close Voting
                        </AlertDialogAction>
                      </div>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {isLoading && <p>Loading...</p>}
      </div>
    </div>
  );
}
