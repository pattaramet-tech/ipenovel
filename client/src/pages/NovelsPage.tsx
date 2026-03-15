import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Search, Heart } from "lucide-react";
import { toast } from "sonner";

export default function NovelsPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");

  const { data: novels, isLoading } = trpc.novels.list.useQuery();

  const filteredNovels = novels?.filter((novel: any) => novel.title.toLowerCase().includes(searchTerm.toLowerCase())) || [];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 py-6">
        <div className="container mx-auto px-4">
          <h1 className="text-3xl font-bold text-slate-900 mb-4">Browse Novels</h1>

          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search novels..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 py-8">
        {isLoading ? (
          <div className="grid md:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-4">
                <Skeleton className="h-48 w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : filteredNovels.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-600 text-lg">No novels found</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-4 gap-6">
            {filteredNovels.map((novel: any) => (
              <Card
                key={novel.id}
                className="overflow-hidden hover:shadow-lg transition cursor-pointer group"
                onClick={() => navigate(`/novels/${novel.id}`)}
              >
                {novel.coverImageUrl ? (
                  <img
                    src={novel.coverImageUrl}
                    alt={novel.title}
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
                    <button className="p-1 hover:bg-slate-100 rounded transition">
                      <Heart className="w-4 h-4 text-slate-400 hover:text-red-500" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
