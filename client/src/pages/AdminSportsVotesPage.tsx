import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";

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
  rewardMinPurchaseAmount: "0",
  rewardCouponExpiresAt: "",
  status: "open" as "draft" | "open" | "closed",
  isActive: true,
  displayOrder: "0",
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
  const utils = trpc.useUtils();
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [settleResultById, setSettleResultById] = useState<Record<number, "home_win" | "draw" | "away_win">>({});

  const { data: matches = [], isLoading } = trpc.admin.sportsMatches.list.useQuery(undefined, {
    enabled: !!user && user.role === "admin",
  });

  const createMutation = trpc.admin.sportsMatches.create.useMutation({
    onSuccess: () => {
      toast.success("Match created");
      setForm(emptyForm);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "Create failed"),
  });

  const updateMutation = trpc.admin.sportsMatches.update.useMutation({
    onSuccess: () => {
      toast.success("Match updated");
      setEditingId(null);
      setForm(emptyForm);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "Update failed"),
  });

  const uploadMutation = trpc.admin.sportsMatches.uploadImage.useMutation({
    onError: (error) => toast.error(error.message || "Upload failed"),
  });

  const settleMutation = trpc.admin.sportsMatches.settle.useMutation({
    onSuccess: (result) => {
      toast.success(`Match settled. Winners: ${result.winnerCount}`);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "Settle failed"),
  });

  const cancelMutation = trpc.admin.sportsMatches.cancel.useMutation({
    onSuccess: (result) => {
      toast.success(`Match cancelled. Refunded: ${result.refundedCount}`);
      utils.admin.sportsMatches.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "Cancel failed"),
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
    toast.success("Image uploaded");
  };

  const save = () => {
    if (!form.title || !form.homeTeamName || !form.awayTeamName || !form.voteDeadlineAt) {
      toast.error("Title, teams, and vote deadline are required");
      return;
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

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 space-y-6">
        <h1 className="text-3xl font-bold">Football Vote Matches</h1>

        <Card>
          <CardHeader><CardTitle>{editingId ? "Edit Match" : "Create Match"}</CardTitle></CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Match Title *</label>
              <Input placeholder="e.g., Premier League Final" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">League</label>
              <Input placeholder="e.g., Premier League" value={form.leagueName} onChange={(e) => setForm({ ...form, leagueName: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Home Team *</label>
              <Input placeholder="e.g., Manchester United" value={form.homeTeamName} onChange={(e) => setForm({ ...form, homeTeamName: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Away Team *</label>
              <Input placeholder="e.g., Liverpool" value={form.awayTeamName} onChange={(e) => setForm({ ...form, awayTeamName: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Match Start Time</label>
              <Input type="datetime-local" value={form.matchStartAt} onChange={(e) => setForm({ ...form, matchStartAt: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Vote Deadline *</label>
              <Input type="datetime-local" value={form.voteDeadlineAt} onChange={(e) => setForm({ ...form, voteDeadlineAt: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Vote Cost (Points)</label>
              <Input placeholder="e.g., 10" value={form.voteCostPoints} onChange={(e) => setForm({ ...form, voteCostPoints: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Reward Discount Value</label>
              <Input placeholder="e.g., 10" value={form.rewardDiscountValue} onChange={(e) => setForm({ ...form, rewardDiscountValue: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Reward Type</label>
              <Select value={form.rewardDiscountType} onValueChange={(value: any) => setForm({ ...form, rewardDiscountType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="flat">Flat Amount</SelectItem>
                  <SelectItem value="percentage">Percentage Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Min Purchase Amount</label>
              <Input placeholder="0 for no minimum" value={form.rewardMinPurchaseAmount} onChange={(e) => setForm({ ...form, rewardMinPurchaseAmount: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Coupon Expiration</label>
              <Input type="datetime-local" value={form.rewardCouponExpiresAt} onChange={(e) => setForm({ ...form, rewardCouponExpiresAt: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Display Order</label>
              <Input placeholder="0" value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} />
            </div>

            <div>
              <label className="text-sm font-semibold">Cover image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "coverImageUrl")} />
            </div>
            <div>
              <label className="text-sm font-semibold">Home team image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "homeTeamImageUrl")} />
            </div>
            <div>
              <label className="text-sm font-semibold">Away team image</label>
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], "awayTeamImageUrl")} />
            </div>

            <div className="md:col-span-2 flex gap-2">
              <Button onClick={save}>{editingId ? "Update" : "Create"}</Button>
              {editingId && <Button variant="outline" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel Edit</Button>}
            </div>
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-2 gap-4">
          {matches.map((match: any) => (
            <Card key={match.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex gap-3">
                  <img src={match.coverImageUrl || match.homeTeamImageUrl || "/placeholder.svg"} className="w-20 h-20 rounded-lg object-cover bg-slate-100" />
                  <div className="flex-1">
                    <h3 className="font-bold">{match.title}</h3>
                    <p className="text-sm text-slate-600">{match.homeTeamName} vs {match.awayTeamName}</p>
                    <p className="text-xs text-slate-500">Status: {match.status} | Votes: {match.voteCount}</p>
                    <p className="text-xs text-slate-500">Home {match.homeVoteCount} / Draw {match.drawVoteCount} / Away {match.awayVoteCount}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => {
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
                  }}>Edit</Button>

                  <Select value={settleResultById[match.id] || "home_win"} onValueChange={(value: any) => setSettleResultById({ ...settleResultById, [match.id]: value })}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="home_win">Home Win</SelectItem>
                      <SelectItem value="draw">Draw</SelectItem>
                      <SelectItem value="away_win">Away Win</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button size="sm" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => {
                    if (confirm("Settle this match? This will generate coupons for winners.")) {
                      settleMutation.mutate({ matchId: match.id, result: settleResultById[match.id] || "home_win" });
                    }
                  }}>Settle</Button>

                  <Button size="sm" variant="destructive" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => {
                    if (confirm("Cancel this match and refund pending votes?")) {
                      cancelMutation.mutate({ matchId: match.id });
                    }
                  }}>Cancel Match</Button>
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
