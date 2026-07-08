import { Link } from "wouter";
import { Heart } from "lucide-react";

export interface NovelCardBadge {
  label: string;
  className: string;
}

interface NovelCardProps {
  id: number | string;
  title: string;
  coverImageUrl?: string | null;
  /** Small label above the title, e.g. the novel title on an episode card. */
  overline?: string | null;
  /** Secondary line below the title, e.g. description or episode title. */
  subtitle?: string | null;
  badges?: NovelCardBadge[];
  /** Above-the-fold cards should load eagerly instead of lazily. */
  eager?: boolean;
  href?: string;
  showWishlist?: boolean;
}

/**
 * Shared novel/episode cover card used across Home, Catalog (NovelsPage), and
 * any other listing that shows a novel's cover + title. Centralizing this
 * fixes the crop problem in one place: covers were previously rendered at a
 * fixed pixel height with `object-cover`, which crops portrait covers and
 * slices text off wide banner-style covers.
 *
 * The cover area uses a blurred, scaled-up copy of the same image as a
 * background (object-cover, purely decorative) with the real image on top
 * at object-contain - so both portrait book covers and landscape banner
 * covers display in full, without ever cropping their text.
 */
export default function NovelCard({
  id,
  title,
  coverImageUrl,
  overline,
  subtitle,
  badges = [],
  eager = false,
  href,
  showWishlist = false,
}: NovelCardProps) {
  const link = href ?? `/novels/${id}`;
  const loading = eager ? "eager" : "lazy";

  return (
    <Link href={link}>
      <div className="group h-full flex flex-col rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 overflow-hidden cursor-pointer">
        <div className="relative aspect-3/4 overflow-hidden bg-slate-100">
          {coverImageUrl ? (
            <>
              {/* Blurred backdrop - fills the frame so portrait AND landscape
                  covers both look intentional, never awkward letterboxing. */}
              <img
                src={coverImageUrl}
                alt=""
                aria-hidden="true"
                loading={loading}
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-30"
              />
              {/* Real cover - object-contain so no text/art is ever cropped. */}
              <img
                src={coverImageUrl}
                alt={title}
                loading={loading}
                decoding="async"
                className="relative z-10 w-full h-full object-contain group-hover:scale-105 transition-transform duration-300"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 px-3">
              <span className="text-xs sm:text-sm font-medium text-slate-400 text-center line-clamp-4">
                {title || "ไม่มีภาพปก"}
              </span>
            </div>
          )}

          {badges.length > 0 && (
            <div className="absolute top-2 right-2 z-20 flex flex-col items-end gap-1">
              {badges.map((badge, idx) => (
                <span
                  key={idx}
                  className={`text-[10px] sm:text-xs px-2 py-0.5 rounded-full font-semibold shadow-sm ${badge.className}`}
                >
                  {badge.label}
                </span>
              ))}
            </div>
          )}

          {showWishlist && (
            <button
              className="absolute top-2 left-2 z-20 p-1.5 rounded-full bg-white/85 hover:bg-white transition"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              aria-label="Add to wishlist"
            >
              <Heart className="w-3.5 h-3.5 text-slate-500 hover:text-red-500" />
            </button>
          )}
        </div>

        <div className="p-3 sm:p-4 flex-1 flex flex-col gap-1">
          {overline && (
            <p className="text-[11px] sm:text-xs text-slate-500 line-clamp-1">{overline}</p>
          )}
          <h3 className="line-clamp-2 text-sm sm:text-base font-semibold leading-snug text-slate-900">
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs text-slate-500 line-clamp-2">{subtitle}</p>
          )}
        </div>
      </div>
    </Link>
  );
}
