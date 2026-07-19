import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { BookOpen, ChevronDown } from "lucide-react";
import { getLoginUrl } from "@/const";
import { useLanguage } from "@/contexts/LanguageContext";
import { useMemo, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { formatEpisodeLabel } from "@/utils/episodeUtils";
import { useDocumentHead } from "@/hooks/useDocumentHead";

function formatSafeDate(value: unknown) {
  if (!value) return "-";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

function sortByPurchasedAtDesc(a: any, b: any) {
  const aTime = a?.purchasedAt ? new Date(a.purchasedAt).getTime() : 0;
  const bTime = b?.purchasedAt ? new Date(b.purchasedAt).getTime() : 0;
  return bTime - aTime;
}

export default function MyNovelsPage() {
  useDocumentHead({ robots: "noindex,nofollow" });
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();
  const [expandedNovelIds, setExpandedNovelIds] = useState<Set<number>>(new Set());

  const { data: myNovels, isLoading, error } = trpc.myNovels.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  // Data already arrives grouped by novel (one { novel, episodes } entry per
  // owned novel) - this just derives the lightweight summary fields the new
  // overview cards need (item count, most recently purchased item) without
  // touching how ownership/entitlement is fetched.
  const groupedNovels = useMemo(() => {
    if (!Array.isArray(myNovels)) return [];
    return myNovels.map((item: any) => {
      const novel = item?.novel;
      const episodes = Array.isArray(item?.episodes)
        ? [...item.episodes].sort(sortByPurchasedAtDesc)
        : [];
      const latestItem = episodes[0] ?? null;
      return {
        novelId: novel?.id,
        novel,
        episodes,
        itemCount: episodes.length,
        latestItem,
        latestPurchasedAt: latestItem?.purchasedAt ?? null,
      };
    });
  }, [myNovels]);

  const toggleExpanded = (novelId: number) => {
    setExpandedNovelIds((prev) => {
      const next = new Set(prev);
      if (next.has(novelId)) next.delete(novelId);
      else next.add(novelId);
      return next;
    });
  };

  const handleRead = (episodeId?: number) => {
    if (episodeId) setLocation(`/read/${episodeId}`);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">{t("common.pleaseSignIn")}</p>
            <Button asChild>
              <a href={getLoginUrl()}>{t("nav.login")}</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 max-w-3xl">
        <h1 className="text-2xl sm:text-3xl font-bold mb-6 sm:mb-8">{t("nav.myNovels")}</h1>

        {error ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <p className="text-red-600 text-lg mb-4">{t("common.errorOccurred")}</p>
              <Button onClick={() => window.location.reload()}>{t("common.tryAgain")}</Button>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : groupedNovels.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">{t("myNovels.noPurchases")}</p>
              <Button asChild className="mt-4">
                <a href="/novels">{t("nav.browse")}</a>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {groupedNovels.map((group, groupIndex) => {
              const { novel, novelId, episodes, itemCount, latestItem, latestPurchasedAt } = group;
              const novelTitle = novel?.title ?? t("myNovels.untitledNovel");
              const publicationStatus = novel?.publicationStatus ?? "published";
              const storyStatus = novel?.storyStatus ?? "ongoing";
              const isExpanded = novelId != null && expandedNovelIds.has(novelId);
              const key = novelId ?? `novel-${groupIndex}`;

              return (
                <Card key={key} className="border border-slate-200 shadow-sm rounded-xl overflow-hidden">
                  <div className="p-4 flex gap-4">
                    <SafeImage
                      src={novel?.coverImageUrl || undefined}
                      alt={novelTitle}
                      className="w-16 sm:w-20 aspect-3/4 object-cover rounded-lg shrink-0"
                      fallbackClassName="w-16 sm:w-20 aspect-3/4 bg-slate-100 rounded-lg flex items-center justify-center shrink-0"
                    />

                    <div className="flex-1 min-w-0">
                      {/* 1. Title */}
                      <h2 className="font-semibold text-base sm:text-lg text-slate-900 truncate">
                        {novelTitle}
                      </h2>

                      {/* 2. Summary */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs sm:text-sm text-slate-500">
                        <span>{storyStatus === "finished" ? t("myNovels.finished") : t("myNovels.ongoing")}</span>
                        {publicationStatus !== "published" && (
                          <>
                            <span aria-hidden="true">•</span>
                            <span>{t("myNovels.archived")}</span>
                          </>
                        )}
                        <span aria-hidden="true">•</span>
                        <span>{t("myNovels.itemCount").replace("{count}", String(itemCount))}</span>
                      </div>

                      {latestItem && (
                        <p className="text-xs sm:text-sm text-slate-600 mt-1.5 truncate">
                          {t("myNovels.latestLabel")}: {formatEpisodeLabel(latestItem.episodeNumber, latestItem.title)}
                          {latestPurchasedAt && (
                            <span className="text-slate-400"> • {t("myNovels.purchasedOn")} {formatSafeDate(latestPurchasedAt)}</span>
                          )}
                        </p>
                      )}

                      {/* 3. Actions */}
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        {latestItem?.id && (
                          <Button size="sm" onClick={() => handleRead(latestItem.id)}>
                            <BookOpen className="w-4 h-4 mr-1.5" />
                            {latestItem.progressPercent > 0 ? "อ่านต่อ" : t("myNovels.readLatest")}
                          </Button>
                        )}
                        {itemCount > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => novelId != null && toggleExpanded(novelId)}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? t("myNovels.hideItems") : `${t("myNovels.viewItems")} (${itemCount})`}
                            <ChevronDown
                              className={`w-4 h-4 ml-1.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 4. Detail list - collapsed by default */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 divide-y divide-slate-100">
                      {episodes.length === 0 ? (
                        <p className="text-slate-500 text-center py-4 text-sm">{t("myNovels.noEpisodes")}</p>
                      ) : (
                        episodes.map((episode: any, episodeIndex: number) => (
                          <div
                            key={episode?.id || `episode-${groupIndex}-${episodeIndex}`}
                            className="flex items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-slate-900 truncate">
                                {formatEpisodeLabel(episode?.episodeNumber, episode?.title)}
                              </p>
                              <p className="text-xs text-slate-500 mt-0.5">
                                {t("myNovels.purchasedOn")} {formatSafeDate(episode?.purchasedAt)}
                              </p>
                              {episode?.progressPercent > 0 && (
                                <p className="text-xs text-blue-600 mt-0.5">
                                  อ่านล่าสุด
                                  {episode?.currentChapterTitle
                                    ? ` ${episode.currentChapterTitle}`
                                    : episode?.currentChapterNumber
                                      ? ` บทที่ ${episode.currentChapterNumber}`
                                      : ""}
                                  {" "}• {episode.progressPercent}%
                                </p>
                              )}
                            </div>

                            {/* Web-only reader: purchased episodes/packages are always
                                read at /read/:episodeId - never downloaded as a file. */}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRead(episode?.id)}
                              className="shrink-0"
                            >
                              <BookOpen className="w-4 h-4 mr-1.5" />
                              {episode?.progressPercent > 0 ? "อ่านต่อ" : t("myNovels.read")}
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
