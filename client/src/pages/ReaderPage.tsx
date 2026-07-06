import React, { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import styles from "./ReaderPage.module.css";

export default function ReaderPage() {
  const { episodeId: episodeIdStr } = useParams<{ episodeId: string }>();
  const episodeId = episodeIdStr ? parseInt(episodeIdStr, 10) : 0;
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, setLocation] = useLocation();

  const { data: episodeData, isLoading: dataLoading, error: dataError } = trpc.reader.getEpisode.useQuery(
    { episodeId },
    { enabled: !!episodeId && !!user }
  );

  const purchaseMutation = trpc.reader.purchaseEpisode.useMutation();

  const [fontSize, setFontSize] = useState(16);
  const [theme, setTheme] = useState<"light" | "dark" | "sepia">("light");
  const [showPurchaseConfirm, setShowPurchaseConfirm] = useState(false);

  const episode = episodeData?.episode;
  const novel = episodeData?.novel;
  const walletBalance = episodeData?.walletBalance || "0";
  const canRead = episodeData?.canRead || false;

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

  const handlePurchase = async () => {
    try {
      await purchaseMutation.mutateAsync({ episodeId });
      toast.success(t("reader.purchaseSuccess"));
      setShowPurchaseConfirm(false);
    } catch (err) {
      const errorMsg = (err as unknown as { message?: string })?.message || "Purchase failed";
      toast.error(errorMsg);
    }
  };

  const handleBackToNovel = () => {
    if (novel) {
      setLocation(`/novels/${novel.slug}`);
    } else {
      setLocation("/novels");
    }
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
              {t("novel.episode")} {episode.episodeNumber}: {episode.title}
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
        {episode.canRead && episode.content ? (
          <div
            className={styles.episodeContent}
            style={{ fontSize: `${fontSize}px` }}
          >
            {episode.content.split("\n").map((para: string, idx: number) => (
              <p key={idx}>{para}</p>
            ))}
          </div>
        ) : episode.canRead && !episode.content ? (
          // User has access but content is empty
          <div className={styles.noContentSection}>
            <h3>{t("reader.noContentTitle")}</h3>
            {episode.fileUrl ? (
              <>
                <p>{t("reader.noContentWithFile")}</p>
                <a
                  href={episode.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.openFileButton}
                >
                  {t("reader.openOriginalFile")}
                </a>
              </>
            ) : (
              <>
                <p>{t("reader.noContentNoFile")}</p>
                {user?.role === "admin" && (
                  <p className={styles.adminHint}>{t("reader.noContentAdminHint")}</p>
                )}
              </>
            )}
          </div>
        ) : episode.isLocked && episode.preview ? (
          <div className={styles.lockedSection}>
            <div
              className={styles.previewContent}
              style={{ fontSize: `${fontSize}px` }}
            >
              {episode.preview.split("\n").map((para: string, idx: number) => (
                <p key={idx}>{para}</p>
              ))}
              <div className={styles.previewFade}></div>
            </div>

            <div className={styles.purchasePrompt}>
              <h3>{t("reader.lockedTitle")}</h3>
              <p>{t("reader.lockedDescription")}</p>

              <div className={styles.priceInfo}>
                <div className={styles.priceRow}>
                  <span>{t("reader.price")}:</span>
                  <strong>฿{parseFloat(episode.price).toFixed(2)}</strong>
                </div>
                <div className={styles.priceRow}>
                  <span>{t("reader.walletBalance")}:</span>
                  <strong>฿{parseFloat(walletBalance).toFixed(2)}</strong>
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
                disabled={
                  parseFloat(walletBalance) < parseFloat(episode.price)
                }
              >
                {parseFloat(walletBalance) >= parseFloat(episode.price)
                  ? t("reader.buyEpisode")
                  : t("reader.insufficientBalance")}
              </button>

              {parseFloat(walletBalance) < parseFloat(episode.price) && (
                <button className={styles.topupButton}>
                  {t("reader.topupWallet")}
                </button>
              )}
            </div>
          </div>
        ) : !episode.canRead ? (
          <div className={styles.errorContent}>
            <p>{t("reader.noAccess")}</p>
          </div>
        ) : null}
      </div>

      {/* Navigation */}
      <div className={styles.navigation}>
        {episode.previousEpisode && (
          <button
            className={styles.navButton}
            onClick={() => setLocation(`/read/${episode.previousEpisode.id}`)}
          >
            ← {t("reader.previousEpisode")}
          </button>
        )}
        <div></div>
        {episode.nextEpisode && (
          <button
            className={styles.navButton}
            onClick={() => setLocation(`/read/${episode.nextEpisode.id}`)}
          >
            {t("reader.nextEpisode")} →
          </button>
        )}
      </div>

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
                  <span>฿{parseFloat(episode.price).toFixed(2)}</span>
                </div>
                <div>
                  <span>{t("reader.walletBalance")}:</span>
                  <span>฿{parseFloat(walletBalance).toFixed(2)}</span>
                </div>
                <div>
                  <span>{t("reader.balanceAfterPurchase")}:</span>
                  <span>
                    ฿
                    {(parseFloat(walletBalance) - parseFloat(episode.price)).toFixed(2)}
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
                disabled={purchaseMutation.isPending}
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
