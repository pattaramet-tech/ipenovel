import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { BookOpen, Sparkles, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import React from "react";
import { getLoginUrl } from "@/const";

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const { data: sections, isLoading, error } = trpc.home.getSections.useQuery();
  
  // Show error toast if query fails
  React.useEffect(() => {
    if (error) {
      console.error("Failed to load home sections:", error);
      toast.error("Failed to load content. Please refresh the page.");
    }
  }, [error]);

  // Handle error state
  if (error) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Card className="p-8 max-w-md text-center">
          <p className="text-red-600 font-semibold mb-4">Failed to load content</p>
          <p className="text-muted-foreground mb-6">Please refresh the page or try again later.</p>
          <Button onClick={() => window.location.reload()}>Refresh Page</Button>
        </Card>
      </div>
    );
  }

  const popularNovels = sections?.popularNovels || [];
  const newNovels = sections?.newNovels || [];
  const freeNovels = sections?.freeNovels || [];
  const latestEpisodes = sections?.latestEpisodes || [];

  // Episode Card Component for latest episodes
  const EpisodeCard = ({ episode }: any) => {
    if (!episode || !episode.novelId) return null;
    return (
    <Link href={`/novels/${episode.novelId}`}>
      <Card className="overflow-hidden hover:shadow-xl transition-all duration-300 cursor-pointer h-full hover:scale-105 transform rounded-xl border-0">
        <div className="relative bg-gradient-to-br from-slate-200 to-slate-300 h-48 sm:h-56 overflow-hidden">
          {episode.novelCoverImageUrl ? (
            <img
              src={episode.novelCoverImageUrl}
              alt={episode.novelTitle}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-100 to-purple-100">
              <BookOpen className="w-12 h-12 text-slate-400" />
            </div>
          )}
          {episode.isFree && (
            <div className="absolute top-3 right-3 bg-green-500 text-white px-3 py-1 rounded-full text-xs font-semibold">
              {t("home.free")}
            </div>
          )}
        </div>
        <div className="p-4 sm:p-5">
          <p className="text-xs sm:text-sm text-slate-500 mb-1">{episode.novelTitle}</p>
          <h3 className="font-bold text-sm sm:text-base line-clamp-2 text-slate-900 mb-2">
            {t("home.episode")} {episode.episodeNumber}
          </h3>
          <p className="text-xs sm:text-sm text-slate-600 line-clamp-1">
            {episode.episodeTitle}
          </p>
        </div>
      </Card>
    </Link>
  );
  };

  // Novel Card Component for reusability
  const NovelCard = ({ novel, showFreeTag = false }: any) => {
    if (!novel || !novel.id) return null;
    return (
    <Link href={`/novels/${novel.id}`}>
      <Card className="overflow-hidden hover:shadow-xl transition-all duration-300 cursor-pointer h-full hover:scale-105 transform rounded-xl border-0">
        <div className="relative bg-gradient-to-br from-slate-200 to-slate-300 h-48 sm:h-56 overflow-hidden">
          {novel.coverImageUrl ? (
            <img
              src={novel.coverImageUrl}
              alt={novel.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-100 to-purple-100">
              <BookOpen className="w-12 h-12 text-slate-400" />
            </div>
          )}
          {showFreeTag && novel.freeEpisodeCount > 0 && (
            <div className="absolute top-3 right-3 bg-green-500 text-white px-3 py-1 rounded-full text-xs font-semibold">
              {t("home.free")}
            </div>
          )}
        </div>
        <div className="p-4 sm:p-5">
          <h3 className="font-bold text-sm sm:text-base line-clamp-2 text-slate-900 mb-2">
            {novel.title}
          </h3>
          <p className="text-xs sm:text-sm text-slate-600 line-clamp-2">
            {novel.description}
          </p>
        </div>
      </Card>
    </Link>
  );
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Hero Section - Mobile First */}
      <section className="bg-gradient-to-b from-blue-600 via-blue-500 to-blue-600 text-white py-12 sm:py-16 md:py-20 px-4 relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full -mr-20 -mt-20" />
        <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full -ml-16 -mb-16" />

        <div className="max-w-5xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 bg-white/20 px-4 py-2 rounded-full mb-6 text-sm font-semibold backdrop-blur-sm">
            <Sparkles className="w-4 h-4" />
            {t("home.welcomeTag")}
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-4 sm:mb-6 leading-tight">
            {t("home.title")}
          </h1>

          <p className="text-base sm:text-lg md:text-xl text-blue-100 mb-8 sm:mb-10 max-w-2xl mx-auto leading-relaxed">
            {t("home.subtitle")}
          </p>

          {/* CTA Buttons - Mobile Friendly */}
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center items-center">
            <Link href="/novels">
              <Button size="lg" className="w-full sm:w-auto rounded-full bg-white text-blue-600 hover:bg-blue-50 font-semibold">
                <BookOpen className="w-5 h-5 mr-2" />
                {t("home.browse")}
              </Button>
            </Link>
            {isAuthenticated && (
              <Link href="/my-novels">
                <Button 
                  size="lg" 
                  variant="outline" 
                  className="w-full sm:w-auto rounded-full text-white border-white/30 bg-white/10 hover:bg-white/20 font-semibold"
                >
                  <Sparkles className="w-5 h-5 mr-2" />
                  {t("home.myNovels")}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Main Content - Mobile First */}
      <div className="max-w-6xl mx-auto px-4 py-12 sm:py-16 md:py-20">
        {/* Featured Novels Section - Popular */}
        <section className="mb-16 sm:mb-20">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                {t("home.featured")}
              </h2>
              <p className="text-sm text-slate-600 mt-1">{t("home.featuredDesc")}</p>
            </div>
            <Link href="/novels?sort=popular" className="flex-shrink-0">
              <Button 
                variant="outline" 
                className="w-full sm:w-auto rounded-full"
              >
                {t("home.viewAll")}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : popularNovels.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {popularNovels.map((novel: any) => (
                <NovelCard key={novel.id} novel={novel} />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noFeatured")}</p>
            </Card>
          )}
        </section>

        {/* New Releases Section */}
        <section className="mb-16 sm:mb-20">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                {t("home.newReleases")}
              </h2>
              <p className="text-sm text-slate-600 mt-1">{t("home.newReleasesDesc")}</p>
            </div>
            <Link href="/novels?sort=new" className="flex-shrink-0">
              <Button 
                variant="outline" 
                className="w-full sm:w-auto rounded-full"
              >
                {t("home.viewAll")}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : newNovels.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {newNovels.map((novel: any) => (
                <NovelCard key={novel.id} novel={novel} />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noNew")}</p>
            </Card>
          )}
        </section>

        {/* Free Episodes Section */}
        <section className="mb-16 sm:mb-20">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                {t("home.freeEpisodes")}
              </h2>
              <p className="text-sm text-slate-600 mt-1">{t("home.freeEpisodesDesc")}</p>
            </div>
            <Link href="/novels?filter=free&sort=new" className="flex-shrink-0">
              <Button 
                variant="outline" 
                className="w-full sm:w-auto rounded-full"
              >
                {t("home.viewAll")}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : freeNovels.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {freeNovels.map((novel: any) => (
                <NovelCard key={novel.id} novel={novel} showFreeTag={true} />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noFree")}</p>
            </Card>
          )}
        </section>

        {/* Latest Uploaded Episodes Section */}
        <section className="mb-16 sm:mb-20">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                {t("home.latestEpisodes")}
              </h2>
              <p className="text-sm text-slate-600 mt-1">{t("home.latestEpisodesDesc")}</p>
            </div>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : latestEpisodes.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {latestEpisodes.map((episode: any) => (
                <EpisodeCard key={episode.id} episode={episode} />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noEpisodes")}</p>
            </Card>
          )}
        </section>

        {/* CTA Section */}
        <section className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl p-8 sm:p-12 text-center border border-blue-100">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900 mb-4">
            {t("home.ctaTitle")}
          </h2>
          <p className="text-base sm:text-lg text-slate-600 mb-8 max-w-2xl mx-auto">
            {t("home.ctaDescription")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center items-center">
            <Link href="/novels">
              <Button size="lg" className="w-full sm:w-auto rounded-full">
                <BookOpen className="w-5 h-5 mr-2" />
                {t("home.browseAll")}
              </Button>
            </Link>
            {!isAuthenticated && (
              <Button size="lg" variant="outline" className="w-full sm:w-auto rounded-full" asChild>
                <a href={getLoginUrl()}>
                  {t("nav.login")}
                </a>
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
