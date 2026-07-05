import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import { BookOpen, Search } from "lucide-react";

export default function NovelDetailPage() {
  const { identifier } = useParams<{ identifier: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [selectedEpisodes, setSelectedEpisodes] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "titleAZ" | "titleZA">("newest");

  // Parse identifier as number (id) - guard against NaN
  const novelId = identifier ? parseInt(identifier, 10) : 0;
  const validNovelId = Number.isFinite(novelId) && novelId > 0 ? novelId : 0;

  const { data: novel, isLoading: novelLoading, error: novelError } = trpc.novels.detail.useQuery(
    { novelId: validNovelId },
    { enabled: !!validNovelId }
  );

  // Always call episodes query (never conditionally) - gated by validNovelId only
  const { data: episodes } = trpc.novels.episodes.useQuery(
    { novelId: validNovelId },
    { enabled: !!validNovelId }
  );

  // Always call cart query (never conditionally) - gated by user only
  const { data: cartData } = trpc.cart.get.useQuery(undefined, {
    enabled: !!user,
  });
  const cartItems = cartData?.items || [];

  const utils = trpc.useUtils();

  const addToCartMutation = trpc.cart.add.useMutation({
    onSuccess: () => {
      // Invalidate cart query to update badge and cart state
      utils.cart.get.invalidate();
    },
    onError: (error: any) => {
      if (error.code === "UNAUTHORIZED") {
        toast.error("Please log in to add items to cart");
      } else {
        toast.error(error.message || "Failed to add to cart");
      }
    },
  });

  const removeFromCartMutation = trpc.cart.remove.useMutation({
    onSuccess: () => {
      // Invalidate cart query to update badge and cart state
      utils.cart.get.invalidate();
    },
    onError: (error: any) => {
      if (error.code === "UNAUTHORIZED") {
        toast.error("Please log in to manage cart");
      } else {
        toast.error(error.message || "Failed to remove from cart");
      }
    },
  });

  // IMPORTANT: useMemo MUST be called before any early returns to avoid React Hook Order Violation
  // Filter and sort episodes
  const filteredAndSortedEpisodes = useMemo(() => {
    if (!episodes || !Array.isArray(episodes)) return { freeEpisodes: [], paidEpisodes: [] };

    // Search filter (case-insensitive)
    const searchLower = searchTerm.toLowerCase();
    const filtered = episodes.filter((ep: any) => {
      if (!ep) return false;
      const titleMatch = ep.title?.toLowerCase().includes(searchLower) || false;
      const numberMatch = ep.episodeNumber?.toString().includes(searchTerm) || false;
      return titleMatch || numberMatch;
    });

    // Sort with defensive checks
    const sorted = [...filtered].sort((a: any, b: any) => {
      if (!a || !b) return 0;

      switch (sortBy) {
        case "newest":
          try {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
          } catch {
            return 0;
          }
        case "oldest":
          try {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return aTime - bTime;
          } catch {
            return 0;
          }
        case "titleAZ":
          return (a.title || "").localeCompare(b.title || "");
        case "titleZA":
          return (b.title || "").localeCompare(a.title || "");
        default:
          return 0;
      }
    });

    // Split into free and paid with defensive checks
    const freeEpisodes = sorted.filter((ep: any) => ep && ep.isFree === true);
    const paidEpisodes = sorted.filter((ep: any) => ep && ep.isFree !== true);

    return { freeEpisodes, paidEpisodes };
  }, [episodes, searchTerm, sortBy]);

  // Handle immediate add/remove on checkbox change
  const handleEpisodeToggle = async (episodeId: number, isAdding: boolean) => {
    if (!user) {
      toast.error("Please log in to add items to cart");
      return;
    }

    if (isAdding) {
      setSelectedEpisodes((prev) => [...prev, episodeId]);
      addToCartMutation.mutate(
        { episodeId },
        {
          onError: () => {
            setSelectedEpisodes((prev) => prev.filter((id) => id !== episodeId));
          },
        }
      );
    } else {
      const cartItem = cartItems.find((item: any) => item.episodeId === episodeId);
      if (cartItem) {
        setSelectedEpisodes((prev) => prev.filter((id) => id !== episodeId));
        removeFromCartMutation.mutate(
          { cartItemId: cartItem.id },
          {
            onError: () => {
              setSelectedEpisodes((prev) => [...prev, episodeId]);
            },
          }
        );
      }
    }
  };

  // Early returns AFTER all hooks have been called
  if (!validNovelId) {
    return (
      <div className="container py-8">
        <Card className="p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">Novel Not Found</h1>
          <p className="text-muted-foreground mb-6">Invalid novel identifier.</p>
          <Button onClick={() => setLocation("/novels")}>{t("common.back")}</Button>
        </Card>
      </div>
    );
  }

  if (novelLoading) {
    return (
      <div className="container py-8">
        <Skeleton className="h-8 w-1/4 mb-6" />
        <div className="grid md:grid-cols-3 gap-8">
          <div className="md:col-span-1">
            <Skeleton className="w-full h-64 rounded-lg" />
          </div>
          <div className="md:col-span-2 space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      </div>
    );
  }

  // Handle NOT_FOUND error (archived novels return NOT_FOUND from backend)
  const isNotFound = novelError && (novelError as any)?.code === "NOT_FOUND";
  
  if (isNotFound || novelError || !novel || !novel.novel) {
    return (
      <div className="container py-8">
        <Card className="p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">ไม่สามารถดูนิยายเรื่องนี้ได้</h1>
          <p className="text-muted-foreground mb-6">
            นิยายเรื่องนี้ถูกซ่อนหรือไม่พร้อมให้เข้าชมในขณะนี้
          </p>
          <Button onClick={() => setLocation("/novels")}>กลับไปยังรายการนิยาย</Button>
        </Card>
      </div>
    );
  }

  const { freeEpisodes, paidEpisodes } = filteredAndSortedEpisodes;

  return (
    <div className="container py-8">
      <Button variant="ghost" onClick={() => setLocation("/novels")} className="mb-6">
        ← {t("common.back")}
      </Button>

      <div className="grid md:grid-cols-3 gap-8 mb-12">
        {/* Novel Cover and Info */}
        <div className="md:col-span-1">
          {novel?.novel?.coverImageUrl && (
            <img
              src={novel.novel.coverImageUrl}
              alt={novel.novel?.title || "Novel"}
              className="w-full h-auto rounded-lg shadow-lg mb-6"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-sm text-muted-foreground">{t("novel.author")}</h3>
              <p className="text-lg">{novel?.novel?.author || t("novel.unknownAuthor")}</p>
            </div>
            {novel?.categories && Array.isArray(novel.categories) && novel.categories.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm text-muted-foreground">{t("novel.categories")}</h3>
                <div className="flex flex-wrap gap-2 mt-2">
                  {novel.categories.map((cat: any) => {
                    if (!cat) return null;
                    return (
                      <Badge key={cat} variant="secondary">
                        {cat}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Novel Details */}
        <div className="md:col-span-2">
          <h1 className="text-4xl font-bold mb-4">{novel?.novel?.title || "Untitled"}</h1>
          {/* Story status badge */}
          {novel?.novel?.storyStatus && (
            <div className="mb-3">
              <span
                className={`inline-block text-sm px-3 py-1 rounded-full font-medium ${
                  novel.novel.storyStatus === "finished"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-blue-100 text-blue-700"
                }`}
              >
                {novel.novel.storyStatus === "finished" ? "Finished" : "Ongoing"}
              </span>
            </div>
          )}
          <p className="text-lg text-muted-foreground mb-6">{novel?.novel?.description || t("novel.noDescription")}</p>

          {/* Episode Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8 p-4 bg-muted rounded-lg">
            <div>
              <p className="text-sm text-muted-foreground">{t("status.totalEpisodes")}</p>
              <p className="text-2xl font-bold">{episodes?.length || 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("status.freeEpisodes")}</p>
              <p className="text-2xl font-bold text-green-600">{freeEpisodes.length}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("status.paidEpisodes")}</p>
              <p className="text-2xl font-bold text-blue-600">{paidEpisodes.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Episodes Section */}
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold mb-4">{t("status.episodes")}</h2>

          {/* Search and Sort Controls */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t("novel.searchPlaceholder")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm"
            >
              <option value="newest">{t("novel.newestFirst")}</option>
              <option value="oldest">{t("novel.oldestFirst")}</option>
              <option value="titleAZ">{t("novel.titleAZ")}</option>
              <option value="titleZA">{t("novel.titleZA")}</option>
            </select>
          </div>
        </div>

        {/* Free Episodes */}
        {freeEpisodes.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-green-600">{t("status.freeEpisodes")} ({freeEpisodes.length})</h3>
            <div className="space-y-2">
              {freeEpisodes.map((episode: any) => {
                if (!episode || !episode.id) return null;
                return (
                  <Card key={episode.id} className="p-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">
                        Episode {episode.episodeNumber || "?"} - {episode.title || "Untitled"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">
                        {t("status.free")}
                      </Badge>
                      {episode.fileUrl ? (
                        <a
                          href={episode.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center px-2 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition whitespace-nowrap"
                        >
                          <BookOpen className="w-3 h-3 mr-1" />
                          {t("novel.read")}
                        </a>
                      ) : (
                        <Button size="sm" disabled className="text-xs px-2 py-1">
                          <BookOpen className="w-3 h-3 mr-1" />
                          {t("novel.read")}
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Paid Episodes */}
        {paidEpisodes.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-blue-600">{t("status.paidEpisodes")} ({paidEpisodes.length})</h3>
            <div className="space-y-2">
              {paidEpisodes.map((episode: any) => {
                if (!episode || !episode.id) return null;
                const inCart = cartItems.some((item: any) => item.episodeId === episode.id);
                const isPurchased = episode.isPurchased || false;
                const isLoading = addToCartMutation.isPending || removeFromCartMutation.isPending;
                const isSelected = inCart || selectedEpisodes.includes(episode.id);

                return (
                  <Card
                    key={episode.id}
                    role={!isPurchased ? "button" : undefined}
                    tabIndex={!isPurchased ? 0 : undefined}
                    aria-pressed={!isPurchased ? isSelected : undefined}
                    aria-label={!isPurchased ? `${isSelected ? "Remove" : "Select"} Episode ${episode.episodeNumber} - ${episode.title}` : undefined}
                    onClick={() => {
                      if (isPurchased || isLoading) return;
                      handleEpisodeToggle(episode.id, !isSelected);
                    }}
                    onKeyDown={(e) => {
                      if (isPurchased || isLoading) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleEpisodeToggle(episode.id, !isSelected);
                      }
                    }}
                    className={`p-3 flex items-center justify-between transition-all cursor-pointer ${
                      isPurchased
                        ? "cursor-default"
                        : isSelected
                          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-300"
                          : "hover:bg-slate-50"
                    } ${isLoading ? "opacity-60 cursor-wait" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">
                        Episode {episode.episodeNumber || "?"} - {episode.title || "Untitled"}
                      </p>
                      {!isPurchased && (
                        <p className="text-xs text-slate-500 mt-1">
                          {isSelected ? "เลือกไว้ในตะกร้าแล้ว" : isLoading ? "กำลังอัปเดต..." : "กดการ์ดเพื่อเลือกซื้อ"}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 ml-3 flex-shrink-0">
                      {isPurchased ? (
                        episode.fileUrl ? (
                          <a
                            href={episode.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center px-2 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition whitespace-nowrap"
                          >
                            <BookOpen className="w-3 h-3 mr-1" />
                            Read
                          </a>
                        ) : (
                          <Button size="sm" disabled className="text-xs px-2 py-1">
                            <BookOpen className="w-3 h-3 mr-1" />
                            Read
                          </Button>
                        )
                      ) : (
                        <>
                          <p className="font-semibold text-sm whitespace-nowrap">฿{episode.price ?? "N/A"}</p>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              try {
                                handleEpisodeToggle(episode.id, e.target.checked);
                              } catch (err) {
                                console.error("Error toggling episode:", err);
                                toast.error("Failed to update cart");
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            disabled={isLoading}
                            className="w-4 h-4 cursor-pointer"
                          />
                        </>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* No Results */}
        {episodes && episodes.length > 0 && freeEpisodes.length === 0 && paidEpisodes.length === 0 && (
          <Card className="p-8 text-center text-muted-foreground">
            No episodes match your search.
          </Card>
        )}

        {(!episodes || episodes.length === 0) && (
          <Card className="p-8 text-center text-muted-foreground">
            No episodes available yet.
          </Card>
        )}
      </div>
    </div>
  );
}
