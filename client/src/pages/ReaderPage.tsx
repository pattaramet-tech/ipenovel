import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { MoreVertical, Type } from "lucide-react";
import styles from "./ReaderPage.module.css";
import { formatEpisodeLabel } from "@/utils/episodeUtils";
import { parsePackageToc, findTocEntryByChapterNumber, type PackageTocEntry } from "@/utils/packageTocUtils";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ReaderSettings from "@/components/ReaderSettings";
import { useReaderPreferences, getFontFamilyStack } from "@/hooks/useReaderPreferences";

// How long to wait after the user stops scrolling before saving progress.
const SCROLL_SAVE_DEBOUNCE_MS = 1500;
// Safety-net autosave interval, in case the debounced save above never fires
// (e.g. a long idle period with no further scroll events).
const PERIODIC_SAVE_INTERVAL_MS = 15000;
// Skip re-saving if progress hasn't moved by at least this many percentage
// points and the current chapter hasn't changed - avoids spamming the API
// with near-duplicate saves.
const MIN_PERCENT_DELTA_TO_SAVE = 1;

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

  const { preferences: readerPreferences, updatePreference: updateReaderPreference, resetPreferences: resetReaderPreferences } = useReaderPreferences();
  const { fontSize, fontFamily, lineHeight, paragraphSpacing, theme } = readerPreferences;
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
  const lastSavedProgressRef = useRef<{ percent: number; chapterNumber: string | null } | null>(null);

  const [showToc, setShowToc] = useState(false);
  const [showReaderMenu, setShowReaderMenu] = useState(false);
  const [livePercent, setLivePercent] = useState(0);
  const [savedIndicatorVisible, setSavedIndicatorVisible] = useState(false);
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const resumeBannerShownRef = useRef(false);

  // Package content bundles many chapters into one blob - parse recognizable
  // chapter headings ("บทที่ 12", "ตอนที่ 12", "Chapter 12", "#12") into a
  // jump-to-chapter table of contents. Empty for plain chapters (no headings
  // match), which is fine - the TOC button/drawer just doesn't render then.
  const toc = useMemo(() => (isPackage ? parsePackageToc(content) : []), [isPackage, content]);
  const tocByLineIndex = useMemo(() => new Map(toc.map((entry) => [entry.lineIndex, entry])), [toc]);

  const flushProgressSave = useCallback(() => {
    if (!canRead || !episodeId) return;
    const pending = pendingProgressRef.current;
    if (!pending) return;

    const last = lastSavedProgressRef.current;
    const percentDelta = last ? Math.abs(last.percent - pending.percent) : 100;
    const chapterChanged = !last || last.chapterNumber !== pending.chapterNumber;
    if (last && percentDelta < MIN_PERCENT_DELTA_TO_SAVE && !chapterChanged) {
      return;
    }

    lastSavedProgressRef.current = { percent: pending.percent, chapterNumber: pending.chapterNumber };

    saveProgressMutation.mutate(
      {
        episodeId,
        progressPercent: pending.percent,
        scrollPosition: pending.scrollTop,
        currentChapterNumber: pending.chapterNumber ?? undefined,
        currentChapterTitle: pending.chapterTitle ?? undefined,
        anchorKey: pending.anchorId ?? undefined,
      },
      {
        onSuccess: () => {
          setSavedIndicatorVisible(true);
          setTimeout(() => setSavedIndicatorVisible(false), 2000);
        },
      }
    );
  }, [canRead, episodeId, saveProgressMutation]);

  const handleContentScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !canRead || !content) return;

    const scrollableHeight = container.scrollHeight - container.clientHeight;
    const percent = scrollableHeight > 0
      ? Math.min(100, Math.max(0, (container.scrollTop / scrollableHeight) * 100))
      : 100;
    setLivePercent(percent);
    // Once the reader starts scrolling manually, the stale "resume" banner
    // no longer applies - hide it rather than leave it sitting there.
    setShowResumeBanner(false);

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

    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(flushProgressSave, SCROLL_SAVE_DEBOUNCE_MS);
  }, [canRead, content, toc, flushProgressSave]);

  // Periodic safety-net autosave + beforeunload best-effort save.
  useEffect(() => {
    if (!canRead) return;

    periodicSaveIntervalRef.current = setInterval(flushProgressSave, PERIODIC_SAVE_INTERVAL_MS);
    const handleBeforeUnload = () => flushProgressSave();
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      if (periodicSaveIntervalRef.current) clearInterval(periodicSaveIntervalRef.current);
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [canRead, flushProgressSave]);

  // Show the "resume reading" banner once per episode load, if there's a
  // meaningful saved position. The reader must explicitly click "อ่านต่อ" -
  // never auto-jump on load.
  useEffect(() => {
    if (progressData && progressData.progressPercent > 0 && !resumeBannerShownRef.current) {
      setShowResumeBanner(true);
      resumeBannerShownRef.current = true;
    }
  }, [progressData]);

  useEffect(() => {
    resumeBannerShownRef.current = false;
    setShowResumeBanner(false);
    setShowToc(false);
    setShowReaderMenu(false);
    setShowReaderSettings(false);
    lastSavedProgressRef.current = null;
    pendingProgressRef.current = null;
  }, [episodeId]);

  const scrollToAnchor = (anchorId: string | null | undefined): boolean => {
    if (!anchorId) return false;
    const el = document.getElementById(anchorId);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  };

  const handleResumeReading = () => {
    setShowResumeBanner(false);
    if (!progressData) return;

    requestAnimationFrame(() => {
      if (scrollToAnchor(progressData.anchorKey)) return;

      const entry = findTocEntryByChapterNumber(toc, progressData.currentChapterNumber);
      if (entry && scrollToAnchor(entry.anchorId)) return;

      if (scrollContainerRef.current && progressData.scrollPosition) {
        scrollContainerRef.current.scrollTop = progressData.scrollPosition;
      }
    });
  };

  const handleTocEntryClick = (entry: PackageTocEntry) => {
    setShowToc(false);
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

  if (dataError || !episode || !novel) {
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
      {/* Header */}
      <div className={styles.header}>
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
        </div>
      </div>

      {/* Progress bar - reflects live scroll position while reading */}
      {canRead && content && (
        <div className={styles.progressBarTrack}>
          <div className={styles.progressBarFill} style={{ width: `${livePercent}%` }} />
        </div>
      )}

      {/* Content Area */}
      <div className={styles.content} ref={scrollContainerRef} onScroll={handleContentScroll}>
        {showResumeBanner && progressData && canRead && content && (
          <div className={styles.resumeBanner}>
            <p>
              อ่านล่าสุดถึง{" "}
              {progressData.currentChapterTitle
                || (progressData.currentChapterNumber ? `บทที่ ${progressData.currentChapterNumber}` : "ตำแหน่งเดิม")}
              {" "}• {progressData.progressPercent}%
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
            <div className={styles.watermark}>
              <div className={styles.watermarkText}>
                {generateWatermarkText(user, episodeId)}
              </div>
            </div>
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
                <div className={styles.watermark}>
                  <div className={styles.watermarkText}>
                    {generateWatermarkText(user, episodeId)}
                  </div>
                </div>
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
        <div className={styles.navigation}>
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
