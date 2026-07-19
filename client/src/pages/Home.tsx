import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Sparkles, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import React, { useMemo } from "react";
import NovelCard from "@/components/NovelCard";
import { useDocumentHead } from "@/hooks/useDocumentHead";
import { buildCanonicalUrl, SITE_NAME } from "@/lib/seo";

// Mobile-first responsive grid used for every novel/episode card section on
// this page - 2 columns on phones (matches a typical novel-reading site
// layout), scaling up to 5 on wide desktop screens.
const CARD_GRID_CLASSES = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4";

const HOME_TITLE = `${SITE_NAME} — นิยายแปลออนไลน์`;
const HOME_DESCRIPTION =
  "อ่านนิยายแปลออนไลน์ นิยายแฟนฟิค นิยายกีฬา นิยายอนิเมะ และนิยายยอดนิยมบน IpeNovel";
const HOME_CANONICAL = buildCanonicalUrl("/");

// Banner Carousel - module-level (not defined inside Home) so it isn't
// re-created as a brand-new component type on every Home render. Previously
// nested inside Home(), this remounted (tearing down and restarting its own
// currentIndex state + setInterval) every single time Home re-rendered for
// any reason - e.g. useAuth()'s user resolving - not just when banners data
// actually changed.
function BannerCarousel({ banners, learnMoreLabel }: { banners: any[]; learnMoreLabel: string }) {
  const [currentIndex, setCurrentIndex] = React.useState(0);

  React.useEffect(() => {
    if (banners.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % banners.length);
    }, 5000); // Auto-rotate every 5 seconds
    return () => clearInterval(interval);
  }, [banners.length]);

  if (banners.length === 0) return null;

  const currentBanner = banners[currentIndex];

  return (
    <div className="mb-12 sm:mb-16 md:mb-20">
      <div className="relative w-full h-48 sm:h-64 md:h-80 rounded-xl overflow-hidden group">
        {/* Banner Image */}
        {currentBanner.imageUrl ? (
          <img
            src={currentBanner.imageUrl}
            alt={currentBanner.title}
            // Eager, not lazy: this is the first content block on the page
            // (above the fold) and the page's LCP candidate, so lazy-loading
            // it would delay LCP instead of helping. fetchPriority="high" on
            // just this one image tells the browser to prioritize it over
            // every other resource the page requests. decoding="async"
            // still keeps the decode off the main thread without deferring
            // the fetch itself.
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center">
            <Sparkles className="w-16 h-16 text-white/50" />
          </div>
        )}

        {/* Dark overlay for text readability */}
        <div className="absolute inset-0 bg-black/20" />

        {/* Banner Content */}
        <div className="absolute inset-0 flex flex-col justify-end p-4 sm:p-6 md:p-8 text-white">
          <h2 className="text-xl sm:text-2xl md:text-3xl font-bold mb-2 line-clamp-2">
            {currentBanner.title}
          </h2>
          {currentBanner.description && (
            <p className="text-sm sm:text-base text-white/90 mb-4 line-clamp-2">
              {currentBanner.description}
            </p>
          )}
          {currentBanner.linkUrl && (
            <a href={currentBanner.linkUrl} target="_blank" rel="noopener noreferrer">
              <Button className="w-full sm:w-auto rounded-full bg-white text-slate-900 hover:bg-blue-50 font-semibold">
                {learnMoreLabel}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </a>
          )}
        </div>

        {/* Navigation Dots */}
        {banners.length > 1 && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 z-10">
            {banners.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentIndex(index)}
                className={`w-2 h-2 rounded-full transition-all duration-300 ${
                  index === currentIndex ? "bg-white w-6" : "bg-white/50 hover:bg-white/75"
                }`}
                aria-label={`Go to banner ${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Episode Card - latest uploaded episodes, links to the parent novel page.
// Also module-level for the same remount-avoidance reason as BannerCarousel.
function EpisodeCard({ episode, episodeLabel, freeLabel }: { episode: any; episodeLabel: string; freeLabel: string }) {
  if (!episode || !episode.novelId) return null;
  return (
    <NovelCard
      id={episode.novelId}
      title={`${episodeLabel} ${episode.episodeNumber}`}
      coverImageUrl={episode.novelCoverImageUrl}
      overline={episode.novelTitle}
      subtitle={episode.episodeTitle}
      badges={episode.isFree ? [{ label: freeLabel, className: "bg-green-500 text-white" }] : []}
    />
  );
}

// Novel Card - featured/new/free novel sections. Also module-level.
function NovelCardSection({
  novel,
  showFreeTag = false,
  eager = false,
  freeLabel,
}: {
  novel: any;
  showFreeTag?: boolean;
  eager?: boolean;
  freeLabel: string;
}) {
  if (!novel || !novel.id) return null;
  const badges = [];
  if (showFreeTag && novel.freeEpisodeCount > 0) {
    badges.push({ label: freeLabel, className: "bg-green-500 text-white" });
  }
  return (
    <NovelCard
      id={novel.id}
      title={novel.title}
      coverImageUrl={novel.coverImageUrl}
      subtitle={novel.description}
      badges={badges}
      eager={eager}
    />
  );
}

export default function Home() {
  const { user } = useAuth();
  const { t } = useLanguage();
  // Homepage sections (popular/new/free/finished novels, latest episodes,
  // banners) don't need to be second-fresh - a few minutes of staleness is
  // invisible to users and cuts redundant refetches on every window focus.
  // Mirrors the same staleTime/refetchOnWindowFocus pattern already used by
  // the /novels browse query.
  const { data: sections, isLoading, error } = trpc.home.getSections.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const websiteJsonLd = useMemo(
    () => ({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: HOME_CANONICAL,
    }),
    []
  );

  useDocumentHead({
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: HOME_CANONICAL,
    ogType: "website",
    jsonLd: websiteJsonLd,
  });

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

  const banners = sections?.banners || [];
  const popularNovels = sections?.popularNovels || [];
  const newNovels = sections?.newNovels || [];
  const freeNovels = sections?.freeNovels || [];
  const latestEpisodes = sections?.latestEpisodes || [];
  const finishedNovels = sections?.finishedNovels || [];
  const freeLabel = t("home.free");

  return (
    <div className="min-h-screen bg-white">
      {/* Main Content - Mobile First */}
      <div className="max-w-6xl mx-auto px-4 pt-6 sm:pt-8 md:pt-10 pb-[calc(3rem+env(safe-area-inset-bottom))] sm:pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {/* Banners Section */}
        {!isLoading && (
          <BannerCarousel banners={banners} learnMoreLabel={t("home.learnMore") || "Learn More"} />
        )}
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
            <div className={CARD_GRID_CLASSES}>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : popularNovels.length > 0 ? (
            <div className={CARD_GRID_CLASSES}>
              {popularNovels.map((novel: any, idx: number) => (
                <NovelCardSection key={novel.id} novel={novel} eager={idx < 4} freeLabel={freeLabel} />
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
            <div className={CARD_GRID_CLASSES}>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : newNovels.length > 0 ? (
            <div className={CARD_GRID_CLASSES}>
              {newNovels.map((novel: any) => (
                <NovelCardSection key={novel.id} novel={novel} freeLabel={freeLabel} />
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
            <div className={CARD_GRID_CLASSES}>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : freeNovels.length > 0 ? (
            <div className={CARD_GRID_CLASSES}>
              {freeNovels.map((novel: any) => (
                <NovelCardSection key={novel.id} novel={novel} showFreeTag={true} freeLabel={freeLabel} />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noFree")}</p>
            </Card>
          )}
        </section>

        {/* Finished Novels Section */}
        {(isLoading || finishedNovels.length > 0) && (
          <section className="mb-16 sm:mb-20">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
              <div>
                <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                  {t("home.finishedNovels")}
                </h2>
                <p className="text-sm text-slate-600 mt-1">{t("home.finishedDesc")}</p>
              </div>
              <Link href="/novels?storyStatus=finished" className="flex-shrink-0">
                <Button
                  variant="outline"
                  className="w-full sm:w-auto rounded-full border-purple-200 text-purple-700 hover:bg-purple-50"
                >
                  {t("home.viewAllFinished")}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
            </div>

            {isLoading ? (
              <div className={CARD_GRID_CLASSES}>
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
                ))}
              </div>
            ) : (
              <div className={CARD_GRID_CLASSES}>
                {finishedNovels.map((novel: any) => (
                  <NovelCard
                    key={novel.id}
                    id={novel.id}
                    title={novel.title}
                    coverImageUrl={novel.coverImageUrl}
                    subtitle={novel.description}
                    badges={[{ label: t("home.finishedBadge"), className: "bg-purple-600 text-white" }]}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Latest Uploaded Episodes Section - last section on the page, so
            it carries no bottom margin of its own; the page container's own
            bottom padding (see the wrapping div above) provides the
            trailing space instead. */}
        <section>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900">
                {t("home.latestEpisodes")}
              </h2>
              <p className="text-sm text-slate-600 mt-1">{t("home.latestEpisodesDesc")}</p>
            </div>
          </div>

          {isLoading ? (
            <div className={CARD_GRID_CLASSES}>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-64 sm:h-72 rounded-xl" />
              ))}
            </div>
          ) : latestEpisodes.length > 0 ? (
            <div className={CARD_GRID_CLASSES}>
              {latestEpisodes.map((episode: any) => (
                <EpisodeCard
                  key={episode.id}
                  episode={episode}
                  episodeLabel={t("home.episode")}
                  freeLabel={freeLabel}
                />
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-slate-500 rounded-xl border-slate-200">
              <p>{t("home.noEpisodes")}</p>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
