"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Search, Heart, ChevronDown } from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";

const DEBOUNCE_DELAY = 500; // ms
const PAGE_SIZE = 20;

export default function NovelsPage() {
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  // Parse URL query parameters
  const urlParams = new URLSearchParams(window.location.search);
  const sortParam = (urlParams.get("sort") as "new" | "popular" | null) || "new";
  const filterParam = (urlParams.get("filter") as "all" | "free" | null) || "all";

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1); // Reset to first page when search changes
    }, DEBOUNCE_DELAY);

    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Fetch novels using the lightweight browse endpoint
  const { data: novels, isLoading } = trpc.novels.browse.useQuery(
    {
      sort: sortParam,
      filter: filterParam,
      search: debouncedSearch || undefined,
      page: currentPage,
      pageSize: PAGE_SIZE,
    },
    {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    }
  );

  // Get display title based on current sort/filter
  const getPageTitle = () => {
    if (filterParam === "free") {
      return sortParam === "popular" ? "Popular Free Novels" : "Latest Free Novels";
    }
    return sortParam === "popular" ? "Popular Novels" : "Latest Novels";
  };

  const handleSortChange = useCallback(
    (newSort: "new" | "popular") => {
      const params = new URLSearchParams(window.location.search);
      params.set("sort", newSort);
      navigate(`/novels?${params.toString()}`);
      setCurrentPage(1);
    },
    [navigate]
  );

  const handleFilterChange = useCallback(
    (newFilter: "all" | "free") => {
      const params = new URLSearchParams(window.location.search);
      params.set("filter", newFilter);
      navigate(`/novels?${params.toString()}`);
      setCurrentPage(1);
    },
    [navigate]
  );

  const hasNextPage = useMemo(() => {
    return novels && novels.length === PAGE_SIZE;
  }, [novels]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 py-6">
        <div className="container mx-auto px-4">
          <h1 className="text-3xl font-bold text-slate-900 mb-4">{getPageTitle()}</h1>

          {/* Search */}
          <div className="relative max-w-md mb-4">
            <Search className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search novels..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Filter/Sort Controls */}
          <div className="flex flex-wrap gap-2">
            <div className="flex gap-2">
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

            <div className="flex gap-2">
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
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 py-8">
        {isLoading && currentPage === 1 ? (
          <div className="grid md:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-4">
                <Skeleton className="h-48 w-full rounded-lg" />
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
            <div className="grid md:grid-cols-4 gap-6">
              {novels?.map((novel: any) => (
                <Card
                  key={novel.id}
                  className="overflow-hidden hover:shadow-lg transition cursor-pointer group"
                  onClick={() => navigate(`/novels/${novel.id}`)}
                >
                  {novel.coverImageUrl ? (
                    <img
                      src={novel.coverImageUrl}
                      alt={novel.title}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-48 object-cover group-hover:scale-105 transition"
                    />
                  ) : (
                    <div className="w-full h-48 bg-slate-200 flex items-center justify-center">
                      <span className="text-slate-400">No Cover</span>
                    </div>
                  )}
                  <CardContent className="pt-4">
                    <h3 className="font-semibold text-slate-900 line-clamp-2 mb-2">{novel.title}</h3>
                    <div className="flex items-center justify-between">
                      <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded capitalize">
                        {novel.status}
                      </span>
                      {novel.freeEpisodeCount > 0 && (
                        <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded font-semibold">
                          Free
                        </span>
                      )}
                      <button className="p-1 hover:bg-slate-100 rounded transition">
                        <Heart className="w-4 h-4 text-slate-400 hover:text-red-500" />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              ))}
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
