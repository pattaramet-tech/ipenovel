import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { Loader2, BookOpen, ChevronDown, ChevronUp, Wallet, Clock, Mail, User } from "lucide-react";
import { useState, useMemo } from "react";
import { formatEpisodeLabel, compareEpisodes } from "@/utils/episodeUtils";

export default function ProfilePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [expandedNovel, setExpandedNovel] = useState<number | null>(null);

  // Fetch user data
  const { data: userData } = trpc.auth.me.useQuery(undefined, {
    enabled: !!user,
  });

  // Fetch wallet summary
  const { data: walletData, isLoading: walletLoading } = trpc.wallet.getSummary.useQuery(undefined, {
    enabled: !!user,
  });

  // Fetch points balance
  const { data: pointsData, isLoading: pointsLoading } = trpc.points.balance.useQuery(undefined, {
    enabled: !!user,
  });

  // Fetch library
  const { data: libraryData, isLoading: libraryLoading } = trpc.reader.myLibrary.useQuery(
    {},
    { enabled: !!user }
  );

  // Group by novel
  const groupedByNovel = useMemo(() => {
    if (!libraryData) return {};
    const grouped: Record<number, any[]> = {};
    libraryData.forEach((item: any) => {
      if (!grouped[item.novel.id]) {
        grouped[item.novel.id] = [];
      }
      grouped[item.novel.id].push(item);
    });
    return grouped;
  }, [libraryData]);

  const novelList = Object.keys(groupedByNovel).length > 0
    ? libraryData?.map((item: any) => item.novel).filter((v: any, i: number, a: any) => a.findIndex((t: any) => t.id === v.id) === i) || []
    : [];

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Card className="p-8 text-center">
          <p className="text-lg text-muted-foreground">Please log in to view your profile</p>
          <Button onClick={() => navigate("/auth")} className="mt-4">
            Go to Login
          </Button>
        </Card>
      </div>
    );
  }

  const displayUser = userData || user;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Profile Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900">โปรไฟล์ของฉัน</h1>
        </div>

        {/* Personal Info Section */}
        <Card className="p-6 mb-8">
          <h2 className="text-2xl font-bold mb-6 text-slate-900">ข้อมูลส่วนตัว</h2>

          <div className="space-y-4">
            {/* Name */}
            <div className="flex items-start gap-4">
              <User className="w-5 h-5 text-slate-400 mt-1" />
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">ชื่อ</p>
                <p className="text-base font-medium text-slate-900">{displayUser?.name || "—"}</p>
              </div>
            </div>

            {/* Email */}
            <div className="flex items-start gap-4">
              <Mail className="w-5 h-5 text-slate-400 mt-1" />
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">อีเมล</p>
                <p className="text-base font-medium text-slate-900">{displayUser?.email || "—"}</p>
              </div>
            </div>

            {/* Login Method */}
            <div className="flex items-start gap-4">
              <div className="w-5 h-5 text-slate-400 mt-1" />
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">วิธีเข้าสู่ระบบ</p>
                <p className="text-base font-medium text-slate-900">
                  {displayUser?.loginMethod ? displayUser.loginMethod.charAt(0).toUpperCase() + displayUser.loginMethod.slice(1) : "—"}
                </p>
              </div>
            </div>

            {/* Role */}
            <div className="flex items-start gap-4">
              <div className="w-5 h-5 text-slate-400 mt-1" />
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">สถานะ</p>
                <Badge className={displayUser?.role === "admin" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}>
                  {displayUser?.role === "admin" ? "Admin" : "User"}
                </Badge>
              </div>
            </div>

            {/* Joined Date */}
            <div className="flex items-start gap-4">
              <Clock className="w-5 h-5 text-slate-400 mt-1" />
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">วันที่สมัครสมาชิก</p>
                <p className="text-base font-medium text-slate-900">
                  {displayUser?.createdAt
                    ? new Date(displayUser.createdAt).toLocaleDateString("th-TH", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })
                    : "—"}
                </p>
              </div>
            </div>

            {/* Last Signed In */}
            {displayUser?.lastSignedIn && (
              <div className="flex items-start gap-4">
                <Clock className="w-5 h-5 text-slate-400 mt-1" />
                <div className="flex-1">
                  <p className="text-sm text-muted-foreground">เข้าสู่ระบบครั้งล่าสุด</p>
                  <p className="text-base font-medium text-slate-900">
                    {new Date(displayUser.lastSignedIn).toLocaleDateString("th-TH", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Wallet & Points Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {/* Wallet Card */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-slate-900">กระเป๋า</h3>
              <Wallet className="w-5 h-5 text-slate-400" />
            </div>

            {walletLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-2">ยอดเงิน</p>
                <p className="text-3xl font-bold text-blue-600 mb-4">
                  ฿{parseFloat(walletData?.balance || "0").toFixed(2)}
                </p>
                <Button
                  variant="outline"
                  onClick={() => navigate("/wallet")}
                  className="w-full"
                >
                  จัดการกระเป๋า
                </Button>
              </>
            )}
          </Card>

          {/* Points Card */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-slate-900">คะแนน</h3>
              <div className="w-5 h-5 text-slate-400">⭐</div>
            </div>

            {pointsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-2">คะแนนทั้งหมด</p>
                <p className="text-3xl font-bold text-amber-600 mb-4">
                  {parseFloat(pointsData?.balance || "0").toFixed(0)}
                </p>
                <Button
                  variant="outline"
                  onClick={() => navigate("/points")}
                  className="w-full"
                >
                  ประวัติคะแนน
                </Button>
              </>
            )}
          </Card>
        </div>

        {/* Quick Links */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Button
            variant="outline"
            onClick={() => navigate("/orders")}
            className="w-full h-auto py-3"
          >
            ดูคำสั่งซื้อ
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/my-library")}
            className="w-full h-auto py-3"
          >
            ชั้นหนังสือ (เต็ม)
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/my-novels")}
            className="w-full h-auto py-3"
          >
            นิยายของฉัน
          </Button>
        </div>

        {/* Bookshelf Section */}
        <div>
          <h2 className="text-2xl font-bold mb-6 text-slate-900">ชั้นหนังสือของฉัน</h2>

          {libraryLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : novelList.length === 0 ? (
            <Card className="p-12 text-center">
              <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-lg text-muted-foreground">ยังไม่มีนิยายในชั้นหนังสือ</p>
              <p className="text-sm text-muted-foreground mt-2">ไปเลือกซื้อนิยายเพื่อเริ่มอ่าน</p>
              <Button onClick={() => navigate("/novels")} className="mt-4">
                ดูนิยายทั้งหมด
              </Button>
            </Card>
          ) : (
            <div className="space-y-3">
              {novelList.map((novel: any) => {
                const episodes = groupedByNovel[novel.id] || [];
                const isExpanded = expandedNovel === novel.id;

                return (
                  <Card key={novel.id} className="overflow-hidden">
                    {/* Novel Header */}
                    <button
                      onClick={() => setExpandedNovel(isExpanded ? null : novel.id)}
                      className="w-full p-4 flex items-center gap-4 hover:bg-slate-50 transition text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate">{novel.title}</h3>
                        <p className="text-sm text-muted-foreground">
                          {novel.author || "ผู้แต่งไม่ระบุ"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {episodes.length} ตอนที่ซื้อแล้ว
                        </p>
                      </div>
                      <div className="text-slate-400">
                        {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </div>
                    </button>

                    {/* Episodes List */}
                    {isExpanded && (
                      <div className="border-t border-slate-200 bg-slate-50 divide-y divide-slate-200">
                        {episodes
                          .sort((a: any, b: any) => compareEpisodes(a.episode, b.episode))
                          .map((item: any) => (
                            <div key={item.episode.id} className="p-4 flex items-center justify-between gap-4 hover:bg-slate-100 transition">
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-slate-900">
                                  {formatEpisodeLabel(item.episode.episodeNumber, item.episode.title)}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  ซื้อเมื่อ {new Date(item.purchasedAt).toLocaleDateString("th-TH")}
                                </p>
                              </div>
                              <div className="flex gap-2 shrink-0">
                                {/* Web-only reader: purchased episodes/packages are always
                                    read at /read/:episodeId - never downloaded as a file. */}
                                <Button
                                  size="sm"
                                  onClick={() => navigate(`/read/${item.episode.id}`)}
                                  className="px-4 py-2 text-xs"
                                >
                                  อ่านตอนนี้
                                </Button>
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
