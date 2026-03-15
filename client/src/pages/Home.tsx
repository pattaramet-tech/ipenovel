import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { useLocation } from "wouter";
import { BookOpen, ShoppingCart, Zap } from "lucide-react";

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();

  const { data: novels, isLoading: novelsLoading } = trpc.novels.list.useQuery();
  const { data: banners } = trpc.categories.list.useQuery();
  const { data: pointsData } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-slate-200">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-slate-900">Ipenovel</h1>
          </div>

          <nav className="hidden md:flex items-center gap-6">
            <button onClick={() => navigate("/novels")} className="text-slate-600 hover:text-slate-900 transition">
              Browse
            </button>
            <button onClick={() => navigate("/my-novels")} className="text-slate-600 hover:text-slate-900 transition">
              My Novels
            </button>
            <button onClick={() => navigate("/wishlist")} className="text-slate-600 hover:text-slate-900 transition">
              Wishlist
            </button>
          </nav>

          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <Zap className="w-4 h-4 text-amber-500" />
                  <span className="font-semibold">{pointsData?.balance || "0"} pts</span>
                </div>
                <Button onClick={() => navigate("/cart")} variant="outline" size="sm">
                  <ShoppingCart className="w-4 h-4 mr-2" />
                  Cart
                </Button>
                <Button onClick={() => navigate("/profile")} variant="ghost" size="sm">
                  {user?.name || "Account"}
                </Button>
              </>
            ) : (
              <Button asChild>
                <a href={getLoginUrl()}>Sign In</a>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-800 text-white py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">Discover Amazing Novels</h2>
          <p className="text-xl text-blue-100 mb-8">Read translated novels with flexible payment options and instant access</p>
          <div className="flex gap-4 justify-center">
            <Button asChild size="lg" variant="secondary">
              <a href="/novels">Browse Novels</a>
            </Button>
            {!isAuthenticated && (
              <Button asChild size="lg" variant="outline" className="bg-white text-blue-600 hover:bg-blue-50">
                <a href={getLoginUrl()}>Get Started</a>
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <h3 className="text-3xl font-bold text-center mb-12">Why Choose Ipenovel?</h3>
          <div className="grid md:grid-cols-3 gap-8">
            <Card>
              <CardHeader>
                <BookOpen className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>Wide Selection</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">Browse thousands of translated novels across multiple genres and categories.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <ShoppingCart className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>Flexible Payment</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">Pay for individual episodes, use coupons, or redeem points for discounts.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <Zap className="w-8 h-8 text-blue-600 mb-2" />
                <CardTitle>Instant Access</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-600">Get immediate access to purchased episodes and download for offline reading.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Featured Novels */}
      <section className="py-16 bg-slate-50">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-3xl font-bold">Featured Novels</h3>
            <Button variant="ghost" onClick={() => navigate("/novels")}>
              View All →
            </Button>
          </div>

          {novelsLoading ? (
            <div className="grid md:grid-cols-4 gap-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="space-y-4">
                  <Skeleton className="h-48 w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid md:grid-cols-4 gap-6">
              {novels?.slice(0, 4).map((novel: any) => (
                <Card key={novel.id} className="overflow-hidden hover:shadow-lg transition cursor-pointer" onClick={() => navigate(`/novels/${novel.id}`)}>
                  {novel.coverImageUrl && <img src={novel.coverImageUrl} alt={novel.title} className="w-full h-48 object-cover" />}
                  <CardContent className="pt-4">
                    <h4 className="font-semibold text-slate-900 line-clamp-2">{novel.title}</h4>
                    <p className="text-sm text-slate-600 mt-1">{novel.author || "Unknown Author"}</p>
                    <p className="text-xs text-slate-500 mt-2 capitalize">{novel.status}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-blue-50 border-t border-slate-200">
        <div className="container mx-auto px-4 text-center">
          <h3 className="text-3xl font-bold mb-4">Ready to Start Reading?</h3>
          <p className="text-lg text-slate-600 mb-8">Join thousands of readers enjoying premium translated novels</p>
          {!isAuthenticated ? (
            <Button asChild size="lg">
              <a href={getLoginUrl()}>Sign In Now</a>
            </Button>
          ) : (
            <Button asChild size="lg" onClick={() => navigate("/novels")}>
              <a href="/novels">Browse Novels</a>
            </Button>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-900 text-slate-300 py-8">
        <div className="container mx-auto px-4 text-center">
          <p>&copy; 2026 Ipenovel. All rights reserved.</p>
          <div className="flex gap-6 justify-center mt-4 text-sm">
            <a href="#" className="hover:text-white transition">
              Privacy
            </a>
            <a href="#" className="hover:text-white transition">
              Terms
            </a>
            <a href="#" className="hover:text-white transition">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
