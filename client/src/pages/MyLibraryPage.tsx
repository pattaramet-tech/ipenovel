import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { Loader2, BookOpen, ChevronRight } from "lucide-react";
import { useState, useMemo } from "react";

export default function MyLibraryPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [novelFilter, setNovelFilter] = useState<number | undefined>();

  // Fetch user's purchases and novel data
  const { data: purchasesData, isLoading: purchasesLoading } = trpc.reader.myPurchases.useQuery(
    { novelId: novelFilter || 0 },
    { enabled: !!user && !!novelFilter }
  );

  const { data: allNovels } = trpc.novels.list.useQuery();
  const { data: allEpisodes } = trpc.admin.getAllEpisodes.useQuery();

  // Group purchases by novel
  const purchasedEpisodesByNovel = useMemo(() => {
    if (!purchasesData || !allNovels || !allEpisodes) return {};

    const grouped: Record<number, any[]> = {};

    for (const novelId of Object.keys(grouped)) {
      const numId = parseInt(novelId);
      const episodes = allEpisodes!.filter(
        (ep: any) => ep.novelId === numId && purchasesData.includes(ep.id)
      );
      grouped[numId] = episodes;
    }

    return grouped;
  }, [purchasesData, allEpisodes]);

  // Get all novels with purchases
  const novelsWithPurchases = useMemo(() => {
    if (!allNovels || !purchasesData || !allEpisodes) return [];

    const novelIds = new Set<number>();

    allEpisodes.forEach((ep: any) => {
      if (purchasesData.includes(ep.id)) {
        novelIds.add(ep.novelId);
      }
    });

    return Array.from(novelIds)
      .map((id) => allNovels.find((n: any) => n.id === id))
      .filter(Boolean);
  }, [allNovels, purchasesData, allEpisodes]);

  // Get purchased episodes for current novel
  const purchasedEpisodes = useMemo(() => {
    if (!novelFilter || !purchasesData || !allEpisodes) return [];

    return allEpisodes
      .filter((ep: any) => ep.novelId === novelFilter && purchasesData.includes(ep.id))
      .sort((a: any, b: any) => {
        // Sort by episode number (numeric if possible)
        const aNum = parseInt(a.episodeNumber);
        const bNum = parseInt(b.episodeNumber);
        if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
        return a.episodeNumber.localeCompare(b.episodeNumber);
      });
  }, [novelFilter, purchasesData, allEpisodes]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="p-8 text-center">
          <p className="text-lg text-muted-foreground">Please log in to view your library</p>
          <Button onClick={() => navigate("/auth")} className="mt-4">
            Go to Login
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900">My Library</h1>
          <p className="text-slate-600 mt-2">Episodes you've purchased and can read</p>
        </div>

        {/* Novel Selection */}
        {novelsWithPurchases.length > 0 && (
          <div className="mb-8">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={!novelFilter ? "default" : "outline"}
                onClick={() => setNovelFilter(undefined)}
              >
                All Novels ({novelsWithPurchases.length})
              </Button>
              {novelsWithPurchases.map((novel: any) => {
                const count = (allEpisodes || []).filter(
                  (ep: any) => ep.novelId === novel.id && purchasesData?.includes(ep.id)
                ).length;
                return (
                  <Button
                    key={novel.id}
                    variant={novelFilter === novel.id ? "default" : "outline"}
                    onClick={() => setNovelFilter(novel.id)}
                  >
                    {novel.title} ({count})
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {/* Episodes Grid */}
        {purchasesLoading ? (
          <div className="grid gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-4">
                <Skeleton className="h-6 w-1/2 mb-2" />
                <Skeleton className="h-4 w-1/3" />
              </Card>
            ))}
          </div>
        ) : novelsWithPurchases.length === 0 ? (
          <Card className="p-8 text-center">
            <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-lg text-muted-foreground">No episodes purchased yet</p>
            <Button onClick={() => navigate("/novels")} className="mt-4">
              Browse Novels
            </Button>
          </Card>
        ) : novelFilter && purchasedEpisodes.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No episodes for this novel</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {!novelFilter ? (
              // Show all novels with their episodes
              novelsWithPurchases.map((novel: any) => {
                const episodes = (allEpisodes || []).filter(
                  (ep: any) => ep.novelId === novel.id && purchasesData?.includes(ep.id)
                );
                return (
                  <div key={novel.id}>
                    <h3 className="font-semibold text-lg mb-3">{novel.title}</h3>
                    <div className="grid gap-2 mb-6">
                      {episodes.map((ep: any) => (
                        <EpisodeCard
                          key={ep.id}
                          episode={ep}
                          novelId={novel.id}
                          onRead={() => navigate(`/read/${ep.id}`)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              // Show episodes for selected novel
              purchasedEpisodes.map((ep: any) => (
                <EpisodeCard
                  key={ep.id}
                  episode={ep}
                  novelId={novelFilter}
                  onRead={() => navigate(`/read/${ep.id}`)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface EpisodeCardProps {
  episode: any;
  novelId: number;
  onRead: () => void;
}

function EpisodeCard({ episode, onRead }: EpisodeCardProps) {
  const { t } = useLanguage();
  const wordCount = episode.wordCount || 0;

  return (
    <Card className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h4 className="font-semibold">
            {t("novel.episode")} {episode.episodeNumber}: {episode.title}
          </h4>
          <div className="flex items-center gap-2 mt-2">
            {wordCount > 0 && (
              <span className="text-sm text-muted-foreground">
                {wordCount} {t("reader.words") || "words"}
              </span>
            )}
            {episode.description && (
              <span className="text-sm text-slate-600">{episode.description}</span>
            )}
          </div>
        </div>
        <Button onClick={onRead} className="gap-2">
          {t("reader.readNow") || "Read"}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}
