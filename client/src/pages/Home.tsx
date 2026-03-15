import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { BookOpen, ShoppingCart, Zap } from "lucide-react";
import { Link } from "wouter";

export default function Home() {
  const { isAuthenticated } = useAuth();
  const { data: novels } = trpc.novels.list.useQuery();
  const { data: banners } = trpc.admin.banners.list.useQuery();

  const featuredNovels = novels?.slice(0, 3) || [];
  const newNovels = novels?.slice(-3) || [];

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-800 text-white py-20 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <h1 className="text-5xl font-bold mb-4">Discover Amazing Novels</h1>
          <p className="text-xl mb-8 text-blue-100">
            Read translated novels with flexible payment options and instant access
          </p>
          {!isAuthenticated ? (
            <Link href={getLoginUrl()}>
              <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                Get Started
              </Button>
            </Link>
          ) : (
            <Link href="/novels">
              <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                Browse Novels
              </Button>
            </Link>
          )}
        </div>
      </section>

      {/* Banners Section */}
      {banners && banners.length > 0 && (
        <section className="py-12 px-4 bg-muted/30">
          <div className="max-w-6xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {banners.slice(0, 2).map((banner: any) => (
                <Card key={banner.id} className="overflow-hidden hover:shadow-lg transition">
                  {banner.imageUrl && (
                    <img
                      src={banner.imageUrl}
                      alt={banner.title}
                      className="w-full h-48 object-cover"
                    />
                  )}
                  <div className="p-4">
                    <h3 className="font-semibold text-lg">{banner.title}</h3>
                    {banner.description && (
                      <p className="text-sm text-muted-foreground mt-2">
                        {banner.description}
                      </p>
                    )}
                    {banner.linkUrl && (
                      <Button variant="outline" size="sm" className="mt-4">
                        Learn More
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Why Choose Ipenovel */}
      <section className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">Why Choose Ipenovel?</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <Card className="p-6 text-center hover:shadow-lg transition">
              <BookOpen className="w-12 h-12 mx-auto mb-4 text-blue-600" />
              <h3 className="font-semibold text-lg mb-2">Wide Selection</h3>
              <p className="text-muted-foreground">
                Browse thousands of translated novels across multiple genres and categories.
              </p>
            </Card>

            <Card className="p-6 text-center hover:shadow-lg transition">
              <ShoppingCart className="w-12 h-12 mx-auto mb-4 text-blue-600" />
              <h3 className="font-semibold text-lg mb-2">Flexible Payment</h3>
              <p className="text-muted-foreground">
                Pay for individual episodes, use coupons, or redeem points for discounts.
              </p>
            </Card>

            <Card className="p-6 text-center hover:shadow-lg transition">
              <Zap className="w-12 h-12 mx-auto mb-4 text-blue-600" />
              <h3 className="font-semibold text-lg mb-2">Instant Access</h3>
              <p className="text-muted-foreground">
                Get immediate access to purchased episodes and download for offline reading.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* Featured Novels */}
      {featuredNovels.length > 0 && (
        <section className="py-16 px-4 bg-muted/30">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl font-bold mb-8">Featured Novels</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {featuredNovels.map((novel: any) => (
                <Link key={novel.id} href={`/novels/${novel.id}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition cursor-pointer h-full">
                    {novel.coverImageUrl && (
                      <img
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-full h-48 object-cover"
                      />
                    )}
                    <div className="p-4">
                      <h3 className="font-semibold text-lg line-clamp-2">
                        {novel.title}
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        by {novel.author || "Unknown"}
                      </p>
                      <p className="text-sm mt-3 line-clamp-3 text-muted-foreground">
                        {novel.description || "No description available"}
                      </p>
                      <div className="mt-4">
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded capitalize">
                          {novel.status}
                        </span>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* New Novels */}
      {newNovels.length > 0 && (
        <section className="py-16 px-4">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl font-bold mb-8">Latest Novels</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {newNovels.map((novel: any) => (
                <Link key={novel.id} href={`/novels/${novel.id}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition cursor-pointer h-full">
                    {novel.coverImageUrl && (
                      <img
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-full h-48 object-cover"
                      />
                    )}
                    <div className="p-4">
                      <h3 className="font-semibold text-lg line-clamp-2">
                        {novel.title}
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        by {novel.author || "Unknown"}
                      </p>
                      <p className="text-sm mt-3 line-clamp-3 text-muted-foreground">
                        {novel.description || "No description available"}
                      </p>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA Section */}
      <section className="py-16 px-4 bg-blue-600 text-white">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to Start Reading?</h2>
          <p className="text-lg mb-8 text-blue-100">
            Join thousands of readers enjoying translated novels
          </p>
          {!isAuthenticated ? (
            <Link href={getLoginUrl()}>
              <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                Sign In to Browse
              </Button>
            </Link>
          ) : (
            <Link href="/novels">
              <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                Start Browsing
              </Button>
            </Link>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-background border-t py-8 px-4">
        <div className="max-w-6xl mx-auto text-center text-muted-foreground">
          <p>&copy; 2026 Ipenovel. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
