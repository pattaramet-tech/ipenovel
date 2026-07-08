import React, { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import styles from "./ReaderPage.module.css";
import { formatEpisodeLabel } from "@/utils/episodeUtils";

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

  const [fontSize, setFontSize] = useState(16);
  const [theme, setTheme] = useState<"light" | "dark" | "sepia">("light");
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
        <div className={styles.headerContent}>
          <button onClick={handleBackToNovel} className={styles.backButton}>
            ← {t("reader.backToNovel")}
          </button>
          <div className={styles.titleSection}>
            <h1 className={styles.novelTitle}>{novel.title}</h1>
            <h2 className={styles.episodeTitle}>
              {formatEpisodeLabel(episode.episodeNumber, episode.title)}
            </h2>
          </div>
        </div>

        {/* Reader Controls */}
        <div className={styles.controls}>
          <div className={styles.fontSizeControl}>
            <button onClick={() => setFontSize(Math.max(12, fontSize - 2))}>
              A−
            </button>
            <span>{fontSize}px</span>
            <button onClick={() => setFontSize(Math.min(24, fontSize + 2))}>
              A+
            </button>
          </div>

          <div className={styles.themeControl}>
            <button
              className={theme === "light" ? styles.active : ""}
              onClick={() => setTheme("light")}
              title={t("reader.light")}
            >
              ☀
            </button>
            <button
              className={theme === "dark" ? styles.active : ""}
              onClick={() => setTheme("dark")}
              title={t("reader.dark")}
            >
              ◐
            </button>
            <button
              className={theme === "sepia" ? styles.active : ""}
              onClick={() => setTheme("sepia")}
              title={t("reader.sepia")}
            >
              ◈
            </button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className={styles.content}>
        {canRead && content ? (
          <div
            ref={contentRef}
            className={`${styles.episodeContent} ${styles.protected}`}
            style={{ fontSize: `${fontSize}px` }}
          >
            {content.split("\n").map((para: string, idx: number) => (
              <p key={idx}>{para}</p>
            ))}
            <div className={styles.watermark}>
              <div className={styles.watermarkText}>
                {generateWatermarkText(user, episodeId)}
              </div>
            </div>
          </div>
        ) : canRead && !content ? (
          // User has access but content is empty. Legacy packages that were
          // never migrated from a Docs/PDF file to on-web content land here -
          // we no longer open fileUrl as an external download, everything is
          // read on the web only now.
          <div className={styles.noContentSection}>
            <h3>{t("reader.noContentTitle")}</h3>
            {isPackage ? (
              <p>แพ็กนี้ยังไม่มีเนื้อหาสำหรับอ่านบนเว็บ กรุณาติดต่อแอดมิน</p>
            ) : (
              <>
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
                style={{ fontSize: `${fontSize}px` }}
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
      </div>

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
