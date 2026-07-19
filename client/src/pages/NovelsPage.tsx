"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useSearchParams } from "wouter";
import { Search, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { keepPreviousData } from "@tanstack/react-query";
import NovelCard, { type NovelCardBadge } from "@/components/NovelCard";
import { useDocumentHead } from "@/hooks/useDocumentHead";
import { buildCanonicalUrl } from "@/lib/seo";

const NOVELS_LIST_TITLE = "รายการนิยาย | IpeNovel";
// Canonical intentionally omits sort/filter/page query params - they're
// view variants of the same listing, not distinct pages, so every variant
// should point crawlers at the one canonical /novels URL rather than
// fragmenting index weight across ?sort=popular, ?filter=free, etc.
const NOVELS_LIST_CANONICAL = buildCanonicalUrl("/novels");

const DEBOUNCE_DELAY = 500; // ms
const PAGE_SIZE = 20;

// Mobile-first responsive grid - 2 columns on phones (matches a typical
// novel-reading site layout), scaling up to 5 on wide desktop screens.
const CARD_GRID_CLASSES = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4";

type StoryStatusFilter = "all" | "ongoing" | "finished";
type ContentFilter = "all" | "free";
type SortParam = "new" | "popular";

export default function NovelsPage() {
  // wouter's useLocation() only ever returns the pathname, never the query
  // string - reading window.location.search once via useMemo([]) (the old
  // approach) meant sort/filter/storyStatus were captured on first mount and
  // never updated again, so the UI silently drifted out of sync with the URL
  // on every subsequent navigate() call. useSearchParams() is wouter's own
  // hook for this: it's reactive to pushState/replaceState/popstate, and
  // setSearchParams navigates for us - single source of truth for both
  // reading and writing the query string.
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  // Seeded from the URL on first render only (StrictMode/rerenders must not
  // clobber what the user is actively typing) - kept in sync with the URL by
  // the effect below whenever `search` changes from OUTSIDE this input (e.g.
  // browser back/forward), and pushed back to the URL after debouncing.
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("search") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("search") || "");

  const sortParam = (searchParams.get("sort") as SortParam | null) || "new";
  const filterParam = (searchParams.get("filter") as ContentFilter | null) || "all";
  const storyStatusParam = (searchParams.get("storyStatus") as StoryStatusFilter | null) || "all";
  const searchUrlParam = searchParams.get("search") || "";
  // Page lives entirely in the URL (never local React state) so a refresh or
  // a shared /novels?page=3 link reproduces the same page, and browser
  // back/forward moves between pages. Invalid/non-positive values (typed by
  // hand, e.g. ?page=abc or ?page=-1) fall back to page 1 instead of being
  // sent to the server.
  const rawPageParam = searchParams.get("page");
  const parsedPage = rawPageParam ? parseInt(rawPageParam, 10) : 1;
  const currentPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const [pendingWishlistNovelId, setPendingWishlistNovelId] = useState<number | null>(null);

  // Browser back/forward (or any external change to ?search=) must resync
  // the visible input and skip the debounce - only local typing should debounce.
  useEffect(() => {
    setSearchTerm(searchUrlParam);
    setDebouncedSearch(searchUrlParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchUrlParam]);

  // Debounce search input, then reflect it into the URL (and reset to page
  // 1) in a single update - never accumulates duplicate query params since
  // URLSearchParams.set() replaces the existing value.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchTerm === debouncedSearch) return;
      setDebouncedSearch(searchTerm);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        const trimmed = searchTerm.trim();
        if (trimmed) {
          next.set("search", trimmed);
        } else {
          next.delete("search");
        }
        next.delete("page"); // any search change resets to page 1
        return next;
      });
    }, DEBOUNCE_DELAY);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const goToPage = useCallback(
    (page: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (page <= 1) {
          next.delete("page"); // page=1 is the default - keep the URL clean
        } else {
          next.set("page", String(page));
        }
        return next;
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setSearchParams]
  );

  // Memoize query input to prevent unnecessary refetches
  const queryInput = useMemo(
    () => ({
      sort: sortParam,
      filter: filterParam,
      storyStatus: storyStatusParam === "all" ? undefined : storyStatusParam,
      search: debouncedSearch.trim() || undefined,
      page: currentPage,
      pageSize: PAGE_SIZE,
    }),
    [sortParam, filterParam, storyStatusParam, debouncedSearch, currentPage]
  );

  // Fetch novels using the lightweight browse endpoint. placeholderData:
  // keepPreviousData keeps the previous page's results on screen (instead of
  // clearing to an empty/skeleton state) while a new filter/sort/page is
  // fetching - isLoading then only ever means "no data at all yet" (true
  // first load), while isFetching covers every fetch including background
  // refetches, so the two can drive separate UI (full skeleton vs a small
  // inline indicator). react-query's `data` always reflects queryInput (the
  // query key), so it's never the wrong page's data shown as current - the
  // previous page's data is only ever shown labeled as "loading" via isFetching.
  const { data, isLoading, isFetching, isError, error, refetch } = trpc.novels.browse.useQuery(queryInput, {
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    gcTime: 10 * 60 * 1000, // Keep cached data for 10 minutes
    placeholderData: keepPreviousData,
  });
  const novels = data?.items;
  const hasNextPage = data?.hasNextPage ?? false;

  // Wishlist state for the heart button on each card - only fetched for
  // logged-in users, never called for anonymous visitors. Uses the
  // lightweight wishlists.ids (just {id, novelId} pairs) instead of
  // wishlists.list, which enriches every row with a full novel row - this
  // page only ever needs the id/novelId pair to drive the heart icon.
  const { data: wishlistIds } = trpc.wishlists.ids.useQuery(undefined, {
    enabled: !!user,
  });
  const wishlistMap = useMemo(
    () => new Map((wishlistIds ?? []).map((w: any) => [w.novelId, w.id])),
    [wishlistIds]
  );

  const addWishlistMutation = trpc.wishlists.add.useMutation();
  const removeWishlistMutation = trpc.wishlists.remove.useMutation();

  const handleWishlistToggle = useCallback(
    (novelId: number) => {
      if (!user) {
        toast.error("กรุณาเข้าสู่ระบบเพื่อบันทึกอยากอ่าน");
        return;
      }

      const existingWishlistId = wishlistMap.get(novelId);
      setPendingWishlistNovelId(novelId);

      if (existingWishlistId) {
        removeWishlistMutation.mutate(
          { wishlistId: existingWishlistId },
          {
            onSuccess: () => {
              toast.success("ลบออกจากรายการอยากอ่านแล้ว");
              utils.wishlists.ids.invalidate();
            },
            onError: (error: any) => {
              toast.error(error?.message || "ลบออกจากรายการอยากอ่านไม่สำเร็จ");
            },
            onSettled: () => setPendingWishlistNovelId(null),
          }
        );
      } else {
        addWishlistMutation.mutate(
          { novelId },
          {
            onSuccess: () => {
              toast.success("บันทึกอยากอ่านแล้ว");
              utils.wishlists.ids.invalidate();
            },
            onError: (error: any) => {
              // Already saved (e.g. stale map, double-click) - not a real
              // failure, just resync the list instead of an error toast.
              if (error?.data?.code === "CONFLICT") {
                toast.info("เรื่องนี้อยู่ในรายการอยากอ่านแล้ว");
                utils.wishlists.ids.invalidate();
                return;
              }
              toast.error(error?.message || "บันทึกอยากอ่านไม่สำเร็จ");
            },
            onSettled: () => setPendingWishlistNovelId(null),
          }
        );
      }
    },
    [user, wishlistMap, addWishlistMutation, removeWishlistMutation, utils]
  );

  useDocumentHead({
    title: NOVELS_LIST_TITLE,
    canonical: NOVELS_LIST_CANONICAL,
    ogType: "website",
  });

  // Get display title based on current sort/filter
  const getPageTitle = () => {
    if (storyStatusParam === "finished") return "Finished Novels";
    if (storyStatusParam === "ongoing") return "Ongoing Novels";
    if (filterParam === "free") return sortParam === "popular" ? "Popular Free Novels" : "Latest Free Novels";
    return sortParam === "popular" ? "Popular Novels" : "Latest Novels";
  };

  const handleSortChange = useCallback(
    (newSort: SortParam) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("sort", newSort);
        next.delete("page"); // changing sort resets to page 1
        return next;
      });
    },
    [setSearchParams]
  );

  const handleFilterChange = useCallback(
    (newFilter: ContentFilter) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("filter", newFilter);
        next.delete("page"); // changing filter resets to page 1
        return next;
      });
    },
    [setSearchParams]
  );

  const handleStoryStatusChange = useCallback(
    (newStatus: StoryStatusFilter) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (newStatus === "all") {
          next.delete("storyStatus");
        } else {
          next.set("storyStatus", newStatus);
        }
        next.delete("page"); // changing story status resets to page 1
        return next;
      });
    },
    [setSearchParams]
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 py-4 sm:py-6">
        <div className="container mx-auto px-4">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-3 sm:mb-4">{getPageTitle()}</h1>

          {/* Search */}
          <div className="relative w-full sm:max-w-md mb-3">
            <Search className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search novels..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Filter/Sort Controls */}
          <div className="flex flex-wrap gap-2 sm:gap-3">
            {/* Sort */}
            <div className="flex gap-1.5 sm:gap-2">
              <Button
                variant={sortParam === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => handleSortChange("new")}
              >
                Latest
              </Button>
              <Button
                variant={sortParam === "popular" ? "default" : "outline"}
                size="sm"
                onClick={() => handleSortChange("popular")}
              >
                Popular
              </Button>
            </div>

            {/* Content filter */}
            <div className="flex gap-1.5 sm:gap-2">
              <Button
                variant={filterParam === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => handleFilterChange("all")}
              >
                All
              </Button>
              <Button
                variant={filterParam === "free" ? "default" : "outline"}
                size="sm"
                onClick={() => handleFilterChange("free")}
              >
                Free Only
              </Button>
            </div>

            {/* Story status filter */}
            <div className="flex gap-1.5 sm:gap-2">
              <Button
                variant={storyStatusParam === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => handleStoryStatusChange("all")}
              >
                All Status
              </Button>
              <Button
                variant={storyStatusParam === "ongoing" ? "default" : "outline"}
                size="sm"
                onClick={() => handleStoryStatusChange("ongoing")}
                className={storyStatusParam === "ongoing" ? "" : "border-blue-200 text-blue-700 hover:bg-blue-50"}
              >
                Ongoing
              </Button>
              <Button
                variant={storyStatusParam === "finished" ? "default" : "outline"}
                size="sm"
                onClick={() => handleStoryStatusChange("finished")}
                className={
                  storyStatusParam === "finished"
                    ? "bg-purple-600 hover:bg-purple-700 text-white border-0"
                    : "border-purple-200 text-purple-700 hover:bg-purple-50"
                }
              >
                Finished
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 pt-6 sm:pt-8 pb-[calc(3rem+env(safe-area-inset-bottom))]">
        {isLoading ? (
          // True first load only - no cached/placeholder data to show yet.
          <div className={CARD_GRID_CLASSES}>
            {[...Array(10)].map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-3/4 w-full rounded-2xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-12">
            <p className="text-slate-600 text-lg mb-3">
              โหลดรายการนิยายไม่สำเร็จ{error?.message ? `: ${error.message}` : ""}
            </p>
            <Button variant="outline" onClick={() => refetch()}>
              ลองใหม่อีกครั้ง
            </Button>
          </div>
        ) : novels && novels.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-600 text-lg">No novels found</p>
          </div>
        ) : (
          <>
            {/* Small inline indicator while switching filter/sort/page -
                keepPreviousData means the grid below stays populated with
                the previous results instead of flashing empty/skeleton. */}
            {isFetching && (
              <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                กำลังโหลด...
              </div>
            )}
            <div className={CARD_GRID_CLASSES}>
              {novels?.map((novel: any, idx: number) => {
                const badges: NovelCardBadge[] = [
                  {
                    label: novel.storyStatus === "finished" ? "Finished" : "Ongoing",
                    className: novel.storyStatus === "finished" ? "bg-purple-600 text-white" : "bg-blue-600 text-white",
                  },
                ];
                if (novel.freeEpisodeCount > 0) {
                  badges.push({ label: "Free", className: "bg-green-500 text-white" });
                }

                return (
                  <NovelCard
                    key={novel.id}
                    id={novel.id}
                    title={novel.title}
                    coverImageUrl={novel.coverImageUrl}
                    badges={badges}
                    showWishlist
                    isWishlisted={wishlistMap.has(novel.id)}
                    wishlistLoading={pendingWishlistNovelId === novel.id}
                    onWishlistToggle={handleWishlistToggle}
                    eager={idx < 4}
                  />
                );
              })}
            </div>

            {/* Pagination - Previous/Next only (no total page count) since
                the backend deliberately avoids a COUNT(*) query the UI
                doesn't need; hasNextPage comes from the server's limit+1
                fetch-ahead, not a client-side guess. */}
            <nav aria-label="Pagination" className="flex justify-center items-center gap-4 mt-8">
              {/* No aria-label override here - WCAG 2.5.3 (Label in Name)
                  requires the accessible name to contain the visible text,
                  and "Previous"/"Next" are already clear on their own; an
                  aria-label with different text would silently break
                  getByRole/voice-control lookups by "Next" too. */}
              <Button variant="outline" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>
                Previous
              </Button>

              <span className="text-sm text-slate-600" aria-current="page">
                Page {currentPage}
              </span>

              <Button variant="outline" disabled={!hasNextPage || isFetching} onClick={() => goToPage(currentPage + 1)}>
                Next
              </Button>
            </nav>
          </>
        )}
      </div>
    </div>
  );
}
