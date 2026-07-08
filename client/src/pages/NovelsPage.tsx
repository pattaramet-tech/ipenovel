"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import NovelCard, { type NovelCardBadge } from "@/components/NovelCard";

const DEBOUNCE_DELAY = 500; // ms
const PAGE_SIZE = 20;

// Mobile-first responsive grid - 2 columns on phones (matches a typical
// novel-reading site layout), scaling up to 5 on wide desktop screens.
const CARD_GRID_CLASSES = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4";

type StoryStatusFilter = "all" | "ongoing" | "finished";
type ContentFilter = "all" | "free";
type SortParam = "new" | "popular";

export default function NovelsPage() {
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  // Parse URL query parameters once and memoize to avoid re-parsing on every render
  const { sortParam, filterParam, storyStatusParam } = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
      sortParam: (urlParams.get("sort") as SortParam | null) || "new",
      filterParam: (urlParams.get("filter") as ContentFilter | null) || "all",
      storyStatusParam: (urlParams.get("storyStatus") as StoryStatusFilter | null) || "all",
    };
  }, []);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1); // Reset to first page when search changes
    }, DEBOUNCE_DELAY);

    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Memoize query input to prevent unnecessary refetches
  const queryInput = useMemo(
    () => ({
      sort: sortParam,
      filter: filterParam,
      storyStatus: storyStatusParam === "all" ? undefined : storyStatusParam,
      search: debouncedSearch || undefined,
      page: currentPage,
      pageSize: PAGE_SIZE,
    }),
    [sortParam, filterParam, storyStatusParam, debouncedSearch, currentPage]
  );

  // Fetch novels using the lightweight browse endpoint
  const { data: novels, isLoading } = trpc.novels.browse.useQuery(queryInput, {
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    gcTime: 10 * 60 * 1000, // Keep cached data for 10 minutes
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
      const params = new URLSearchParams(window.location.search);
      params.set("sort", newSort);
      navigate(`/novels?${params.toString()}`);
      setCurrentPage(1);
    },
    [navigate]
  );

  const handleFilterChange = useCallback(
    (newFilter: ContentFilter) => {
      const params = new URLSearchParams(window.location.search);
      params.set("filter", newFilter);
      navigate(`/novels?${params.toString()}`);
      setCurrentPage(1);
    },
    [navigate]
  );

  const handleStoryStatusChange = useCallback(
    (newStatus: StoryStatusFilter) => {
      const params = new URLSearchParams(window.location.search);
      if (newStatus === "all") {
        params.delete("storyStatus");
      } else {
        params.set("storyStatus", newStatus);
      }
      navigate(`/novels?${params.toString()}`);
      setCurrentPage(1);
    },
    [navigate]
  );

  // Memoize hasNextPage to prevent unnecessary recalculations
  const hasNextPage = useMemo(() => {
    return novels && novels.length === PAGE_SIZE;
  }, [novels]);

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
        {isLoading && currentPage === 1 ? (
          <div className={CARD_GRID_CLASSES}>
            {[...Array(10)].map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-3/4 w-full rounded-2xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : novels && novels.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-600 text-lg">No novels found</p>
          </div>
        ) : (
          <>
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
                    eager={idx < 4}
                  />
                );
              })}
            </div>

            {/* Pagination */}
            <div className="flex justify-center items-center gap-4 mt-8">
              <Button
                variant="outline"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>

              <span className="text-sm text-slate-600">Page {currentPage}</span>

              <Button
                variant="outline"
                disabled={!hasNextPage || isLoading}
                onClick={() => setCurrentPage((p) => p + 1)}
              >
                {isLoading ? "Loading..." : "Next"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
