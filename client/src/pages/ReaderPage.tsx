import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useReadingLease } from "@/_core/hooks/useReadingLease";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { MoreVertical, Type, Maximize2, Minimize2 } from "lucide-react";
import styles from "./ReaderPage.module.css";
import { formatEpisodeLabel } from "@/utils/episodeUtils";
import { parsePackageToc, findTocEntryByChapterNumber, type PackageTocEntry } from "@/utils/packageTocUtils";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ReaderSettings from "@/components/ReaderSettings";
import { useReaderPreferences, getFontFamilyStack } from "@/hooks/useReaderPreferences";
import { deriveReaderChromeState } from "./readerChromePresentation";
import {
  createProgressSaveController,
  createResumeVerifier,
  hasResumablePosition,
  mergeResumeSource,
  readReadingRecovery,
  resolveResumeScrollPlan,
  safeLocalStorage,
  writeReadingRecovery,
  type ProgressSaveController,
  type ProgressSaveContext,
  type ReadingPositionSnapshot,
  type ResumeSource,
  type ResumeVerifier,
} from "./readerResumePosition";
import { useDocumentHead } from "@/hooks/useDocumentHead";
import { buildCanonicalUrl, SITE_NAME } from "@/lib/seo";
import { MAINTENANCE_BANNER_HEIGHT_CSS_VAR } from "@/components/MaintenanceAnnouncementBanner";

// How long to wait after the user stops scrolling before saving progress.
const SCROLL_SAVE_DEBOUNCE_MS = 1500;
// Safety-net autosave interval, in case the debounced save above never fires
// (e.g. a long idle period with no further scroll events).
const PERIODIC_SAVE_INTERVAL_MS = 15000;
// Skip re-saving if progress hasn't moved by at least this many percentage
// points and the current chapter hasn't changed - avoids spamming the API
// with near-duplicate saves. (shouldSkipProgressSave additionally requires
// the scrollTop delta to be small, so sub-1% movement on a long package
// still saves - see readerResumePosition.ts.)
const MIN_PERCENT_DELTA_TO_SAVE = 1;
// Throttle for local-recovery writes straight from the scroll handler. The
// localStorage record is the safety net for "app killed before the save
// mutation landed", so it must track scrolling closely - but not on every
// single scroll event.
const LOCAL_RECOVERY_WRITE_THROTTLE_MS = 1000;
// After a resume jump, re-assert the restored position at these delays: the
// resume banner unmounting, web-font swaps and late layout shifts all move
// content under the container for a beat after the initial scroll set.
const RESUME_VERIFY_DELAYS_MS = [120, 400, 1000];
// ...and keep honoring preference-driven re-layouts (font size/family/line
// height changes) within this window after a resume. Past it, the reader
// owns the position again - never yank scroll out from under them.
const RESUME_VERIFY_WINDOW_MS = 2000;

// Utility to generate watermark text
const generateWatermarkText = (user: any, episodeId: number): string => {
  const date = new Date().toLocaleString("th-TH");
  const email = user?.email || "user@ipe.local";
  const userId = user?.id || "unknown";
  return `Ipe นิยายแปล • ${email} • UID: ${userId} • EP: ${episodeId} • ${date}`;
};

const parseMoney = (value: unknown): number => {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
};

const toCents = (value: unknown): number => Math.round(parseMoney(value) * 100);
const formatMoney = (value: unknown): string => parseMoney(value).toFixed(2);

export default function ReaderPage() {
  const { episodeId: episodeIdStr } = useParams<{ episodeId: string }>();
  const episodeId = episodeIdStr ? parseInt(episodeIdStr, 10) : 0;
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data: episodeData, isLoading: dataLoading, error: dataError } = trpc.reader.getEpisode.useQuery(
    { episodeId },
    { enabled: !!episodeId && !!user }
  );

  const purchaseMutation = trpc.reader.purchaseEpisode.useMutation();

  // R2 Reader Session Controls: paid-reading lease lifecycle (30s heartbeat,
  // TTL-only expiry, explicit transfer — never an automatic steal).
  const isPaidEpisode = !!episodeId && !!(episodeData?.episode && !episodeData.episode.isFree);
  const { leaseState, transferLease } = useReadingLease({
    episodeId,
    enabled: !!user && isPaidEpisode,
  });
  const leaseGateCode = (dataError as unknown as { data?: { authGateCode?: string } } | null)?.data?.authGateCode;
  const showTransferCta =
    isPaidEpisode &&
    (leaseState.phase === "held-by-other" ||
      leaseState.phase === "lost" ||
      leaseGateCode === "LEASE_HELD" ||
      leaseGateCode === "LEASE_LOST" ||
      leaseGateCode === "LEASE_REQUIRED");
  const [transferring, setTransferring] = useState(false);
  const doTransferLease = async () => {
    try {
      setTransferring(true);
      await transferLease(episodeId);
      await utils.reader.getEpisode.invalidate({ episodeId });
    } finally {
      setTransferring(false);
    }
  };

  const { preferences: readerPreferences, updatePreference: updateReaderPreference, resetPreferences: resetReaderPreferences } = useReaderPreferences();
  const { fontSize, fontFamily, lineHeight, paragraphSpacing, theme, focusMode } = readerPreferences;
  const readerContentStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight,
    fontFamily: getFontFamilyStack(fontFamily),
    ["--reader-paragraph-spacing" as string]: `${paragraphSpacing}px`,
  };
  const [showReaderSettings, setShowReaderSettings] = useState(false);
  const [showPurchaseConfirm, setShowPurchaseConfirm] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const lastToastTimeRef = useRef<number>(0);

  const episode = episodeData?.episode;
  const novel = episodeData?.novel;
  const previousEpisode = episodeData?.previousEpisode || null;
  const nextEpisode = episodeData?.nextEpisode || null;
  const walletBalance = episodeData?.walletBalance || "0";
  const canRead = episodeData?.canRead || false;
  const isLocked = episodeData?.isLocked || false;
  const content = episodeData?.content || "";
  const preview = episodeData?.preview || "";
  const saleMode = episodeData?.saleMode || "chapter";
  const isPackage = saleMode === "package";
  const walletBalanceCents = toCents(walletBalance);
  const episodePriceCents = toCents(episode?.price);
  const hasEnoughWalletBalance = walletBalanceCents >= episodePriceCents;

  // Edge watermark (top/bottom strips + corner badge) - shown for any
  // readable content (full access or a locked-episode preview), never for
  // the various "no content"/error states where there's nothing to protect.
  const shouldShowWatermark = !!user && !!episodeId && (
    (canRead && !!content) || (isLocked && !!preview)
  );

  // SEO: reader.getEpisode is a protectedProcedure (enabled: !!user above),
  // so an unauthenticated crawler can never see a real chapter here anyway -
  // there's no content for it to index, just a login-gated shell. noindex
  // (not indexed) + follow (still crawl links out of this page, e.g. nav)
  // is the deliberate choice, not a guess - see docs/PERFORMANCE_SEO_AUDIT.md.
  // The description never includes chapter prose, only titles.
  useDocumentHead({
    title:
      episode?.title && novel?.title ? `${episode.title} - ${novel.title} | ${SITE_NAME}` : undefined,
    description:
      episode?.title && novel?.title
        ? `อ่านนิยาย ${novel.title} ตอน ${episode.title} บน ${SITE_NAME}`
        : undefined,
    canonical: episodeId ? buildCanonicalUrl(`/read/${episodeId}`) : undefined,
    robots: "noindex,follow",
  });

  // Measure the header and bottom nav bar so the fixed watermark strips can
  // sit just outside them instead of guessing a fixed pixel offset - both
  // vary in height (title wrapping, translations, safe-area insets). Uses
  // callback refs (state, not useRef) so observation (re)starts whenever the
  // element actually mounts - a plain ref + an empty-deps effect would miss
  // it, since the header/nav are behind the dataLoading skeleton on first
  // mount and don't exist yet when that effect would otherwise run once.
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const [navigationEl, setNavigationEl] = useState<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [navigationHeight, setNavigationHeight] = useState(0);

  useEffect(() => {
    if (!headerEl) return;
    // getBoundingClientRect (not entries[0].contentRect, which excludes
    // padding/border) so this matches the header's actual rendered height -
    // its padding is most of its height.
    const observer = new ResizeObserver(() => {
      setHeaderHeight(headerEl.getBoundingClientRect().height);
    });
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);

  useEffect(() => {
    if (!navigationEl) {
      setNavigationHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => {
      setNavigationHeight(navigationEl.getBoundingClientRect().height);
    });
    observer.observe(navigationEl);
    return () => observer.disconnect();
  }, [navigationEl]);

  // Header/nav padding already bakes in the safe-area insets (see their own
  // CSS), so once measured, the strip just needs to clear that height + a
  // small gap. Before the first measurement (or when the nav bar isn't
  // rendered for packages), fall back to the safe-area inset alone.
  // (Top offset is computed further below, once Focus Mode's chrome state
  // is known - a hidden header must use the safe-area fallback even though
  // its measured height briefly hasn't caught up with the collapse yet.)
  const watermarkBottomOffset = navigationHeight > 0
    ? `${navigationHeight + 4}px`
    : "calc(env(safe-area-inset-bottom) + 4px)";
  const watermarkBadgeBottomOffset = `calc(${watermarkBottomOffset} + 24px)`;

  // ============ Reading progress (resume + package table of contents) ============
  // Only ever queried/saved for episodes the user can actually read - locked
  // episodes have no progress to resume and must not accept a saved position.
  const { data: progressData } = trpc.reader.getProgress.useQuery(
    { episodeId },
    { enabled: !!episodeId && !!user && canRead }
  );
  const saveProgressMutation = trpc.reader.saveProgress.useMutation();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicSaveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingProgressRef = useRef<{
    percent: number;
    scrollTop: number;
    chapterNumber: string | null;
    chapterTitle: string | null;
    anchorId: string | null;
  } | null>(null);
  // Latest-value refs, assigned every render (safe: read only from event
  // handlers / effects / timers, never during render). They let the save
  // controller's dependency closures stay IDENTITY-stable for the whole
  // component lifetime while still seeing fresh values - the mutation
  // result object churns identity on every render, and wiring that into
  // effect/callback deps is what used to tear down a freshly-armed scroll
  // debounce on every setLivePercent re-render.
  const userId = user?.id;
  const episodeIdRef = useRef(episodeId);
  episodeIdRef.current = episodeId;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const canReadRef = useRef(canRead);
  canReadRef.current = canRead;
  const localRecoveryLastWriteRef = useRef(0);
  // Resume restoration state: the chosen source (server vs local recovery)
  // drives the banner, and the verify window re-asserts the restored scroll
  // while layout settles after the banner unmounts.
  const [resumeSource, setResumeSource] = useState<ResumeSource | null>(null);
  const resumeVerifyTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const resumeIntentDetachRef = useRef<(() => void) | null>(null);

  const [showToc, setShowToc] = useState(false);
  const [showReaderMenu, setShowReaderMenu] = useState(false);
  const [livePercent, setLivePercent] = useState(0);
  const [savedIndicatorVisible, setSavedIndicatorVisible] = useState(false);
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const resumeBannerShownRef = useRef(false);
  // Android Chrome can restore a live tab with scrollTop=0, or temporarily
  // unmount this scroller while an expired paid-reading lease is reacquired.
  // Park only the current reader's position, without bypassing lease checks.
  const parkedViewportRef = useRef<{
    episodeId: number;
    userId: string | number;
    position: ReadingPositionSnapshot;
  } | null>(null);
  const viewportContextRef = useRef({ episodeId, userId });
  const [viewportReturnTick, setViewportReturnTick] = useState(0);
  // A gesture is recent only briefly; an earlier tap must not authorize a
  // synthetic scroll(0) emitted while Android suspends the tab minutes later.
  const lastViewportGestureAtRef = useRef(0);
  const explicitTopNavigationRef = useRef(false);

  // ============ Focus Mode (full-screen reading, collapsible header) ============
  // hasReadableContent mirrors the JSX's own "canRead && content" branch
  // below (the only state where there's actual prose to focus on) - locked/
  // purchase-prompt/no-content states must never collapse the header, since
  // its back button and toolbar are the only way out of those.
  const hasReadableContent = canRead && !!content;
  // Raw "is anything covering the header" flag - deliberately exposed here
  // (not just baked into chromeState) because the focus-management effect
  // below needs to distinguish "header visible because Focus Mode is truly
  // off" from "header visible only because an overlay forced it back open",
  // which chromeState.hideHeader alone can't tell apart.
  const overlayOpen = showReaderMenu || showReaderSettings || showToc;
  const chromeState = useMemo(
    () =>
      deriveReaderChromeState({
        focusMode,
        canRead,
        hasReadableContent,
        readerMenuOpen: showReaderMenu,
        readerSettingsOpen: showReaderSettings,
        tocOpen: showToc,
      }),
    [focusMode, canRead, hasReadableContent, showReaderMenu, showReaderSettings, showToc]
  );

  const hideHeaderToggleRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);

  // Native `inert` (not just aria-hidden/pointer-events) so a collapsed
  // header's buttons can never be tabbed to while invisible - the CSS
  // transition below animates max-height/opacity/transform, none of which
  // remove an element from the tab order on their own. Declared BEFORE the
  // focus-management effect below so it commits first within the same
  // render: the header toggle button lives inside headerEl, and focusing a
  // descendant of a still-inert ancestor is a no-op.
  useEffect(() => {
    if (!headerEl) return;
    headerEl.inert = chromeState.hideHeader;
  }, [headerEl, chromeState.hideHeader]);

  const prevFocusModeRef = useRef(focusMode);
  // A focusMode preference flip can happen while its target button isn't
  // actually renderable yet - e.g. turning Focus Mode on from the still-open
  // Settings panel, where the restore button stays suppressed by the
  // overlay until Settings closes. These stay "armed" across renders until
  // the target becomes ready, instead of firing (and missing) once.
  const pendingRestoreFocusRef = useRef(false);
  const pendingHeaderFocusRef = useRef(false);

  // Detects the focusMode PREFERENCE transition itself (never re-arms just
  // because an overlay opened/closed - no focus loop), arms the matching
  // pending flag, then immediately resolves whichever pending flag already
  // has a ready target. Re-runs whenever readiness itself changes
  // (chromeState's two outputs, or overlayOpen closing) so a flag armed
  // while its target wasn't ready yet still gets resolved later, exactly
  // once.
  useEffect(() => {
    if (focusMode !== prevFocusModeRef.current) {
      prevFocusModeRef.current = focusMode;
      if (focusMode) {
        pendingRestoreFocusRef.current = true;
        pendingHeaderFocusRef.current = false;
      } else {
        pendingHeaderFocusRef.current = true;
        pendingRestoreFocusRef.current = false;
      }
    }

    if (pendingRestoreFocusRef.current && chromeState.showRestoreButton) {
      restoreButtonRef.current?.focus();
      pendingRestoreFocusRef.current = false;
    }
    // Never focus the header's toggle button while it's only visible
    // because an overlay forced it back open (Settings/TOC/menu still
    // covering it) - wait for the overlay to actually close first.
    if (pendingHeaderFocusRef.current && !chromeState.hideHeader && !overlayOpen) {
      hideHeaderToggleRef.current?.focus();
      pendingHeaderFocusRef.current = false;
    }
  }, [focusMode, chromeState.showRestoreButton, chromeState.hideHeader, overlayOpen]);

  // Header/nav padding already bakes in the safe-area insets (see their own
  // CSS), so once measured, the strip just needs to clear that height + a
  // small gap. While the header is hidden, its measured height lags a beat
  // behind the CSS collapse transition, so this is keyed off the chrome
  // STATE (not headerHeight) to avoid a jump/flash during that transition.
  // While hidden, the floating restore button (40px, anchored just past the
  // safe-area inset - see .restoreButton) takes the header's old spot, so
  // the watermark strip must clear IT, not just the safe area alone.
  //
  // The existing three-way branch above is untouched - the outer calc()
  // below only ADDS the maintenance announcement banner's own height on
  // top of whichever branch applies (0px when it isn't showing), the same
  // way .restoreButton's own `top` does - see
  // MAINTENANCE_BANNER_HEIGHT_CSS_VAR's doc comment and
  // ReaderPage.module.css's .container/.restoreButton.
  const watermarkTopOffset = `calc(${
    chromeState.hideHeader
      ? "env(safe-area-inset-top) + 58px"
      : headerHeight > 0
        ? `${headerHeight + 4}px`
        : "env(safe-area-inset-top) + 4px"
  } + var(${MAINTENANCE_BANNER_HEIGHT_CSS_VAR}, 0px))`;

  // Package content bundles many chapters into one blob - parse recognizable
  // chapter headings ("บทที่ 12", "ตอนที่ 12", "Chapter 12", "#12") into a
  // jump-to-chapter table of contents. Empty for plain chapters (no headings
  // match), which is fine - the TOC button/drawer just doesn't render then.
  const toc = useMemo(() => (isPackage ? parsePackageToc(content) : []), [isPackage, content]);
  const tocByLineIndex = useMemo(() => new Map(toc.map((entry) => [entry.lineIndex, entry])), [toc]);

  // ==== Progress-save controller + resume verifier wiring ====
  // Both are created ONCE (lazy ref init) with identity-stable dependency
  // closures that read fresh values through the latest-refs above. This is
  // the fix for the mutation-result-identity P1: flushProgressSave below is
  // stable for the component's whole lifetime, so the lifecycle effect never
  // tears down and no re-render (setLivePercent on every scroll burst) can
  // clear a freshly-armed scroll debounce timer.
  const saveMutateRef = useRef(saveProgressMutation.mutate);
  saveMutateRef.current = saveProgressMutation.mutate;

  const progressSaveRef = useRef<ProgressSaveController | null>(null);
  if (!progressSaveRef.current) {
    progressSaveRef.current = createProgressSaveController({
      getContext: (): ProgressSaveContext => ({
        episodeId: episodeIdRef.current,
        userId: userIdRef.current ?? null,
        enabled: !!episodeIdRef.current && !!userIdRef.current && canReadRef.current,
      }),
      getPending: () => pendingProgressRef.current,
      issueSave: (input, handlers) => {
        saveMutateRef.current(input, handlers);
      },
      onAccepted: () => {
        setSavedIndicatorVisible(true);
        setTimeout(() => setSavedIndicatorVisible(false), 2000);
      },
      writeRecovery: (position, context) => {
        if (!context.userId) return;
        writeReadingRecovery(safeLocalStorage(), context.userId, context.episodeId, position);
      },
      minPercentDelta: MIN_PERCENT_DELTA_TO_SAVE,
    });
  }

  const resumeVerifierRef = useRef<ResumeVerifier | null>(null);
  // applyResumeScroll is declared further down (it depends on the parsed
  // TOC); the verifier reaches its LATEST identity through this ref.
  const applyResumeScrollRef = useRef<(target: ReadingPositionSnapshot) => number | null>(() => null);
  if (!resumeVerifierRef.current) {
    resumeVerifierRef.current = createResumeVerifier({
      apply: (target) => applyResumeScrollRef.current(target),
      windowMs: RESUME_VERIFY_WINDOW_MS,
    });
  }

  const flushProgressSave = useCallback((force = false) => {
    progressSaveRef.current?.flush(force);
  }, []);

  const writeLocalRecovery = useCallback((position: ReadingPositionSnapshot) => {
    const uid = userIdRef.current;
    const eid = episodeIdRef.current;
    if (!uid) return;
    writeReadingRecovery(safeLocalStorage(), uid, eid, position);
  }, []);

  const parkReadingViewport = useCallback(() => {
    const uid = userIdRef.current;
    const eid = episodeIdRef.current;
    if (!uid || !eid || !canReadRef.current ||
      viewportContextRef.current.episodeId !== eid ||
      viewportContextRef.current.userId !== uid) return;
    // visibilitychange(hidden), pagehide and beforeunload can arrive in any
    // order. Keep the FIRST valid snapshot for this suspension; DOM offsets
    // observed by later lifecycle callbacks may already be browser-adjusted.
    const existing = parkedViewportRef.current;
    if (existing && existing.episodeId === eid && existing.userId === uid) return;
    const container = scrollContainerRef.current;
    const pending = pendingProgressRef.current;
    const offset = container?.scrollTop ?? 0;
    // Latest genuine scroll data wins over a later layout-adjusted offset.
    const position: ReadingPositionSnapshot | null = pending && pending.scrollTop > 0
      ? { ...pending }
      : container && offset > 0
        ? {
            percent: container.scrollHeight > container.clientHeight
              ? Math.min(100, (offset / (container.scrollHeight - container.clientHeight)) * 100)
              : 0,
            scrollTop: offset,
            chapterNumber: null,
            chapterTitle: null,
            anchorId: null,
          }
        : null;
    if (!position || position.scrollTop <= 0) return;
    parkedViewportRef.current = { episodeId: eid, userId: uid, position };
    lastViewportGestureAtRef.current = 0;
    pendingProgressRef.current = position;
    writeLocalRecovery(position);
  }, [writeLocalRecovery]);

  const markViewportUserIntent = useCallback(() => {
    // A tap may signal that the user wants control, but tapping a tab
    // before Android suspends it must NOT authorize browser scroll(0).
    parkedViewportRef.current = null;
  }, []);

  const markViewportScrollIntent = useCallback(() => {
    markViewportUserIntent();
    lastViewportGestureAtRef.current = Math.max(1, Date.now());
  }, [markViewportUserIntent]);

  const markViewportTopNavigation = useCallback(() => {
    markViewportScrollIntent();
    explicitTopNavigationRef.current = true;
  }, [markViewportScrollIntent]);

  const handleContentScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !canRead || !content) return;
    // Android Chrome emits synthetic scroll events on background/reattach.
    // Do not hide the resume control or overwrite saved progress with zero.
    const parked = parkedViewportRef.current;
    if (document.visibilityState === "hidden" ||
      (parked && parked.episodeId === episodeIdRef.current &&
        parked.userId === userIdRef.current)) return;
    // A synthetic top-of-page event before a background transition must not
    // overwrite the last genuine scroll, even before pagehide gets delivered.
    const hasRecentGesture = lastViewportGestureAtRef.current > 0 &&
      Date.now() - lastViewportGestureAtRef.current <= 750;
    const previousTop = pendingProgressRef.current?.scrollTop ??
      resumeSource?.snapshot.scrollTop ?? progressData?.scrollPosition ?? 0;
    // A large discontinuous jump to zero after a recent tap/swipe can
    // still be Chrome resetting its scroller. Require a continuous
    // scroll-to-top from nearby OR an explicit Home key.
    if (container.scrollTop === 0 && previousTop > 0 &&
      (!hasRecentGesture ||
        (!explicitTopNavigationRef.current &&
          previousTop > Math.max(1200, container.clientHeight * 2)))) return;
    explicitTopNavigationRef.current = false;

    const scrollableHeight = container.scrollHeight - container.clientHeight;
    const percent = scrollableHeight > 0
      ? Math.min(100, Math.max(0, (container.scrollTop / scrollableHeight) * 100))
      : 100;
    setLivePercent(percent);
    // Layout/reflow/Chrome scroll restoration can emit scroll events without
    // human intent. Only actual touch/pointer/wheel/keyboard scrolling
    // dismisses the resume banner, or the explicit "อ่านต่อ" action.
    if (hasRecentGesture) setShowResumeBanner(false);

    let chapterNumber: string | null = null;
    let chapterTitle: string | null = null;
    let anchorId: string | null = null;

    if (toc.length > 0) {
      const headingEls = Array.from(
        container.querySelectorAll<HTMLElement>('[data-toc-anchor="true"]')
      );
      let currentEl: HTMLElement | null = null;
      for (const el of headingEls) {
        if (el.offsetTop <= container.scrollTop + 100) {
          currentEl = el;
        } else {
          break;
        }
      }
      if (currentEl) {
        chapterNumber = currentEl.dataset.chapterNumber || null;
        chapterTitle = currentEl.dataset.chapterTitle || null;
        anchorId = currentEl.id || null;
      }
    }

    pendingProgressRef.current = {
      percent,
      scrollTop: container.scrollTop,
      chapterNumber,
      chapterTitle,
      anchorId,
    };

    // Throttled local-recovery write straight off the scroll event: the
    // debounced API flush only fires 1.5s after scrolling STOPS, and an app
    // switch/app kill inside that gap must not lose the position.
    const now = Date.now();
    // A deliberate return to the beginning is semantically important:
    // persist it immediately even within the normal throttle window, so
    // a fast background transition cannot resurrect an old local position.
    if ((container.scrollTop === 0 && hasRecentGesture) ||
      now - localRecoveryLastWriteRef.current >= LOCAL_RECOVERY_WRITE_THROTTLE_MS) {
      localRecoveryLastWriteRef.current = now;
      writeLocalRecovery(pendingProgressRef.current);
    }

    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(flushProgressSave, SCROLL_SAVE_DEBOUNCE_MS);
  }, [canRead, content, toc, flushProgressSave, writeLocalRecovery, resumeSource, progressData]);

  // Periodic safety-net autosave + lifecycle best-effort saves. Mobile app
  // switches fire visibilitychange->hidden (reliably) and often pagehide,
  // while desktop tab close fires beforeunload/pagehide - all of them force
  // a flush (bypassing the skip gate) AND write local recovery synchronously
  // first, so an app kill before the mutation lands still keeps the position.
  useEffect(() => {
    if (!canRead) return;

    periodicSaveIntervalRef.current = setInterval(flushProgressSave, PERIODIC_SAVE_INTERVAL_MS);
    const handleBeforeUnload = () => {
      parkReadingViewport();
      flushProgressSave(true);
    };
    const handlePageHide = () => {
      parkReadingViewport();
      flushProgressSave(true);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        parkReadingViewport();
        flushProgressSave(true);
      } else {
        setViewportReturnTick((tick) => tick + 1);
      }
    };
    // A tab restored from bfcache can return without a fresh React mount.
    // page lifecycle events only schedule a restore if we had a live
    // viewport parked before the page was suspended.
    const handleReturn = () => setViewportReturnTick((tick) => tick + 1);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handleReturn);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("resume", handleReturn);

    return () => {
      if (periodicSaveIntervalRef.current) clearInterval(periodicSaveIntervalRef.current);
      // The scroll-debounce timer is deliberately NOT cleared here. With
      // flushProgressSave now identity-stable this effect only re-runs when
      // canRead genuinely flips, and a pending debounce must survive that
      // (its position is still flushable once reading resumes). Its teardown
      // lives in the episode/user reset effect instead.
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handleReturn);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("resume", handleReturn);
    };
  }, [canRead, flushProgressSave, parkReadingViewport]);

  // Lease loss can temporarily replace the whole reader DOM. The last real
  // position is parked before the protected view returns, and restored ONLY
  // after the normal canRead + lease gate permits the content again.
  useEffect(() => {
    if (showTransferCta) parkReadingViewport();
  }, [showTransferCta, parkReadingViewport]);

  // If Chrome reattached the scroller at zero, recover the live viewport
  // without requiring a refresh or a second click on "อ่านต่อ". This is
  // deliberately NOT run on a fresh page load (parkedViewportRef is empty).
  useEffect(() => {
    const parked = parkedViewportRef.current;
    if (!parked || !canRead || !content || dataLoading || showTransferCta) return;
    if (parked.episodeId !== episodeId || parked.userId !== userId) return;
    let cancelled = false;
    const restore = (final: boolean) => {
      if (cancelled || document.visibilityState !== "visible" ||
        parkedViewportRef.current !== parked ||
        !canReadRef.current ||
        episodeIdRef.current !== parked.episodeId ||
        userIdRef.current !== parked.userId) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      const saved = parked.position.scrollTop;
      const available = Math.max(0, container.scrollHeight - container.clientHeight);
      const target = Math.min(saved, available);
      const tolerance = Math.min(32, Math.max(2, saved * 0.005));
      if (target > 0 && Math.abs(container.scrollTop - target) > tolerance) {
        container.scrollTop = target;
      }
      // A clamp to the current short layout is NOT a successful restore,
      // even if scrollTop is positive. Recheck again at every bounded pass.
      const recovered = target > 0 && available >= saved - tolerance &&
        Math.abs(container.scrollTop - saved) <= tolerance;
      if (recovered) setLivePercent(parked.position.percent);
      if (final) {
        if (!recovered) {
          // Retain the original full position; never advertise a partial
          // clamp as "read resumed". A visible, explicit fallback remains.
          setResumeSource({ origin: "local", snapshot: parked.position, at: Date.now() });
          setShowResumeBanner(true);
        }
        if (parkedViewportRef.current === parked) parkedViewportRef.current = null;
      }
    };
    const delays = [0, 120, 400, 1000, 1800];
    const timers = delays.map((ms, index) =>
      setTimeout(() => restore(index === delays.length - 1), ms));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [canRead, content, dataLoading, showTransferCta, episodeId, userId, viewportReturnTick]);

  // Merge the server-saved position with this device's local recovery record
  // (newest wins - see mergeResumeSource) into the single resume source the
  // banner and the "อ่านต่อ" button work from. Re-runs when the server
  // answer arrives, so a banner shown from local data while offline
  // corrects itself if the server turns out to be newer.
  useEffect(() => {
    if (!canRead || !episodeId || !userId) {
      setResumeSource(null);
      return;
    }
    const local = readReadingRecovery(safeLocalStorage(), userId, episodeId);
    const merged = mergeResumeSource(progressData, local);
    setResumeSource(merged && hasResumablePosition(merged.snapshot) ? merged : null);
  }, [progressData, canRead, episodeId, userId]);

  // Show the "resume reading" banner once per episode load, if the merged
  // source has anything to resume to (including percent 0 + saved scroll
  // position - legacy rows). The reader must explicitly click "อ่านต่อ" -
  // never auto-jump on load.
  useEffect(() => {
    if (resumeSource && !resumeBannerShownRef.current) {
      setShowResumeBanner(true);
      resumeBannerShownRef.current = true;
    }
  }, [resumeSource]);

  // Episode/user change + unmount. The CLEANUP runs for the outgoing
  // episode/user: it best-effort SAVES their pending position first
  // (dispose() force-flushes with the OLD episodeId/userId baked into this
  // very closure - the latest-refs may already point at the next episode by
  // then, so the context is passed explicitly), then hard-resets the save
  // generation and drops every timer/listener, so nothing from the old
  // episode can ever flush or mark for the new one.
  useEffect(() => {
    resumeBannerShownRef.current = false;
    parkedViewportRef.current = null;
    lastViewportGestureAtRef.current = 0;
    explicitTopNavigationRef.current = false;
    setShowResumeBanner(false);
    setShowToc(false);
    setShowReaderMenu(false);
    setShowReaderSettings(false);
    pendingProgressRef.current = null;
    viewportContextRef.current = { episodeId, userId };
    localRecoveryLastWriteRef.current = 0;

    return () => {
      // enabled deliberately does NOT read canRead: this closure was
      // written on the render the effect last ran, which for a slow-loading
      // episode is the initial skeleton (canRead still false) even though
      // the user has long been reading. The dispose flush is a no-op
      // without pending progress anyway, and a non-null pending can only
      // exist after canRead was true (the scroll handler is gated on it) -
      // plus the server re-checks read access on every saveProgress.
      progressSaveRef.current?.dispose({
        episodeId,
        userId: userId ?? null,
        enabled: !!episodeId && !!userId,
      });
      resumeVerifierRef.current?.cancel();
      resumeIntentDetachRef.current?.();
      resumeIntentDetachRef.current = null;
      resumeVerifyTimersRef.current.forEach((timer) => clearTimeout(timer));
      resumeVerifyTimersRef.current = [];
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
        scrollDebounceRef.current = null;
      }
    };
  }, [episodeId, userId]);

  const scrollToAnchor = (
    anchorId: string | null | undefined,
    options?: { instant?: boolean }
  ): boolean => {
    if (!anchorId) return false;
    const el = document.getElementById(anchorId);
    if (!el) return false;
    el.scrollIntoView({ behavior: options?.instant ? "auto" : "smooth", block: "start" });
    return true;
  };

  // NovelDetail chapter projection links to the parent package plus a chapter
  // query. Once package content is readable, jump to that internal TOC entry.
  useEffect(() => {
    if (!canRead || !isPackage || toc.length === 0) return;
    const requestedChapter = new URLSearchParams(window.location.search).get("chapter");
    if (!requestedChapter) return;
    const entry = findTocEntryByChapterNumber(toc, requestedChapter);
    if (!entry) return;
    requestAnimationFrame(() => scrollToAnchor(entry.anchorId));
  }, [episodeId, canRead, isPackage, toc]);

  // Restore the chosen resume position onto the container: the exact saved
  // scroll offset first (what the reader actually saw), chapter anchor as
  // fallback when the pixel position can't be honored.
  const applyResumeScroll = useCallback(
    (target: ReadingPositionSnapshot): number | null => {
      const container = scrollContainerRef.current;
      const metrics = container
        ? { scrollHeight: container.scrollHeight, clientHeight: container.clientHeight }
        : null;
      const plan = resolveResumeScrollPlan(target, metrics);
      if (plan.kind === "scrollTop" && container) {
        container.scrollTop = plan.value;
        return plan.value;
      }
      if (plan.kind === "anchor" && scrollToAnchor(plan.anchorId, { instant: true })) {
        return container ? container.scrollTop : null;
      }
      if (plan.kind === "chapter") {
        const entry = findTocEntryByChapterNumber(toc, plan.chapterNumber);
        if (entry && scrollToAnchor(entry.anchorId, { instant: true })) {
          return container ? container.scrollTop : null;
        }
      }
      return null;
    },
    [toc]
  );
  applyResumeScrollRef.current = applyResumeScroll;

  // One scheduled verify pass (double-rAF + the timed passes below): the
  // verifier itself decides intent vs. layout-shift - see
  // createResumeVerifier in readerResumePosition.ts.
  const resumeApplyStep = useCallback(() => {
    resumeVerifierRef.current?.step();
  }, []);

  // User-intent listeners for the active verify window: only EXPLICIT
  // input (wheel/touch/pointer/navigation keys) counts as the reader taking
  // over - a bare scrollTop change is a layout shift (banner unmount, font
  // swap) and must NOT cancel the restore.
  const armResumeIntentListeners = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const markIntent = () => resumeVerifierRef.current?.notifyUserIntent();
    const navigationKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
    // Keyboard intent is captured at DOCUMENT level: the scroller is
    // keyboard-scrollable even while focus sits outside it (e.g. on body).
    // But a key consumed by an editing/control surface is NOT scroll
    // intent - Space on a focused button activates it, arrows move
    // sliders/selects, and anything typed into an input must leave the
    // restore alone.
    const markKeyIntent = (e: KeyboardEvent) => {
      if (!navigationKeys.includes(e.key)) return;
      const target = e.target as HTMLElement | Document | null;
      if (target && target !== document) {
        const el = target as HTMLElement;
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          tag === "A" ||
          el.isContentEditable ||
          el.closest?.("[role='textbox'],[role='slider'],[role='combobox'],[role='listbox']")
        ) {
          return;
        }
      }
      markIntent();
    };
    container.addEventListener("wheel", markIntent, { passive: true });
    container.addEventListener("touchmove", markIntent, { passive: true });
    container.addEventListener("pointerdown", markIntent, { passive: true });
    document.addEventListener("keydown", markKeyIntent);
    resumeIntentDetachRef.current?.();
    resumeIntentDetachRef.current = () => {
      container.removeEventListener("wheel", markIntent);
      container.removeEventListener("touchmove", markIntent);
      container.removeEventListener("pointerdown", markIntent);
      document.removeEventListener("keydown", markKeyIntent);
    };
  }, []);

  const handleResumeReading = () => {
    markViewportUserIntent();
    const target = resumeSource?.snapshot;
    setShowResumeBanner(false);
    if (!target) return;

    // The resume banner sits IN-FLOW inside the scroll container, so its
    // unmount shifts content under the viewport: apply the restore after
    // that lands (double rAF) and keep re-asserting it on the timed passes
    // while fonts/images/layout finish settling.
    resumeVerifierRef.current?.arm(target);
    armResumeIntentListeners();
    resumeVerifyTimersRef.current.forEach((timer) => clearTimeout(timer));
    resumeVerifyTimersRef.current = [];
    requestAnimationFrame(() => requestAnimationFrame(resumeApplyStep));
    resumeVerifyTimersRef.current = RESUME_VERIFY_DELAYS_MS.map((ms) =>
      setTimeout(resumeApplyStep, ms)
    );
  };

  // A preference change (font size/family, line height, spacing) re-flows
  // every paragraph, moving the restored offset - re-assert it, but only
  // while the resume-verify window above is still active. Past that window
  // the reader owns their position and is never yanked.
  useEffect(() => {
    if (!resumeVerifierRef.current?.isActive()) return;
    const raf = requestAnimationFrame(resumeApplyStep);
    return () => cancelAnimationFrame(raf);
  }, [fontSize, fontFamily, lineHeight, paragraphSpacing, resumeApplyStep]);

  const handleTocEntryClick = (entry: PackageTocEntry) => {
    markViewportUserIntent();
    setShowToc(false);
    // A TOC jump is deliberate navigation - it ends any active resume
    // verify window (the restore must not fight the jump).
    resumeVerifierRef.current?.notifyUserIntent();
    scrollToAnchor(entry.anchorId);

    // Save immediately rather than waiting for the scroll-stop debounce -
    // jumping via the TOC is itself a deliberate navigation action.
    pendingProgressRef.current = {
      percent: livePercent,
      scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
      chapterNumber: entry.chapterNumber,
      chapterTitle: entry.title,
      anchorId: entry.anchorId,
    };
    writeLocalRecovery(pendingProgressRef.current);
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(flushProgressSave, SCROLL_SAVE_DEBOUNCE_MS);
  };

  // Copy protection and watermark effect
  useEffect(() => {
    const handleCopyProtection = (e: ClipboardEvent | DragEvent | MouseEvent | KeyboardEvent) => {
      e.preventDefault();
      // Throttle toast to avoid spam (max once per 1 second)
      const now = Date.now();
      if (now - lastToastTimeRef.current >= 1000) {
        toast.error(t("reader.copyNotAllowed") || "ไม่อนุญาตให้คัดลอกเนื้อหานิยาย");
        lastToastTimeRef.current = now;
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      // Block copy shortcuts at document level: Ctrl/Cmd + C, X, A, S, P
      if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a', 's', 'p'].includes(e.key.toLowerCase())) {
        const target = e.target as HTMLElement;
        // Only block if target is inside protected content areas
        if (contentRef.current?.contains(target) || previewRef.current?.contains(target)) {
          e.preventDefault();
          // Throttle toast
          const now = Date.now();
          if (now - lastToastTimeRef.current >= 1000) {
            toast.error(t("reader.copyNotAllowed") || "ไม่อนุญาตให้คัดลอกเนื้อหานิยาย");
            lastToastTimeRef.current = now;
          }
        }
      }
    };

    const attachProtection = (element: HTMLDivElement | null) => {
      if (!element) return;

      // Event listeners for copy prevention on content areas
      element.addEventListener('copy', handleCopyProtection);
      element.addEventListener('cut', handleCopyProtection);
      element.addEventListener('paste', handleCopyProtection);
      element.addEventListener('dragstart', handleCopyProtection as any);
      element.addEventListener('selectstart', handleCopyProtection as any);
      element.addEventListener('contextmenu', handleContextMenu);

      return () => {
        element.removeEventListener('copy', handleCopyProtection);
        element.removeEventListener('cut', handleCopyProtection);
        element.removeEventListener('paste', handleCopyProtection);
        element.removeEventListener('dragstart', handleCopyProtection as any);
        element.removeEventListener('selectstart', handleCopyProtection as any);
        element.removeEventListener('contextmenu', handleContextMenu);
      };
    };

    const cleanupContent = attachProtection(contentRef.current);
    const cleanupPreview = attachProtection(previewRef.current);

    // Attach document-level keyboard listener
    document.addEventListener('keydown', handleDocumentKeyDown);

    return () => {
      cleanupContent?.();
      cleanupPreview?.();
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [episode?.id, canRead, content, preview, episodeId, t]);

  useEffect(() => {
    setShowPurchaseConfirm(false);
  }, [episodeId]);

  if (!user) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          {t("common.error")} - Not logged in
        </div>
        <button onClick={() => setLocation("/auth")} className={styles.backButton}>
          Go to Login
        </button>
      </div>
    );
  }

  const showPurchaseError = (err: unknown) => {
    const errorMsg = (err as { message?: string })?.message || "Purchase failed";

    if (errorMsg === "INSUFFICIENT_WALLET_BALANCE") {
      toast.error("ยอดเงินในกระเป๋าไม่พอ กรุณาเติมเงิน", {
        action: {
          label: "เติมเงิน",
          onClick: () => setLocation("/wallet"),
        },
      });
    } else if (errorMsg === "INSUFFICIENT_WALLET_BALANCE_ATOMIC") {
      toast.error("ตัดเงินจากกระเป๋าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังพบปัญหาให้ติดต่อแอดมิน");
    } else if (errorMsg === "INVALID_EPISODE_PRICE") {
      toast.error("ราคาบทนี้ไม่ถูกต้อง กรุณาติดต่อแอดมิน");
    } else if (errorMsg === "INVALID_WALLET_BALANCE") {
      toast.error("ข้อมูลกระเป๋าเงินผิดปกติ กรุณาติดต่อแอดมิน");
    } else {
      toast.error(errorMsg);
    }
  };

  const handlePurchase = async () => {
    if (!episode || purchaseMutation.isPending) return;

    try {
      await purchaseMutation.mutateAsync({ episodeId });
      toast.success(t("reader.purchaseSuccess") || "ซื้อบทสำเร็จ");
      setShowPurchaseConfirm(false);

      await Promise.all([
        utils.reader.getEpisode.invalidate({ episodeId }),
        novel?.id ? utils.reader.myPurchases.invalidate({ novelId: novel.id }) : Promise.resolve(),
        novel?.id ? utils.novels.episodes.invalidate({ novelId: novel.id }) : Promise.resolve(),
        utils.wallet.getBalance.invalidate(),
        utils.wallet.getSummary.invalidate(),
        utils.myNovels.list.invalidate(),
      ]);
    } catch (err) {
      showPurchaseError(err);
    }
  };

  const handleBackToNovel = () => {
    if (novel?.id) {
      setLocation(`/novels/${novel.id}`);
    } else {
      setLocation("/novels");
    }
  };

  const goToEpisode = (targetEpisodeId?: number) => {
    if (!targetEpisodeId) return;
    setLocation(`/read/${targetEpisodeId}`);
  };

  if (dataLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>{t("common.loading")}</div>
      </div>
    );
  }

  // R4/D: the lease lifecycle applies MID-READ too — a lease lost/held-by-
  // other while the page is open (displaced by another session, TTL lapse,
  // explicit transfer elsewhere) must take the reading view over, not just
  // the fresh-load gate-error path. The content is never readable without a
  // live lease of this session.
  if (showTransferCta) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          กำลังอ่านอยู่ที่อุปกรณ์อื่น — กด “ย้ายมาอ่านที่นี่” เพื่อย้ายสิทธิ์การอ่านมาที่อุปกรณ์นี้
        </div>
        <button
          onClick={doTransferLease}
          disabled={transferring}
          data-testid="reader-transfer-lease"
          className={styles.backButton}
        >
          {transferring ? "กำลังย้าย…" : "ย้ายมาอ่านที่นี่"}
        </button>
        <button onClick={handleBackToNovel} className={styles.backButton}>
          {t("reader.backToNovel")}
        </button>
      </div>
    );
  }

  if (dataError || !episode || !novel) {
    const leaseCode = (dataError as unknown as { data?: { authGateCode?: string } } | null)?.data?.authGateCode;
    const isLeaseGate = leaseCode === "LEASE_HELD" || leaseCode === "LEASE_LOST" || leaseCode === "LEASE_REQUIRED";
    if (isLeaseGate) {
      // R2: another session of this account is reading — explicit transfer
      // press required (never automatic).
      return (
        <div className={styles.container}>
          <div className={styles.error}>
            กำลังอ่านอยู่ที่อุปกรณ์อื่น — กด “ย้ายมาอ่านที่นี่” เพื่อย้ายสิทธิ์การอ่านมาที่อุปกรณ์นี้
          </div>
          <button
            onClick={doTransferLease}
            disabled={transferring}
            data-testid="reader-transfer-lease"
            className={styles.backButton}
          >
            {transferring ? "กำลังย้าย…" : "ย้ายมาอ่านที่นี่"}
          </button>
          <button onClick={handleBackToNovel} className={styles.backButton}>
            {t("reader.backToNovel")}
          </button>
        </div>
      );
    }
    const errorMsg = dataError ? (dataError as unknown as { message?: string })?.message || "Unknown error" : t("reader.errorLoadingEpisode");
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          {errorMsg}
        </div>
        <button onClick={handleBackToNovel} className={styles.backButton}>
          {t("reader.backToNovel")}
        </button>
      </div>
    );
  }

  return (
    <div className={`${styles.container} ${styles[theme]}`}>
      {/* Header - collapses when Focus Mode is on (see chromeState above);
          `inert` (applied via effect) keeps its buttons out of the tab
          order while it's collapsed, on top of the CSS animation below. */}
      <div
        className={`${styles.header} ${chromeState.hideHeader ? styles.headerHidden : ""}`}
        ref={setHeaderEl}
      >
        {/* Top row: back button (left) + reader options menu (right). Kept
            free of the title so a long novel title never gets squeezed
            between them. */}
        <div className={styles.topRow}>
          <button onClick={handleBackToNovel} className={styles.backButton}>
            ← {t("reader.backToNovel")}
          </button>

          <div className={styles.menuWrapper}>
            <button
              className={styles.menuButton}
              onClick={() => setShowReaderMenu((prev) => !prev)}
              aria-label="ตัวเลือกการอ่าน"
              aria-expanded={showReaderMenu}
            >
              <MoreVertical size={18} />
            </button>

            {showReaderMenu && (
              <>
                <div className={styles.menuBackdrop} onClick={() => setShowReaderMenu(false)} />
                <div className={styles.menuPanel}>
                  <p className={styles.menuPanelLabel}>ภาษา</p>
                  <LanguageSwitcher />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Title block: novel title truncates to 1 line, subtitle (episode
            label) sits on its own line underneath - neither ever overlaps
            the top-row icons. */}
        <div className={styles.titleBlock}>
          <h1 className={styles.novelTitle} title={novel.title}>{novel.title}</h1>
          <p className={styles.episodeTitle}>
            {formatEpisodeLabel(episode.episodeNumber, episode.title)}
          </p>
        </div>

        {/* Toolbar: font size, theme, table of contents - a horizontally
            scrollable row so it never wraps/overlaps content on narrow
            screens. */}
        <div className={styles.toolbar}>
          <button
            className={styles.readerSettingsButton}
            onClick={() => setShowReaderSettings(true)}
            aria-label={t("reader.readingSettings")}
            title={t("reader.readingSettings")}
          >
            <Type size={16} />
            <span>Aa</span>
          </button>

          {toc.length > 0 && (
            <button className={styles.tocButton} onClick={() => setShowToc(true)}>
              สารบัญ
            </button>
          )}

          {hasReadableContent && (
            <button
              ref={hideHeaderToggleRef}
              className={styles.readerSettingsButton}
              onClick={() => updateReaderPreference("focusMode", true)}
              aria-label="ซ่อนแถบด้านบน"
              title="ซ่อนแถบด้านบน"
            >
              <Maximize2 size={16} />
              <span className={styles.focusButtonLabel}>ซ่อนแถบด้านบน</span>
            </button>
          )}
        </div>
      </div>

      {/* Restore button - the only way back once Focus Mode has collapsed
          the header. Fixed + safe-area-anchored so it stays reachable even
          when the header it's replacing would otherwise have been. */}
      {chromeState.showRestoreButton && (
        <button
          ref={restoreButtonRef}
          type="button"
          className={styles.restoreButton}
          onClick={() => updateReaderPreference("focusMode", false)}
          aria-label="แสดงแถบด้านบน"
          title="แสดงแถบด้านบน"
        >
          <Minimize2 size={16} />
          <span className={styles.restoreButtonLabel}>แสดงแถบด้านบน</span>
        </button>
      )}

      {/* Progress bar - reflects live scroll position while reading */}
      {canRead && content && (
        <div className={styles.progressBarTrack}>
          <div className={styles.progressBarFill} style={{ width: `${livePercent}%` }} />
        </div>
      )}

      {/* Content Area */}
      <div
        className={styles.content}
        ref={scrollContainerRef}
        onScroll={handleContentScroll}
        onTouchStart={markViewportUserIntent}
        onTouchMove={markViewportScrollIntent}
        onPointerDown={markViewportUserIntent}
        onWheel={markViewportScrollIntent}
        onKeyDown={(event) => {
          if (event.key === "Home") {
            markViewportTopNavigation();
          } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "End", " "].includes(event.key)) {
            markViewportScrollIntent();
          }
        }}
        data-testid="reader-scroll-container"
      >
        {showResumeBanner && resumeSource && canRead && content && (
          <div className={styles.resumeBanner}>
            <p>
              อ่านล่าสุดถึง{" "}
              {resumeSource.snapshot.chapterTitle
                || (resumeSource.snapshot.chapterNumber ? `บทที่ ${resumeSource.snapshot.chapterNumber}` : "ตำแหน่งเดิม")}
              {resumeSource.snapshot.percent > 0 ? ` • ${Math.round(resumeSource.snapshot.percent)}%` : ""}
            </p>
            <div className={styles.resumeBannerActions}>
              <button onClick={handleResumeReading} className={styles.resumeButton}>
                อ่านต่อ
              </button>
              <button
                onClick={() => setShowResumeBanner(false)}
                className={styles.dismissButton}
                aria-label="ปิด"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {canRead && content ? (
          <div
            ref={contentRef}
            className={`${styles.episodeContent} ${styles.protected}`}
            style={readerContentStyle}
          >
            {content.split("\n").map((para: string, idx: number) => {
              const tocEntry = tocByLineIndex.get(idx);
              if (tocEntry) {
                return (
                  <p
                    key={idx}
                    id={tocEntry.anchorId}
                    data-toc-anchor="true"
                    data-chapter-number={tocEntry.chapterNumber}
                    data-chapter-title={tocEntry.title}
                    className={styles.tocHeadingParagraph}
                  >
                    {para}
                  </p>
                );
              }
              return <p key={idx}>{para}</p>;
            })}
          </div>
        ) : canRead && !content ? (
          // User has access but no web content. If a legacy Docs/PDF file
          // still exists for this package (bought before it was migrated to
          // web content), send them there instead of a dead end - never
          // pretend there's nothing to read when a legacy file is available.
          <div className={styles.noContentSection}>
            {isPackage && episode?.fileUrl ? (
              <>
                <h3>แพ็กนี้เป็นไฟล์เดิมที่ยังไม่ได้ย้ายเข้า Reader</h3>
                <p>กรุณาเปิดอ่านจากไฟล์เดิมด้านล่างนี้ไปก่อน</p>
                <a
                  href={episode.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.purchaseButton}
                >
                  เปิดไฟล์เดิม
                </a>
              </>
            ) : isPackage ? (
              <>
                <h3>{t("reader.noContentTitle")}</h3>
                <p>แพ็กนี้ยังไม่มีเนื้อหาสำหรับอ่านบนเว็บ กรุณาติดต่อแอดมิน</p>
              </>
            ) : (
              <>
                <h3>{t("reader.noContentTitle")}</h3>
                <p>{t("reader.noContentNoFile")}</p>
                {user?.role === "admin" && (
                  <p className={styles.adminHint}>{t("reader.noContentAdminHint")}</p>
                )}
              </>
            )}
          </div>
        ) : isLocked ? (
          <div className={styles.lockedSection}>
            {preview ? (
              <div
                ref={previewRef}
                className={`${styles.previewContent} ${styles.protected}`}
                style={readerContentStyle}
              >
                {preview.split("\n").map((para: string, idx: number) => (
                  <p key={idx}>{para}</p>
                ))}
                <div className={styles.previewFade}></div>
              </div>
            ) : (
              <div className={styles.noContentSection}>
                <h3>{t("reader.lockedTitle")}</h3>
                <p>{t("reader.lockedDescription")}</p>
              </div>
            )}

            {isPackage ? (
              // Packages are cart/checkout-only - never buyable with a direct
              // wallet purchase from inside the reader. Send the user back to
              // the novel page to add it to cart instead.
              <div className={styles.purchasePrompt}>
                <h3>แพ็กนี้ยังไม่ได้ปลดล็อก</h3>
                <p>กรุณาซื้อแพ็กผ่านหน้ารายละเอียดนิยายก่อนอ่าน</p>

                <button
                  className={styles.purchaseButton}
                  onClick={handleBackToNovel}
                >
                  กลับไปซื้อแพ็ก
                </button>
              </div>
            ) : (
              <div className={styles.purchasePrompt}>
                <h3>{t("reader.lockedTitle")}</h3>
                <p>{t("reader.lockedDescription")}</p>

                <div className={styles.priceInfo}>
                  <div className={styles.priceRow}>
                    <span>{t("reader.price")}:</span>
                    <strong>฿{formatMoney(episode.price)}</strong>
                  </div>
                  <div className={styles.priceRow}>
                    <span>{t("reader.walletBalance")}:</span>
                    <strong>฿{formatMoney(walletBalance)}</strong>
                  </div>
                </div>

                <div className={styles.warnings}>
                  <p>
                    <strong>{t("reader.purchaseWithWalletOnly")}</strong>
                  </p>
                  <p>{t("reader.couponNotAllowed")}</p>
                </div>

                <button
                  className={styles.purchaseButton}
                  onClick={() => setShowPurchaseConfirm(true)}
                  disabled={!hasEnoughWalletBalance || purchaseMutation.isPending}
                >
                  {hasEnoughWalletBalance
                    ? t("reader.buyEpisode")
                    : t("reader.insufficientBalance")}
                </button>

                {!hasEnoughWalletBalance && (
                  <button
                    className={styles.topupButton}
                    onClick={() => setLocation("/wallet")}
                  >
                    {t("reader.topupWallet")}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : !canRead ? (
          <div className={styles.errorContent}>
            <p>{t("reader.noAccess")}</p>
          </div>
        ) : null}

        {savedIndicatorVisible && (
          <div className={styles.savedIndicator}>บันทึกตำแหน่งอ่านแล้ว</div>
        )}
      </div>

      {/* Edge watermark - fixed top/bottom strips + a small corner badge,
          always visible while reading without covering the middle of the
          page. Sits above plain content but below the header/menus/TOC/
          modals (see z-index comment in the CSS module), and is fully
          inert (pointer-events/user-select: none) so it never blocks
          scrolling or clicks on the header/toolbar/nav underneath it. */}
      {shouldShowWatermark && (
        <div className={styles.edgeWatermark} aria-hidden="true">
          <div className={styles.edgeWatermarkTop} style={{ top: watermarkTopOffset }}>
            <span>{generateWatermarkText(user, episodeId)}</span>
          </div>

          <div className={styles.edgeWatermarkBottom} style={{ bottom: watermarkBottomOffset }}>
            <span>{generateWatermarkText(user, episodeId)}</span>
          </div>

          <div className={styles.edgeWatermarkBadge} style={{ bottom: watermarkBadgeBottomOffset }}>
            Ipe • UID:{user?.id || "unknown"} • EP:{episodeId}
          </div>
        </div>
      )}

      {/* Reading Settings Panel - font size/family, line height, paragraph
          spacing and theme. Preferences persist to localStorage and only
          ever affect the episodeContent/previewContent containers above. */}
      <ReaderSettings
        isOpen={showReaderSettings}
        onClose={() => setShowReaderSettings(false)}
        preferences={readerPreferences}
        onChange={updateReaderPreference}
        onReset={resetReaderPreferences}
      />

      {/* Table of Contents Drawer - package episodes only, when headings were
          found in the content ("บทที่ N" / "ตอนที่ N" / "Chapter N" / "#N"). */}
      {showToc && toc.length > 0 && (
        <div className={styles.tocOverlay} onClick={() => setShowToc(false)}>
          <div className={styles.tocDrawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.tocDrawerHeader}>
              <h3>สารบัญ</h3>
              <button onClick={() => setShowToc(false)} aria-label="ปิดสารบัญ">
                ×
              </button>
            </div>
            <div className={styles.tocList}>
              {toc.map((entry) => (
                <button
                  key={entry.anchorId}
                  onClick={() => handleTocEntryClick(entry)}
                  className={styles.tocItem}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Navigation - hidden for packages: a package bundles many chapters,
          so "previous/next episode" doesn't map onto anything meaningful.
          The backend also always returns previousEpisode/nextEpisode as null
          for packages, but skip rendering the bar entirely to avoid a blank
          strip. Chapter navigation is unaffected. */}
      {!isPackage && (
        <div className={styles.navigation} ref={setNavigationEl}>
          {previousEpisode ? (
            <button
              className={styles.navButton}
              onClick={() => goToEpisode(previousEpisode.id)}
            >
              ← {t("reader.previousEpisode")}
            </button>
          ) : (
            <div />
          )}
          {nextEpisode ? (
            <button
              className={styles.navButton}
              onClick={() => goToEpisode(nextEpisode.id)}
            >
              {t("reader.nextEpisode")} →
            </button>
          ) : (
            <div />
          )}
        </div>
      )}

      {/* Purchase Confirmation Dialog */}
      {showPurchaseConfirm && (
        <div className={styles.modalOverlay} onClick={() => setShowPurchaseConfirm(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>{t("reader.confirmPurchase")}</h3>
            <div className={styles.confirmContent}>
              <p>
                <strong>{episode.title}</strong>
              </p>
              <div className={styles.confirmDetails}>
                <div>
                  <span>{t("reader.price")}:</span>
                  <span>฿{formatMoney(episode.price)}</span>
                </div>
                <div>
                  <span>{t("reader.walletBalance")}:</span>
                  <span>฿{formatMoney(walletBalance)}</span>
                </div>
                <div>
                  <span>{t("reader.balanceAfterPurchase")}:</span>
                  <span>
                    ฿
                    {((walletBalanceCents - episodePriceCents) / 100).toFixed(2)}
                  </span>
                </div>
              </div>
              <p className={styles.confirmWarning}>
                {t("reader.purchaseInfo")}
              </p>
            </div>
            <div className={styles.modalButtons}>
              <button
                className={styles.cancelButton}
                onClick={() => setShowPurchaseConfirm(false)}
                disabled={purchaseMutation.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                className={styles.confirmButton}
                onClick={handlePurchase}
                disabled={purchaseMutation.isPending || !hasEnoughWalletBalance}
              >
                {purchaseMutation.isPending ? t("common.loading") : t("reader.confirmBuy")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
