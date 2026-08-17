import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Construction, X } from "lucide-react";
import { MAINTENANCE_BANNER_CONFIG } from "@/config/maintenanceBanner";
import { getMaintenanceBannerDismissedStorageKey, shouldShowMaintenanceBanner } from "./maintenanceBannerVisibility";

function readDismissed(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(getMaintenanceBannerDismissedStorageKey(id)) === "1";
  } catch {
    // localStorage unavailable (private browsing / quota / disabled) - the
    // banner just can't remember a dismissal across reloads, which is a
    // safe degradation (it never blocks anything either way).
    return false;
  }
}

function writeDismissed(id: string): void {
  try {
    window.localStorage.setItem(getMaintenanceBannerDismissedStorageKey(id), "1");
  } catch {
    // Same safe degradation as readDismissed above.
  }
}

/**
 * CSS custom property (set on the document root) carrying the banner's
 * own currently-rendered height, always kept in sync with reality via a
 * ResizeObserver, and reset to "0px" whenever the banner isn't showing.
 * Lets a page that renders its own fixed/absolute/height:100dvh chrome
 * above its normal content - today only ReaderPage, whose Focus Mode
 * restore button and full-height `.container` were both built assuming
 * nothing renders above them - reserve exactly the right amount of space
 * via a plain `calc(... + var(--maintenance-banner-height, 0px))` in its
 * own CSS/inline styles (see ReaderPage.module.css and ReaderPage.tsx's
 * watermarkTopOffset). Zero coupling in either direction: this component
 * has no idea ReaderPage exists, and ReaderPage needs no new prop, state,
 * or import to consume it - only a CSS variable reference.
 */
export const MAINTENANCE_BANNER_HEIGHT_CSS_VAR = "--maintenance-banner-height";

/**
 * Global, non-blocking maintenance/system-upgrade announcement banner.
 * Reusable and self-contained: every piece of copy, the date range, and
 * the on/off switch live in config/maintenanceBanner.ts (the single
 * source of truth - edit only that file to change any of it); where it
 * renders is decided by shouldShowMaintenanceBanner
 * (maintenanceBannerVisibility.ts); a dismissal is remembered in
 * localStorage, namespaced by the config's `id` so editing the
 * announcement later automatically re-surfaces it. The SAME single
 * instance (mounted once in App.tsx, above the Switch) is what renders on
 * every route, Reader included - so a dismissal on any page dismisses it
 * everywhere, via the one shared localStorage key.
 *
 * Never a modal/overlay - a plain in-flow element with no backdrop, no
 * focus trap, and no interception of clicks anywhere else on the page.
 * Touches no auth/payment/checkout/business logic and no database.
 */
export default function MaintenanceAnnouncementBanner() {
  const [location] = useLocation();
  const [dismissed, setDismissed] = useState(() => readDismissed(MAINTENANCE_BANNER_CONFIG.id));
  const rootRef = useRef<HTMLDivElement | null>(null);

  const visible = !dismissed && shouldShowMaintenanceBanner(location, MAINTENANCE_BANNER_CONFIG.enabled);

  // Hooks run unconditionally (Rules of Hooks) - the early `return null`
  // for the non-visible case stays below, after every hook.
  useEffect(() => {
    if (typeof document === "undefined") return;

    if (!visible) {
      document.documentElement.style.setProperty(MAINTENANCE_BANNER_HEIGHT_CSS_VAR, "0px");
      return;
    }

    const el = rootRef.current;
    if (!el) return;

    // getBoundingClientRect (not entries[0].contentRect, which excludes
    // padding/border) so this matches the banner's actual rendered height,
    // padding included - same measurement approach ReaderPage.tsx already
    // uses for its own header/nav height tracking.
    const updateHeightVar = () => {
      document.documentElement.style.setProperty(MAINTENANCE_BANNER_HEIGHT_CSS_VAR, `${el.getBoundingClientRect().height}px`);
    };
    updateHeightVar();
    const observer = new ResizeObserver(updateHeightVar);
    observer.observe(el);

    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty(MAINTENANCE_BANNER_HEIGHT_CSS_VAR, "0px");
    };
  }, [visible]);

  if (!visible) return null;

  const handleDismiss = () => {
    writeDismissed(MAINTENANCE_BANNER_CONFIG.id);
    setDismissed(true);
  };

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      className="bg-gradient-to-r from-blue-700 via-blue-600 to-sky-500 text-white"
    >
      <div className="container mx-auto px-4 py-3 flex items-start sm:items-center gap-3">
        <Construction className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-200 flex-shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />

        <div className="flex-1 min-w-0 text-sm leading-snug">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-bold">{MAINTENANCE_BANNER_CONFIG.title}</span>
            <span className="inline-flex flex-wrap items-baseline gap-x-1 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs sm:text-sm font-semibold text-blue-900">
              {MAINTENANCE_BANNER_CONFIG.dateRangeLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </div>
          <div className="mt-1 text-blue-50/90 space-y-0.5">
            {MAINTENANCE_BANNER_CONFIG.bodyLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="ปิดประกาศ"
          className="flex-shrink-0 rounded-full p-1.5 text-white/80 hover:text-white hover:bg-white/10 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
