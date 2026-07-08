import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { BookOpen } from "lucide-react";
import { getLoginUrl } from "@/const";
import { useLanguage } from "@/contexts/LanguageContext";

function formatSafeDate(value: unknown) {
  if (!value) return "-";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

export default function MyNovelsPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();

  const { data: myNovels, isLoading, error } = trpc.myNovels.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

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
      <div className="container mx-auto px-4">
        <h1 className="text-3xl font-bold mb-8">{t("nav.myNovels")}</h1>

        {error ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <p className="text-red-600 text-lg mb-4">{t("common.errorOccurred")}</p>
              <Button onClick={() => window.location.reload()}>{t("common.tryAgain")}</Button>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : !myNovels || myNovels.length === 0 ? (
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
          <div className="space-y-6">
            {myNovels.map((item: any, itemIndex: number) => {
              const novel = item?.novel;
              const novelId = novel?.id;
              const novelTitle = novel?.title ?? t("myNovels.untitledNovel");
              const publicationStatus = novel?.publicationStatus ?? "published";
              const storyStatus = novel?.storyStatus ?? "ongoing";
              const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
              
              return (
                <Card key={novelId || `novel-${itemIndex}`} className="overflow-hidden">
                  <CardHeader className="pb-4 bg-gradient-to-r from-blue-50 to-blue-100">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-xl">{novelTitle}</CardTitle>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-xs px-3 py-1 bg-blue-200 text-blue-800 rounded-full capitalize">
                          {publicationStatus === "published" ? t("myNovels.published") : t("myNovels.archived")}
                        </span>
                        <span className="text-xs px-3 py-1 bg-purple-200 text-purple-800 rounded-full capitalize">
                          {storyStatus === "finished" ? t("myNovels.finished") : t("myNovels.ongoing")}
                        </span>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-6">
                    <div className="space-y-3">
                      {episodes.length === 0 ? (
                        <p className="text-slate-500 text-center py-4">{t("myNovels.noEpisodes")}</p>
                      ) : (
                        episodes.map((episode: any, episodeIndex: number) => (
                          <div
                            key={episode?.id || `episode-${itemIndex}-${episodeIndex}`}
                            className="flex items-center justify-between p-4 bg-slate-50 rounded-lg hover:bg-slate-100 transition"
                          >
                            <div className="flex-1">
                              <p className="font-semibold text-slate-900">
                                {t("common.episode")} {episode?.episodeNumber ?? "?"}
                              </p>
                              <p className="text-sm text-slate-600">{episode?.title ?? ""}</p>
                              <p className="text-xs text-slate-500 mt-1">
                                {t("myNovels.purchasedOn")}{" "}
                                {formatSafeDate(episode?.purchasedAt)}
                              </p>
                            </div>

                            <div className="flex gap-2">
                              {episode?.fileUrl ? (
                                <a
                                  href={episode.fileUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition"
                                >
                                  <BookOpen className="w-4 h-4 mr-2" />
                                  {t("myNovels.read")}
                                </a>
                              ) : (
                                <Button size="sm" disabled>
                                  <BookOpen className="w-4 h-4 mr-2" />
                                  {t("myNovels.readFileNotAvailable")}
                                </Button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
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
