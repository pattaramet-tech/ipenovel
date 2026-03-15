import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { BookOpen, ShoppingCart, Zap } from "lucide-react";
import { Link } from "wouter";

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const { data: novels, isLoading: novelsLoading } = trpc.novels.list.useQuery();
  const { data: banners, isLoading: bannersLoading } = trpc.admin.banners.list.useQuery(undefined, {
    enabled: false, // Disable for now, will implement banner API
  });

  const featuredNovels = novels?.slice(0, 4) || [];
  const newNovels = novels?.slice(4, 8) || [];
  const freeNovels = novels?.filter((n: any) => true).slice(0, 4) || []; // Filter for free episodes

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-700 text-white py-16 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <h1 className="text-5xl font-bold mb-4">Discover Amazing Novels</h1>
          <p className="text-xl text-blue-100 mb-8">
            Read translated novels with flexible payment options and instant access
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/novels">
              <Button size="lg" variant="secondary">
                <BookOpen className="w-5 h-5 mr-2" />
                Browse Novels
              </Button>
            </Link>
            {isAuthenticated && (
              <Link href="/my-novels">
                <Button size="lg" variant="outline" className="text-white border-white hover:bg-white/10">
                  <Zap className="w-5 h-5 mr-2" />
                  My Novels
                </Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Featured Novels */}
        <section className="mb-16">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-3xl font-bold">Featured Novels</h2>
            <Link href="/novels">
              <Button variant="outline">View All</Button>
            </Link>
          </div>
          {novelsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 rounded-lg" />
              ))}
            </div>
          ) : featuredNovels.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {featuredNovels.map((novel: any) => (
                <Link key={novel.id} href={`/novels/${novel.id}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer h-full">
                    {novel.coverImageUrl && (
                      <img
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-full h-40 object-cover"
                      />
                    )}
                    <div className="p-4">
                      <h3 className="font-bold text-sm line-clamp-2">{novel.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1">{novel.author}</p>
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                        {novel.description}
                      </p>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-muted-foreground">
              <p>No featured novels available yet</p>
            </Card>
          )}
        </section>

        {/* New Novels */}
        <section className="mb-16">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-3xl font-bold">New Releases</h2>
            <Link href="/novels">
              <Button variant="outline">View All</Button>
            </Link>
          </div>
          {novelsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 rounded-lg" />
              ))}
            </div>
          ) : newNovels.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {newNovels.map((novel: any) => (
                <Link key={novel.id} href={`/novels/${novel.id}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer h-full">
                    {novel.coverImageUrl && (
                      <img
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-full h-40 object-cover"
                      />
                    )}
                    <div className="p-4">
                      <h3 className="font-bold text-sm line-clamp-2">{novel.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1">{novel.author}</p>
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                        {novel.description}
                      </p>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-muted-foreground">
              <p>No new novels available yet</p>
            </Card>
          )}
        </section>

        {/* Free to Read */}
        <section className="mb-16">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-3xl font-bold">Free to Read</h2>
            <Link href="/novels">
              <Button variant="outline">View All</Button>
            </Link>
          </div>
          {novelsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 rounded-lg" />
              ))}
            </div>
          ) : freeNovels.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {freeNovels.map((novel: any) => (
                <Link key={novel.id} href={`/novels/${novel.id}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer h-full">
                    {novel.coverImageUrl && (
                      <img
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-full h-40 object-cover"
                      />
                    )}
                    <div className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold text-sm line-clamp-2 flex-1">{novel.title}</h3>
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded whitespace-nowrap ml-2">
                          Free
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{novel.author}</p>
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                        {novel.description}
                      </p>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-muted-foreground">
              <p>No free novels available yet</p>
            </Card>
          )}
        </section>

        {/* CTA Section */}
        <section className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-12 text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">Ready to Start Reading?</h2>
          <p className="text-lg text-muted-foreground mb-8">
            Browse our collection of translated novels and find your next favorite read.
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/novels">
              <Button size="lg">
                <BookOpen className="w-5 h-5 mr-2" />
                Browse All Novels
              </Button>
            </Link>
            {!isAuthenticated && (
              <Link href="/auth/login">
                <Button size="lg" variant="outline">
                  Sign In
                </Button>
              </Link>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
