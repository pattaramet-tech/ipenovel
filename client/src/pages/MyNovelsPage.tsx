import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Download, BookOpen } from "lucide-react";
import { toast } from "sonner";

export default function MyNovelsPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();

  const { data: myNovels, isLoading } = trpc.myNovels.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const handleDownload = (episodeId: number) => {
    // Redirect to centralized download route with auth/authz
    window.location.href = `/api/download/${episodeId}`;
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please sign in to view your novels</p>
            <Button asChild>
              <a href="/login">Sign In</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <h1 className="text-3xl font-bold mb-8">My Novels</h1>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : !myNovels || myNovels.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">You haven't purchased any novels yet</p>
              <Button asChild className="mt-4">
                <a href="/novels">Browse Novels</a>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {myNovels.map((item: any) => (
              <Card key={item.novel.id} className="overflow-hidden">
                <CardHeader className="pb-4 bg-gradient-to-r from-blue-50 to-blue-100">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-xl">{item.novel.title}</CardTitle>
                      <p className="text-sm text-slate-600 mt-1">{item.novel.author || "Unknown Author"}</p>
                    </div>
                    <span className="text-xs px-3 py-1 bg-blue-200 text-blue-800 rounded-full capitalize">
                      {item.novel.status}
                    </span>
                  </div>
                </CardHeader>

                <CardContent className="pt-6">
                  <div className="space-y-3">
                    {item.episodes.map((episode: any) => (
                      <div
                        key={episode.id}
                        className="flex items-center justify-between p-4 bg-slate-50 rounded-lg hover:bg-slate-100 transition"
                      >
                        <div className="flex-1">
                          <p className="font-semibold text-slate-900">
                            Episode {episode.episodeNumber}
                          </p>
                          <p className="text-sm text-slate-600">{episode.title}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            Purchased on{" "}
                            {new Date(episode.purchasedAt).toLocaleDateString()}
                          </p>
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => navigate(`/read/${episode.id}`)}
                          >
                            <BookOpen className="w-4 h-4 mr-2" />
                            Read
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleDownload(episode.id)}
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </Button>
                        </div>
                      </div>
                    ))}
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
