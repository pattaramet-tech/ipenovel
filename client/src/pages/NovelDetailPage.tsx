import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useState } from "react";
import { BookOpen } from "lucide-react";

export default function NovelDetailPage() {
  const { identifier } = useParams<{ identifier: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [selectedEpisodes, setSelectedEpisodes] = useState<number[]>([]);

  // Parse identifier as number (id) or try to find by slug
  const novelId = identifier ? parseInt(identifier, 10) : 0;
  const { data: novel, isLoading: novelLoading, error: novelError } = trpc.novels.detail.useQuery(
    { novelId },
    { enabled: !!novelId }
  );

  const { data: episodes } = trpc.novels.episodes.useQuery(
    { novelId },
    { enabled: !!novelId && !!user }
  );

  const { data: cartData } = trpc.cart.get.useQuery();
  const cartItems = cartData?.items || [];

  const addToCartMutation = trpc.cart.add.useMutation({
    onSuccess: () => {
      // Don't clear selection - keep track of what's in cart
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to add to cart");
    },
  });

  const removeFromCartMutation = trpc.cart.remove.useMutation({
    onSuccess: () => {
      // Cart updated
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to remove from cart");
    },
  });

  // Handle immediate add/remove on checkbox change
  const handleEpisodeToggle = async (episodeId: number, isAdding: boolean) => {
    if (isAdding) {
      // Add to cart
      setSelectedEpisodes((prev) => [...prev, episodeId]);
      addToCartMutation.mutate(
        { episodeId },
        {
          onError: () => {
            // Revert on error
            setSelectedEpisodes((prev) => prev.filter((id) => id !== episodeId));
          },
        }
      );
    } else {
      // Remove from cart - find the cartItemId for this episode
      const cartItem = cartItems.find((item: any) => item.episodeId === episodeId);
      if (cartItem) {
        setSelectedEpisodes((prev) => prev.filter((id) => id !== episodeId));
        removeFromCartMutation.mutate(
          { cartItemId: cartItem.id },
          {
            onError: () => {
              // Revert on error
              setSelectedEpisodes((prev) => [...prev, episodeId]);
            },
          }
        );
      }
    }
  };

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

  if (novelError || !novel) {
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

  const freeEpisodes = episodes?.filter((ep: any) => ep.isFree === true) || [];
  const paidEpisodes = episodes?.filter((ep: any) => ep.isFree !== true) || [];

  return (
    <div className="container py-8">
      <Button variant="ghost" onClick={() => setLocation("/novels")} className="mb-6">
        ← Back to Novels
      </Button>

      <div className="grid md:grid-cols-3 gap-8 mb-12">
        {/* Novel Cover and Info */}
        <div className="md:col-span-1">
          {novel.novel?.coverImageUrl && (
            <img
              src={novel.novel.coverImageUrl}
              alt={novel.novel.title}
              className="w-full h-auto rounded-lg shadow-lg mb-6"
            />
          )}
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-sm text-muted-foreground">Author</h3>
              <p className="text-lg">{novel.novel?.author || "Unknown"}</p>
            </div>
            {novel.categories && novel.categories.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm text-muted-foreground">Categories</h3>
                <div className="flex flex-wrap gap-2 mt-2">
                  {novel.categories.map((cat: any) => (
                    <Badge key={cat} variant="secondary">
                      {cat}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Novel Details */}
        <div className="md:col-span-2">
          <h1 className="text-4xl font-bold mb-4">{novel.novel?.title}</h1>
          <p className="text-lg text-muted-foreground mb-6">{novel.novel?.description}</p>

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
        <h2 className="text-2xl font-bold">Episodes</h2>

        {/* Free Episodes */}
        {freeEpisodes.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-green-600">Free Episodes</h3>
            <div className="space-y-2">
              {freeEpisodes.map((episode: any) => (
                <Card key={episode.id} className="p-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm">
                      Episode {episode.episodeNumber} - {episode.title}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-3 flex-shrink-0">
                    <Badge variant="outline" className="bg-green-50 text-xs">
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
              ))}
            </div>
          </div>
        )}

        {/* Paid Episodes */}
        {paidEpisodes.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-blue-600">Paid Episodes</h3>
            <div className="space-y-2">
              {paidEpisodes.map((episode: any) => {
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
                        Episode {episode.episodeNumber} - {episode.title}
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
                          <p className="font-semibold text-sm whitespace-nowrap">฿{episode.price}</p>
                          <input
                            type="checkbox"
                            checked={selectedEpisodes.includes(episode.id)}
                            onChange={(e) => handleEpisodeToggle(episode.id, e.target.checked)}
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

        {!episodes || episodes.length === 0 && (
          <Card className="p-8 text-center text-muted-foreground">
            No episodes available yet.
          </Card>
        )}
      </div>
    </div>
  );
}
