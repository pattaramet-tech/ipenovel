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
import { BookOpen, Search, Download } from "lucide-react";
import { formatEpisodeLabel, compareEpisodes } from "@/utils/episodeUtils";

export default function NovelDetailPage() {
  const { identifier } = useParams<{ identifier: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [selectedEpisodes, setSelectedEpisodes] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "titleAZ" | "titleZA">("newest");
  const [saleType, setSaleType] = useState<"all" | "file" | "chapter">("all");
  const [purchasingEpisodeId, setPurchasingEpisodeId] = useState<number | null>(null);

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

  const purchaseEpisodeMutation = trpc.reader.purchaseEpisode.useMutation({
    onSuccess: () => {
      toast.success("ซื้อบทสำเร็จ");
      // Reader chapter purchases no longer go through the cart, so only
      // refresh episode/wallet/library state - cart is intentionally left alone.
      utils.novels.episodes.invalidate();
      utils.wallet.getSummary.invalidate();
      utils.myNovels.list.invalidate();
    },
    onError: (error: any) => {
      // Server passes structured codes through verbatim (see server/routers.ts
      // reader.purchaseEpisode) for these specific cases, so match exactly
      // instead of loosely substring-matching human text.
      const errorMsg = (error as any)?.message || "";

      if (errorMsg === "INSUFFICIENT_WALLET_BALANCE") {
        toast.error("ยอดเงินในกระเป๋าไม่พอ กรุณาเติมเงิน", {
          action: {
            label: "เติมเงิน",
            onClick: () => setLocation("/wallet"),
          },
        });
      } else if (errorMsg === "INSUFFICIENT_WALLET_BALANCE_ATOMIC") {
        // Distinct from a real insufficient-balance rejection: this means the
        // atomic debit step itself failed/couldn't be confirmed, not that the
        // user's balance was too low - don't tell them to top up.
        toast.error("ตัดเงินจากกระเป๋าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังพบปัญหาให้ติดต่อแอดมิน");
      } else if (errorMsg === "Already purchased" || errorMsg.includes("ซื้อไปแล้ว") || errorMsg.includes("already")) {
        // Duplicate purchase - refetch episode state and show soft message
        toast.info("คุณซื้อบทนี้แล้ว");
        utils.novels.episodes.invalidate();
      } else if (errorMsg === "INVALID_EPISODE_PRICE") {
        toast.error("ราคาบทนี้ไม่ถูกต้อง กรุณาติดต่อแอดมิน");
      } else if (errorMsg === "INVALID_WALLET_BALANCE") {
        toast.error("ข้อมูลกระเป๋าเงินผิดปกติ กรุณาติดต่อแอดมิน");
      } else {
        toast.error(errorMsg || "Failed to purchase episode");
      }
    },
    onSettled: () => {
      setPurchasingEpisodeId(null);
    },
  });

  const handleBuyNow = (episodeId: number) => {
    setPurchasingEpisodeId(episodeId);
    purchaseEpisodeMutation.mutate(
      { episodeId },
      {
        onSuccess: () => {
          setLocation(`/read/${episodeId}`);
        },
      }
    );
  };

  // IMPORTANT: useMemo MUST be called before any early returns to avoid React Hook Order Violation
  // Filter and sort episodes
  const filteredAndSortedEpisodes = useMemo(() => {
    if (!episodes || !Array.isArray(episodes)) return { freeEpisodes: [], paidEpisodes: [], fileEpisodes: [], readerEpisodes: [] };

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
          // Default: sort by episode number (handles sortOrder, episodeNumber, and id)
          return compareEpisodes(a, b);
      }
    });

    // Split into free and paid with defensive checks
    const freeEpisodes = sorted.filter((ep: any) => ep && ep.isFree === true);
    const paidEpisodes = sorted.filter((ep: any) => ep && ep.isFree !== true);

    // Split by sale type: file (has fileUrl) vs reader (for chapter reading)
    // NOTE: novels.episodes never returns `content`, and only returns `fileUrl`
    // when the requester can already access it (free/purchased/admin) - so
    // unpurchased paid episodes have `content: undefined` and `fileUrl: null`
    // regardless of their real sale type. Classification must use the
    // hasFile/hasContent/saleType metadata the backend computes instead of
    // checking for the presence of the (possibly stripped) fields themselves.
    const fileEpisodes = sorted.filter(
      (ep: any) => ep && (ep.saleType === "file" || ep.hasFile === true)
    );
    const readerEpisodes = sorted.filter(
      (ep: any) => ep && (ep.saleType === "chapter" || (ep.hasContent === true && ep.hasFile !== true))
    );

    return { freeEpisodes, paidEpisodes, fileEpisodes, readerEpisodes };
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

  // Chapter (rayabot / "ขายรายบท") episode card - direct wallet purchase only.
  // Must never use cart/checkbox flow: unpurchased paid chapters are bought
  // via handleBuyNow() -> reader.purchaseEpisode, not cart.add.
  const renderChapterEpisodeCard = (episode: any) => {
    if (!episode || !episode.id) return null;
    // isPurchased must reflect a real purchase record only - never admin
    // access or canRead - so the "unlocked" badge/read button only appears
    // for episodes the user actually paid for.
    const isPurchased = episode.isPurchased === true || episode.hasPurchased === true;
    const isFree = episode.isFree === true;

    return (
      <Card
        key={episode.id}
        className={`p-4 transition-all border border-border ${purchasingEpisodeId === episode.id ? "opacity-60" : ""}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3 mb-1">
              <p className="font-semibold text-sm leading-tight">
                {formatEpisodeLabel(episode.episodeNumber, episode.title || "ไม่มีชื่อ")}
              </p>
              {isFree && (
                <Badge className="shrink-0 text-xs bg-green-100 text-green-700 font-medium">
                  ฟรี
                </Badge>
              )}
              {isPurchased && (
                <Badge className="shrink-0 text-xs bg-blue-100 text-blue-700 font-medium">
                  ปลดล็อกแล้ว
                </Badge>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isFree ? (
              <>
                <button
                  onClick={() => setLocation(`/read/${episode.id}`)}
                  className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition active:bg-blue-800"
                >
                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                  อ่านเดี๋ยวนี้
                </button>
                {episode.fileUrl && (
                  <a
                    href={episode.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-slate-500 text-white hover:bg-slate-600 transition"
                    title="ดาวน์โหลดไฟล์"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                )}
              </>
            ) : isPurchased ? (
              <>
                <button
                  onClick={() => setLocation(`/read/${episode.id}`)}
                  className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition"
                >
                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                  อ่าน
                </button>
                {episode.fileUrl && (
                  <a
                    href={episode.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-slate-500 text-white hover:bg-slate-600 transition"
                    title="ดาวน์โหลดไฟล์"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                )}
              </>
            ) : (
              // Unpurchased paid chapter - direct wallet purchase only, never cart
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                <span className="font-semibold text-sm text-foreground">
                  ฿{episode.price ?? "ไม่ระบุ"}
                </span>
                <button
                  onClick={() => handleBuyNow(episode.id)}
                  disabled={purchasingEpisodeId === episode.id}
                  className="inline-flex items-center justify-center px-4 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60 disabled:cursor-wait"
                  title="ซื้อบทนี้ด้วยเงินในกระเป๋า"
                >
                  {purchasingEpisodeId === episode.id ? "กำลังซื้อ..." : "ซื้อทันที"}
                </button>
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  };

  // File (khai file / "ขายไฟล์") episode card - cart/checkbox flow, unchanged.
  const renderFileEpisodeCard = (episode: any) => {
    if (!episode || !episode.id) return null;
    const inCart = cartItems.some((item: any) => item.episodeId === episode.id);
    // isPurchased must reflect a real purchase record only - never admin
    // access or canRead - so the "unlocked" badge/download link only appears
    // for episodes the user actually paid for.
    const isPurchased = episode.isPurchased === true || episode.hasPurchased === true;
    const isFree = episode.isFree === true;
    const isLoading = addToCartMutation.isPending || removeFromCartMutation.isPending;
    const isSelected = inCart || selectedEpisodes.includes(episode.id);

    return (
      <Card
        key={episode.id}
        role={!isPurchased && !isFree ? "button" : undefined}
        tabIndex={!isPurchased && !isFree ? 0 : undefined}
        aria-pressed={!isPurchased && !isFree ? isSelected : undefined}
        aria-label={!isPurchased && !isFree ? `${isSelected ? "Remove" : "Select"} Episode ${episode.episodeNumber} - ${episode.title}` : undefined}
        onClick={() => {
          if (isFree || isPurchased || isLoading) return;
          handleEpisodeToggle(episode.id, !isSelected);
        }}
        onKeyDown={(e) => {
          if (isFree || isPurchased || isLoading) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleEpisodeToggle(episode.id, !isSelected);
          }
        }}
        className={`p-4 transition-all ${
          !isPurchased && !isFree
            ? "cursor-pointer"
            : "cursor-default"
        } ${
          isSelected && !isFree && !isPurchased
            ? "border-2 border-blue-500 bg-blue-50 dark:bg-blue-950"
            : "border border-border hover:border-slate-400"
        } ${isLoading ? "opacity-60" : ""}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3 mb-1">
              <p className="font-semibold text-sm leading-tight">
                {formatEpisodeLabel(episode.episodeNumber, episode.title || "ไม่มีชื่อ")}
              </p>
              {isFree && (
                <Badge className="shrink-0 text-xs bg-green-100 text-green-700 font-medium">
                  ฟรี
                </Badge>
              )}
              {isPurchased && (
                <Badge className="shrink-0 text-xs bg-blue-100 text-blue-700 font-medium">
                  ปลดล็อกแล้ว
                </Badge>
              )}
            </div>
            {!isFree && !isPurchased && (
              <p className="text-xs text-muted-foreground">
                {isSelected ? "อยู่ในตะกร้าแล้ว" : isLoading ? "กำลังอัปเดต..." : "ต้องการซื้อ?"}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isFree ? (
              <>
                <button
                  onClick={() => setLocation(`/read/${episode.id}`)}
                  className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition active:bg-blue-800"
                >
                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                  อ่านเดี๋ยวนี้
                </button>
                {episode.fileUrl && (
                  <a
                    href={episode.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-slate-500 text-white hover:bg-slate-600 transition"
                    title="ดาวน์โหลดไฟล์"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                )}
              </>
            ) : isPurchased ? (
              <>
                <button
                  onClick={() => setLocation(`/read/${episode.id}`)}
                  className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition"
                >
                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                  อ่าน
                </button>
                {episode.fileUrl && (
                  <a
                    href={episode.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md bg-slate-500 text-white hover:bg-slate-600 transition"
                    title="ดาวน์โหลดไฟล์"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                )}
              </>
            ) : (
              // Unpurchased paid file - cart flow
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                <span className="font-semibold text-sm text-foreground">
                  ฿{episode.price ?? "ไม่ระบุ"}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    try {
                      handleEpisodeToggle(episode.id, !isSelected);
                    } catch (err) {
                      console.error("Error toggling episode:", err);
                      toast.error("Failed to update cart");
                    }
                  }}
                  disabled={isLoading}
                  className={`inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md transition ${
                    isSelected
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  } ${isLoading ? "opacity-60 cursor-wait" : "cursor-pointer"}`}
                  title={isSelected ? "Remove from cart" : "Add to cart"}
                >
                  {isSelected ? "อยู่ในตะกร้า" : "เพิ่มลงตะกร้า"}
                </button>
              </div>
            )}
          </div>
        </div>
      </Card>
    );
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

  const { freeEpisodes, paidEpisodes, fileEpisodes, readerEpisodes } = filteredAndSortedEpisodes;

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl px-4 py-6 md:py-8">
        {/* Back Button */}
        <Button variant="ghost" onClick={() => setLocation("/novels")} className="mb-6 -ml-2 hover:bg-slate-100">
          ← {t("common.back")}
        </Button>

        {/* Novel Header Section */}
        <div className="grid md:grid-cols-3 gap-6 md:gap-8 mb-10">
          {/* Novel Cover and Info */}
          <div className="md:col-span-1">
            {novel?.novel?.coverImageUrl && (
              <img
                src={novel.novel.coverImageUrl}
                alt={novel.novel?.title || "Novel"}
                className="w-full h-auto rounded-lg shadow-md mb-6"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t("novel.author")}</p>
                <p className="text-base font-medium">{novel?.novel?.author || t("novel.unknownAuthor")}</p>
              </div>
              {novel?.categories && Array.isArray(novel.categories) && novel.categories.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("novel.categories")}</p>
                  <div className="flex flex-wrap gap-2">
                    {novel.categories.map((cat: any) => {
                      if (!cat) return null;
                      return (
                        <Badge key={cat} variant="secondary" className="text-xs">
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
            <h1 className="text-3xl md:text-4xl font-bold mb-3">{novel?.novel?.title || "Untitled"}</h1>

            {/* Story status badge */}
            {novel?.novel?.storyStatus && (
              <div className="mb-4">
                <Badge className={`text-xs font-medium ${
                  novel.novel.storyStatus === "finished"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-blue-100 text-blue-700"
                }`}>
                  {novel.novel.storyStatus === "finished" ? "จบแล้ว" : "กำลังดำเนินเรื่อง"}
                </Badge>
              </div>
            )}

            <p className="text-base text-muted-foreground mb-6 leading-relaxed">{novel?.novel?.description || t("novel.noDescription")}</p>

            {/* Episode Stats */}
            <div className="grid grid-cols-3 gap-3 p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1">{t("status.totalEpisodes")}</p>
                <p className="text-2xl font-bold">{episodes?.length || 0}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1">{t("status.freeEpisodes")}</p>
                <p className="text-2xl font-bold text-green-600">{freeEpisodes.length}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1">{t("status.paidEpisodes")}</p>
                <p className="text-2xl font-bold text-blue-600">{paidEpisodes.length}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Episodes Section */}
        <div className="space-y-6">
          {/* Section Header */}
          <div>
            <h2 className="text-2xl font-bold mb-4 px-1">{t("status.episodes")}</h2>

            {/* Sale Type Tabs */}
            <div className="flex gap-2 mb-6 border-b overflow-x-auto">
              <button
                onClick={() => setSaleType("all")}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  saleType === "all"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                ทั้งหมด <span className="ml-1 text-xs font-normal text-muted-foreground">({readerEpisodes.length + fileEpisodes.length})</span>
              </button>
              <button
                onClick={() => setSaleType("chapter")}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  saleType === "chapter"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                ขายรายบท <span className="ml-1 text-xs font-normal text-muted-foreground">({readerEpisodes.length})</span>
              </button>
              {fileEpisodes.length > 0 && (
                <button
                  onClick={() => setSaleType("file")}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    saleType === "file"
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  ขายไฟล์ <span className="ml-1 text-xs font-normal text-muted-foreground">({fileEpisodes.length})</span>
                </button>
              )}
            </div>

            {/* Search and Sort Controls */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-3 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder={t("novel.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-10"
                />
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="px-4 py-2 border border-input rounded-md bg-background text-foreground text-sm font-medium h-10 cursor-pointer"
              >
                <option value="newest">{t("novel.newestFirst")}</option>
                <option value="oldest">{t("novel.oldestFirst")}</option>
                <option value="titleAZ">{t("novel.titleAZ")}</option>
                <option value="titleZA">{t("novel.titleZA")}</option>
              </select>
            </div>
          </div>

          {/* Episodes List */}
          <div className="space-y-6">
            {saleType === "all" && readerEpisodes.length === 0 && fileEpisodes.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-muted-foreground">ไม่มีตอนที่ตรงกับการค้นหา</p>
              </Card>
            ) : saleType === "all" ? (
              <>
                {/* Reader Episodes Section - direct wallet purchase */}
                {readerEpisodes.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-3 text-blue-600">ขายรายบท ({readerEpisodes.length})</h3>
                    <div className="space-y-3">
                      {readerEpisodes.map(renderChapterEpisodeCard)}
                    </div>
                  </div>
                )}
                {/* File Episodes Section - cart/checkbox flow */}
                {fileEpisodes.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-3 text-amber-600">ขายไฟล์ ({fileEpisodes.length})</h3>
                    <div className="space-y-3">
                      {fileEpisodes.map(renderFileEpisodeCard)}
                    </div>
                  </div>
                )}
              </>
            ) : saleType === "chapter" ? (
              // Chapter tab: readerEpisodes only, direct wallet purchase - never cart/checkbox.
              readerEpisodes.length > 0 ? (
                <div className="space-y-3">
                  {readerEpisodes.map(renderChapterEpisodeCard)}
                </div>
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-muted-foreground">ยังไม่มีรายการขายแบบรายบท</p>
                </Card>
              )
            ) : saleType === "file" ? (
              // File tab: fileEpisodes only, cart/checkbox flow unchanged.
              fileEpisodes.length > 0 ? (
                <div className="space-y-3">
                  {fileEpisodes.map(renderFileEpisodeCard)}
                </div>
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-muted-foreground">ยังไม่มีแพ็กขายไฟล์</p>
                </Card>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
