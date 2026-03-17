import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
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

  const addToCartMutation = trpc.cart.add.useMutation({
    onSuccess: () => {
      // Don't clear selection - keep track of what's in cart
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
      // Cart updated
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
          <Button onClick={() => setLocation("/novels")}>Back to Novels</Button>
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

  if (novelError || !novel || !novel.novel) {
    return (
      <div className="container py-8">
        <Card className="p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">Novel Not Found</h1>
          <p className="text-muted-foreground mb-6">
            The novel you're looking for doesn't exist or has been removed.
          </p>
          <Button onClick={() => setLocation("/novels")}>Back to Novels</Button>
        </Card>
      </div>
    );
  }

  const { freeEpisodes, paidEpisodes } = filteredAndSortedEpisodes;

  return (
    <div className="container py-8">
      <Button variant="ghost" onClick={() => setLocation("/novels")} className="mb-6">
        ← Back to Novels
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
              <h3 className="font-semibold text-sm text-muted-foreground">Author</h3>
              <p className="text-lg">{novel?.novel?.author || "Unknown"}</p>
            </div>
            {novel?.categories && Array.isArray(novel.categories) && novel.categories.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm text-muted-foreground">Categories</h3>
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
          <p className="text-lg text-muted-foreground mb-6">{novel?.novel?.description || "No description available"}</p>

          {/* Episode Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8 p-4 bg-muted rounded-lg">
            <div>
              <p className="text-sm text-muted-foreground">Total Episodes</p>
              <p className="text-2xl font-bold">{episodes?.length || 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Free Episodes</p>
              <p className="text-2xl font-bold text-green-600">{freeEpisodes.length}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Paid Episodes</p>
              <p className="text-2xl font-bold text-blue-600">{paidEpisodes.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Episodes Section */}
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold mb-4">Episodes</h2>

          {/* Search and Sort Controls */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by title or episode number..."
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
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="titleAZ">Title A-Z</option>
              <option value="titleZA">Title Z-A</option>
            </select>
          </div>
        </div>

        {/* Free Episodes */}
        {freeEpisodes.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-green-600">Free Episodes ({freeEpisodes.length})</h3>
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
                        Free
                      </Badge>
                      {episode.fileUrl ? (
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
            <h3 className="text-lg font-semibold mb-3 text-blue-600">Paid Episodes ({paidEpisodes.length})</h3>
            <div className="space-y-2">
              {paidEpisodes.map((episode: any) => {
                if (!episode || !episode.id) return null;
                const inCart = cartItems.some((item: any) => item.episodeId === episode.id);
                const isPurchased = episode.isPurchased || false;
                const isLoading = addToCartMutation.isPending || removeFromCartMutation.isPending;
                return (
                  <Card
                    key={episode.id}
                    className="p-3 flex items-center justify-between transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">
                        Episode {episode.episodeNumber || "?"} - {episode.title || "Untitled"}
                      </p>
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
                            checked={inCart || selectedEpisodes.includes(episode.id)}
                            onChange={(e) => {
                              try {
                                handleEpisodeToggle(episode.id, e.target.checked);
                              } catch (err) {
                                console.error("Error toggling episode:", err);
                                toast.error("Failed to update cart");
                              }
                            }}
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
