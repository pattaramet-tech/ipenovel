import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Trophy, Gift, Clock, Coins, Copy, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const predictionLabel: Record<string, string> = {
  home_win: "Home Win",
  draw: "Draw",
  away_win: "Away Win",
};

const rewardStatusConfig: Record<string, { text: string; color: string; badgeVariant: string }> = {
  issued: { text: "Available", color: "bg-blue-50", badgeVariant: "secondary" },
  used: { text: "✓ Used", color: "bg-green-50", badgeVariant: "default" },
  expired: { text: "Expired", color: "bg-slate-50", badgeVariant: "outline" },
  void: { text: "Voided", color: "bg-red-50", badgeVariant: "destructive" }
};

function formatDate(value?: string | Date | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function rewardText(match: any) {
  const value = Number(match.rewardDiscountValue || 0);
  if (match.rewardDiscountType === "percentage") return `${value}% coupon`;
  return `฿${value.toFixed(2)} coupon`;
}

export default function SportsVotesPage() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();

  const { data: points } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });
  const { data: matches = [], isLoading } = trpc.sports.list.useQuery(undefined, { enabled: isAuthenticated });
  const { data: rewards = [], isLoading: rewardsLoading } = trpc.sports.myRewards.useQuery(undefined, { enabled: isAuthenticated });

  const voteMutation = trpc.sports.vote.useMutation({
    onSuccess: () => {
      toast.success("Vote submitted");
      utils.sports.list.invalidate();
      utils.points.balance.invalidate();
    },
    onError: (error) => toast.error(error.message || "Vote failed"),
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4 max-w-xl">
          <Card>
            <CardContent className="pt-6 text-center">Please log in to vote.</CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Trophy className="w-7 h-7" /> Football Predictions
            </h1>
            <p className="text-slate-600">Spend points to predict match results and win coupons.</p>
          </div>
          <Badge variant="secondary" className="text-base px-4 py-2 w-fit">
            <Coins className="w-4 h-4 mr-1" /> Points: {points?.balance || "0.00"}
          </Badge>
        </div>

        {rewards.length > 0 && (
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Gift className="w-6 h-6" /> My Rewards
            </h2>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {rewards.map((reward: any) => {
                const config = rewardStatusConfig[reward.rewardStatus] || rewardStatusConfig.expired;
                const statusColor = config.color;
                const statusText = config.text;
                return (
                  <Card key={`${reward.matchId}-${reward.couponCode}`} className={statusColor}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{reward.matchTitle}</CardTitle>
                      <p className="text-xs text-slate-600">{reward.homeTeamName} vs {reward.awayTeamName}</p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-xs space-y-1">
                        <p>Your prediction: <b>{predictionLabel[reward.prediction]}</b></p>
                        <p>Result: <b>{reward.result || "Pending"}</b></p>
                        <p className="flex items-center gap-1">
                          Status: <Badge variant={config.badgeVariant as any}>{statusText}</Badge>
                          {reward.rewardStatus === "void" && <AlertCircle className="w-3 h-3 text-red-500" />}
                        </p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="text-xs text-slate-600">Coupon Code</p>
                        <code className="font-bold text-sm">{reward.couponCode}</code>
                      </div>
                      <div className="text-xs text-slate-600 space-y-1">
                        <p>Discount: {reward.discountType === "percentage" ? `${reward.discountValue}%` : `฿${reward.discountValue}`}</p>
                        {reward.minPurchaseAmount && <p>Min: ฿{reward.minPurchaseAmount}</p>}
                        {reward.expiresAt && <p>Expires: {formatDate(reward.expiresAt)}</p>}
                      </div>
                      <Button size="sm" className="w-full" disabled={reward.rewardStatus !== "issued"} onClick={() => {
                        navigator.clipboard.writeText(reward.couponCode);
                        toast.success("Coupon copied!");
                      }}>
                        <Copy className="w-3 h-3 mr-1" /> 
                        {reward.rewardStatus === "issued" ? "Copy Coupon" : 
                         reward.rewardStatus === "used" ? "Already Used" : 
                         reward.rewardStatus === "void" ? "Voided" : 
                         "Expired"}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <Trophy className="w-6 h-6" /> Active Matches
        </h2>

        {isLoading ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
          </div>
        ) : matches.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-slate-500">No matches available.</CardContent></Card>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {matches.map((match: any) => {
              const myVote = match.myVote;
              const isOpen = match.status === "open" && new Date(match.voteDeadlineAt).getTime() > Date.now();
              const disabled = !!myVote || !isOpen || voteMutation.isPending;

              return (
                <Card key={match.id} className="overflow-hidden">
                  {match.coverImageUrl && (
                    <img src={match.coverImageUrl} alt={match.title} className="w-full h-28 object-cover" />
                  )}
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-lg line-clamp-1">{match.title}</CardTitle>
                        <p className="text-xs text-slate-500">{match.leagueName || "Football"}</p>
                      </div>
                      <Badge variant={match.status === "open" ? "default" : "secondary"}>{match.status}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-center">
                      <div>
                        <img src={match.homeTeamImageUrl || match.coverImageUrl || "/placeholder.svg"} className="w-14 h-14 object-cover rounded-lg mx-auto bg-slate-100" />
                        <p className="text-sm font-semibold mt-1 line-clamp-1">{match.homeTeamName}</p>
                      </div>
                      <div className="font-bold text-slate-400">VS</div>
                      <div>
                        <img src={match.awayTeamImageUrl || match.coverImageUrl || "/placeholder.svg"} className="w-14 h-14 object-cover rounded-lg mx-auto bg-slate-100" />
                        <p className="text-sm font-semibold mt-1 line-clamp-1">{match.awayTeamName}</p>
                      </div>
                    </div>

                    <div className="text-xs text-slate-600 space-y-1">
                      <div className="flex items-center gap-1"><Clock className="w-3 h-3" /> Deadline: {formatDate(match.voteDeadlineAt)}</div>
                      <div className="flex items-center gap-1"><Coins className="w-3 h-3" /> Cost: {match.voteCostPoints} points</div>
                      <div className="flex items-center gap-1"><Gift className="w-3 h-3" /> Reward: {rewardText(match)}</div>
                    </div>

                    {myVote ? (
                      <div className="rounded-lg bg-slate-100 p-3 text-sm">
                        <p>Your vote: <b>{predictionLabel[myVote.prediction]}</b></p>
                        <p>Status: <b>{myVote.status}</b></p>
                        {myVote.rewardCouponCode && (
                          <p className="mt-1">Coupon: <code className="font-bold">{myVote.rewardCouponCode}</code></p>
                        )}
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        <Button size="sm" disabled={disabled} onClick={() => voteMutation.mutate({ matchId: match.id, prediction: "home_win" })}>Home</Button>
                        <Button size="sm" variant="outline" disabled={disabled} onClick={() => voteMutation.mutate({ matchId: match.id, prediction: "draw" })}>Draw</Button>
                        <Button size="sm" disabled={disabled} onClick={() => voteMutation.mutate({ matchId: match.id, prediction: "away_win" })}>Away</Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
