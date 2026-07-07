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
import { formatEpisodeLabel } from "@/utils/episodeUtils";

export default function MyLibraryPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [novelFilter, setNovelFilter] = useState<number | undefined>();

  // Fetch all user's purchases and episode/novel data
  const { data: libraryData, isLoading: libraryLoading } = trpc.reader.myLibrary.useQuery(
    { novelId: novelFilter },
    { enabled: !!user }
  );

  // Get all unique novels from library data
  const novelsWithPurchases = useMemo(() => {
    if (!libraryData) return [];
    const novelIds = new Set(libraryData.map((item: any) => item.novel.id));
    return Array.from(novelIds).map((novelId) =>
      libraryData.find((item: any) => item.novel.id === novelId)?.novel
    ).filter(Boolean);
  }, [libraryData]);

  // Filter episodes based on selected novel
  const filteredPurchases = useMemo(() => {
    if (!libraryData) return [];
    if (!novelFilter) return libraryData;
    return libraryData.filter((item: any) => item.novel.id === novelFilter);
  }, [libraryData, novelFilter]);

  // Group by novel for "all novels" view
  const groupedByNovel = useMemo(() => {
    if (!libraryData || novelFilter) return {};
    const grouped: Record<number, any[]> = {};
    libraryData.forEach((item: any) => {
      if (!grouped[item.novel.id]) {
        grouped[item.novel.id] = [];
      }
      grouped[item.novel.id].push(item);
    });
    return grouped;
  }, [libraryData, novelFilter]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
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

        {/* Novel Selection Buttons */}
        {libraryLoading ? (
          <div className="mb-8 space-y-2">
            <Skeleton className="h-10 w-1/3" />
          </div>
        ) : novelsWithPurchases.length > 0 && (
          <div className="mb-8">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={!novelFilter ? "default" : "outline"}
                onClick={() => setNovelFilter(undefined)}
              >
                All Novels ({libraryData?.length || 0})
              </Button>
              {novelsWithPurchases.map((novel: any) => {
                const count = (libraryData || []).filter(
                  (item: any) => item.novel.id === novel.id
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

        {/* Episodes List */}
        {libraryLoading ? (
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
        ) : filteredPurchases.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No episodes for this novel</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {!novelFilter ? (
              // Show all novels with their episodes
              Object.entries(groupedByNovel).map(([novelIdStr, items]: [string, any[]]) => {
                const novelId = parseInt(novelIdStr);
                const novel = novelsWithPurchases.find((n: any) => n.id === novelId);
                if (!novel) return null;

                return (
                  <div key={novelId}>
                    <h3 className="font-semibold text-lg mb-3">{novel.title}</h3>
                    <div className="grid gap-2 mb-6">
                      {items.map((item: any) => (
                        <EpisodeCard
                          key={item.episode.id}
                          item={item}
                          onRead={() => navigate(`/read/${item.episode.id}`)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              // Show episodes for selected novel
              filteredPurchases.map((item: any) => (
                <EpisodeCard
                  key={item.episode.id}
                  item={item}
                  onRead={() => navigate(`/read/${item.episode.id}`)}
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
  item: any;
  onRead: () => void;
}

function EpisodeCard({ item, onRead }: EpisodeCardProps) {
  const { t } = useLanguage();

  return (
    <Card className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h4 className="font-semibold">
            {formatEpisodeLabel(item.episode.episodeNumber, item.episode.title)}
          </h4>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {item.episode.wordCount > 0 && (
              <span className="text-sm text-muted-foreground">
                {item.episode.wordCount} {t("reader.words") || "words"}
              </span>
            )}
            {item.episode.description && (
              <span className="text-sm text-slate-600">{item.episode.description}</span>
            )}
            {!item.episode.isPublished && (
              <Badge variant="outline" className="text-xs bg-yellow-50">
                Draft
              </Badge>
            )}
          </div>
          {item.purchasedAt && (
            <p className="text-xs text-muted-foreground mt-1">
              Purchased: {new Date(item.purchasedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <Button onClick={onRead} className="gap-2 ml-4 shrink-0">
          {t("reader.readNow") || "Read"}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}
