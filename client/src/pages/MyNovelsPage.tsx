import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { BookOpen } from "lucide-react";
import { getLoginUrl } from "@/const";

export default function MyNovelsPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();

  const { data: myNovels, isLoading } = trpc.myNovels.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please sign in to view your novels</p>
            <Button asChild>
              <a href={getLoginUrl()}>Sign In</a>
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
                    </div>
                    <div className="flex gap-2">
                      <span className="text-xs px-3 py-1 bg-blue-200 text-blue-800 rounded-full capitalize">
                        {item.novel.publicationStatus === "published" ? "Published" : "Archived"}
                      </span>
                      <span className="text-xs px-3 py-1 bg-purple-200 text-purple-800 rounded-full capitalize">
                        {item.novel.storyStatus === "finished" ? "Finished" : "Ongoing"}
                      </span>
                    </div>
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
                          {episode.fileUrl ? (
                            <a
                              href={episode.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition"
                            >
                              <BookOpen className="w-4 h-4 mr-2" />
                              Read
                            </a>
                          ) : (
                            <Button size="sm" disabled>
                              <BookOpen className="w-4 h-4 mr-2" />
                              Read (File Not Available)
                            </Button>
                          )}
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
