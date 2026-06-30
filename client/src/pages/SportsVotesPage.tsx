import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Trophy, Gift, Clock, Coins, Copy, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { useState, useEffect } from "react";
import { formatDateThai, getCountdownText } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type TabType = "open" | "voted" | "pending" | "rewards";

const predictionLabelMap: Record<string, string> = {
  home_win: "sports.homeWin",
  draw: "sports.draw",
  away_win: "sports.awayWin",
};

const rewardStatusConfig: Record<string, { text: string; color: string; badgeVariant: string }> = {
  issued: { text: "sports.available", color: "bg-blue-50", badgeVariant: "secondary" },
  used: { text: "sports.alreadyUsed", color: "bg-green-50", badgeVariant: "default" },
  expired: { text: "sports.expired", color: "bg-slate-50", badgeVariant: "outline" },
  void: { text: "sports.voided", color: "bg-red-50", badgeVariant: "destructive" },
};

function rewardText(match: any): string {
  const value = Number(match.rewardDiscountValue || 0);
  if (match.rewardDiscountType === "percentage") return `${value}%`;
  return `฿${value.toFixed(2)}`;
}

export default function SportsVotesPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<TabType>("open");
  const [confirmVoteData, setConfirmVoteData] = useState<{
    matchId: number;
    prediction: string;
    homeTeam: string;
    awayTeam: string;
    cost: string;
  } | null>(null);

  const utils = trpc.useUtils();
  const { data: points } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });
  const { data: matches = [], isLoading } = trpc.sports.list.useQuery(undefined, { enabled: isAuthenticated });
  const { data: rewards = [], isLoading: rewardsLoading } = trpc.sports.myRewards.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const voteMutation = trpc.sports.vote.useMutation({
    onSuccess: () => {
      toast.success(t("sports.voteSubmitted"));
      setConfirmVoteData(null);
      utils.sports.list.invalidate();
      utils.points.balance.invalidate();
    },
    onError: (error) => toast.error(error.message || t("sports.voteFailed")),
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4 max-w-xl">
          <Card>
            <CardContent className="pt-6 text-center">{t("common.pleaseSignIn")}</CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const pointBalance = Number(points?.balance || 0);

  // Filter matches by tab
  const openMatches = matches.filter(
    (m: any) => m.status === "open" && new Date(m.voteDeadlineAt).getTime() > Date.now() && !m.myVote
  );
  const votedMatches = matches.filter((m: any) => m.myVote);
  const pendingMatches = votedMatches.filter((m: any) => m.myVote?.status === "pending");
  const rewardMatches = rewards;

  const tabs: { id: TabType; label: string; count: number }[] = [
    { id: "open", label: t("sports.tabs.openForVoting"), count: openMatches.length },
    { id: "voted", label: t("sports.tabs.myVotes"), count: votedMatches.length },
    { id: "pending", label: t("sports.tabs.pending"), count: pendingMatches.length },
    { id: "rewards", label: t("sports.tabs.myRewards"), count: rewardMatches.length },
  ];

  const displayMatches =
    activeTab === "open"
      ? openMatches
      : activeTab === "voted"
        ? votedMatches
        : activeTab === "pending"
          ? pendingMatches
          : [];

  const handleVoteClick = (match: any, prediction: string) => {
    const cost = Number(match.voteCostPoints);
    if (pointBalance < cost) {
      toast.error(t("sports.insufficientPoints").replace("{cost}", cost.toString()));
      return;
    }

    setConfirmVoteData({
      matchId: match.id,
      prediction,
      homeTeam: match.homeTeamName,
      awayTeam: match.awayTeamName,
      cost: cost.toString(),
    });
  };

  const confirmVote = () => {
    if (!confirmVoteData) return;
    voteMutation.mutate({
      matchId: confirmVoteData.matchId,
      prediction: confirmVoteData.prediction as "home_win" | "draw" | "away_win",
    });
  };

  const confirmDialogMessage = () => {
    if (!confirmVoteData) return "";
    const cost = confirmVoteData.cost;
    const home = confirmVoteData.homeTeam;
    const away = confirmVoteData.awayTeam;

    if (confirmVoteData.prediction === "home_win") {
      return t("sports.confirmVoteMessage").replace("{cost}", cost).replace("{home}", home).replace("{away}", away);
    } else if (confirmVoteData.prediction === "draw") {
      return t("sports.confirmVoteDrawMessage").replace("{cost}", cost).replace("{home}", home).replace("{away}", away);
    } else {
      return t("sports.confirmVoteAwayMessage").replace("{cost}", cost).replace("{away}", away).replace("{home}", home);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Trophy className="w-7 h-7 text-amber-600" /> {t("sports.title")}
            </h1>
            <p className="text-slate-600">{t("sports.subtitle")}</p>
          </div>
          <Badge variant="secondary" className="text-base px-4 py-2 w-fit">
            <Coins className="w-4 h-4 mr-1" /> {t("sports.points")}: {pointBalance.toFixed(2)}
          </Badge>
        </div>

        {/* Rewards Section */}
        {rewards.length > 0 && (
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Gift className="w-6 h-6 text-pink-600" /> {t("sports.myRewards")}
            </h2>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {rewards.map((reward: any) => {
                const config = rewardStatusConfig[reward.rewardStatus] || rewardStatusConfig.expired;
                return (
                  <Card key={`${reward.matchId}-${reward.couponCode}`} className={config.color}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{reward.matchTitle}</CardTitle>
                      <p className="text-xs text-slate-600">
                        {reward.homeTeamName} vs {reward.awayTeamName}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-xs space-y-1">
                        <p>
                          {t("sports.yourPrediction")}: <b>{t(predictionLabelMap[reward.prediction])}</b>
                        </p>
                        <p>
                          {t("sports.result")}: <b>{reward.result || t("sports.pending")}</b>
                        </p>
                        <p className="flex items-center gap-1">
                          {t("sports.status")}:
                          <Badge variant={config.badgeVariant as any}>{t(config.text)}</Badge>
                          {reward.rewardStatus === "void" && <AlertCircle className="w-3 h-3 text-red-500" />}
                        </p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="text-xs text-slate-600">{t("sports.couponCode")}</p>
                        <code className="font-bold text-sm">{reward.couponCode}</code>
                      </div>
                      <div className="text-xs text-slate-600 space-y-1">
                        <p>
                          {t("sports.discount")}: {reward.discountType === "percentage" ? `${reward.discountValue}%` : `฿${reward.discountValue}`}
                        </p>
                        {reward.minPurchaseAmount && <p>{t("sports.minPurchase")}: ฿{reward.minPurchaseAmount}</p>}
                        {reward.expiresAt && <p>{t("sports.expires")}: {formatDateThai(reward.expiresAt)}</p>}
                      </div>

                      {reward.rewardStatus === "issued" && (
                        <div className="flex flex-col gap-2">
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={() => {
                              navigator.clipboard.writeText(reward.couponCode);
                              toast.success(t("sports.copyAs"));
                            }}
                          >
                            <Copy className="w-3 h-3 mr-1" /> {t("sports.btnCopyCoupon")}
                          </Button>
                          <Button size="sm" variant="outline" className="w-full" onClick={() => navigate("/cart")}>
                            {t("sports.btnUseCoupon")}
                          </Button>
                        </div>
                      )}

                      {reward.rewardStatus !== "issued" && (
                        <Button size="sm" className="w-full" disabled>
                          {reward.rewardStatus === "used"
                            ? t("sports.alreadyUsed")
                            : reward.rewardStatus === "void"
                              ? t("sports.voided")
                              : t("sports.expired")}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 border-b">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 font-medium text-sm whitespace-nowrap border-b-2 transition ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-600 hover:text-slate-900"
                }`}
              >
                {tab.label}
                {tab.count > 0 && <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">{tab.count}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Matches Grid */}
        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <Trophy className="w-6 h-6" /> {t("sports.activeMatches")}
        </h2>

        {isLoading ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-xl" />
            ))}
          </div>
        ) : (activeTab === "rewards" ? rewards.length === 0 : displayMatches.length === 0) ? (
          <Card>
            <CardContent className="pt-6 text-center text-slate-500">
              {activeTab === "rewards" ? t("sports.noMatches") : t("sports.checkBack")}
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {displayMatches.map((match: any) => {
              const myVote = match.myVote;
              const isOpen = match.status === "open" && new Date(match.voteDeadlineAt).getTime() > Date.now();
              const cost = Number(match.voteCostPoints);
              const disabled = !isOpen || voteMutation.isPending;
              const insufficientPoints = pointBalance < cost;

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
                        <img
                          src={match.homeTeamImageUrl || match.coverImageUrl || "/placeholder.svg"}
                          className="w-14 h-14 object-cover rounded-lg mx-auto bg-slate-100"
                        />
                        <p className="text-sm font-semibold mt-1 line-clamp-1">{match.homeTeamName}</p>
                      </div>
                      <div className="font-bold text-slate-400">VS</div>
                      <div>
                        <img
                          src={match.awayTeamImageUrl || match.coverImageUrl || "/placeholder.svg"}
                          className="w-14 h-14 object-cover rounded-lg mx-auto bg-slate-100"
                        />
                        <p className="text-sm font-semibold mt-1 line-clamp-1">{match.awayTeamName}</p>
                      </div>
                    </div>

                    <div className="text-xs text-slate-600 space-y-1">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {t("sports.deadline")}: {getCountdownText(match.voteDeadlineAt)}
                      </div>
                      <div className="flex items-center gap-1">
                        <Coins className="w-3 h-3" /> {t("sports.cost")}: {cost} {t("sports.pts")}
                      </div>
                      <div className="flex items-center gap-1">
                        <Gift className="w-3 h-3" /> {t("sports.reward")}: {rewardText(match)}
                      </div>
                    </div>

                    {myVote ? (
                      <div className="rounded-lg bg-slate-100 p-3 text-sm">
                        <p>
                          {t("sports.yourPrediction")}: <b>{t(predictionLabelMap[myVote.prediction])}</b>
                        </p>
                        <p>
                          {t("sports.status")}: <b>{myVote.status}</b>
                        </p>
                        {myVote.rewardCouponCode && (
                          <p className="mt-1">
                            {t("sports.couponCode")}: <code className="font-bold">{myVote.rewardCouponCode}</code>
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        {!isOpen ? (
                          <Button disabled className="w-full">
                            {t("sports.closedForVoting")}
                          </Button>
                        ) : insufficientPoints ? (
                          <Button disabled className="w-full">
                            {t("sports.insufficientPoints").replace("{cost}", cost.toString())}
                          </Button>
                        ) : (
                          <div className="grid grid-cols-3 gap-2">
                            <Button
                              size="sm"
                              disabled={disabled}
                              onClick={() => handleVoteClick(match, "home_win")}
                              className="text-xs"
                            >
                              {t("sports.homeWin")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled}
                              onClick={() => handleVoteClick(match, "draw")}
                              className="text-xs"
                            >
                              {t("sports.draw")}
                            </Button>
                            <Button
                              size="sm"
                              disabled={disabled}
                              onClick={() => handleVoteClick(match, "away_win")}
                              className="text-xs"
                            >
                              {t("sports.awayWin")}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Confirmation Dialog */}
        <AlertDialog open={!!confirmVoteData} onOpenChange={(open) => !open && setConfirmVoteData(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("sports.confirmVote")}</AlertDialogTitle>
              <AlertDialogDescription>{confirmDialogMessage()}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="bg-blue-50 p-3 rounded text-sm space-y-1">
              <p>
                <strong>{t("sports.homeWin")}:</strong> {confirmVoteData?.homeTeam}
              </p>
              <p>
                <strong>{t("sports.awayWin")}:</strong> {confirmVoteData?.awayTeam}
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={confirmVote} disabled={voteMutation.isPending}>
                {voteMutation.isPending ? t("common.loading") : t("sports.btnConfirm")}
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
