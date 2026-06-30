/**
 * Discord Notification Service for OCR Review Alerts
 *
 * Sends Discord webhook notifications when OCR results require manual admin review.
 * Designed to be non-blocking: Discord errors do not affect payment/topup flow.
 */

import { formatMoney } from "../helpers/moneyNormalizer";

export interface OCRReviewNotificationPayload {
  // Required
  type: "payment" | "wallet_topup";
  id: number;

  // User info
  userId?: number;
  userName?: string;
  userEmail?: string;

  // Amount info
  expectedAmount: number;
  ocrAmount?: number;

  // Wallet top-up specific
  creditedAmount?: string;
  bonusAmount?: string;

  // OCR decision
  reviewReason?: string;
  ocrDecision?: string;
  finalConfidence?: number;
  duplicateStatus?: any;

  // Links
  slipImageUrl?: string;
}

/**
 * Build Discord embed for OCR review notification
 */
function buildDiscordOCRReviewEmbed(payload: OCRReviewNotificationPayload): any {
  const isWalletTopup = payload.type === "wallet_topup";
  const typeLabel = isWalletTopup ? "Wallet Top-up" : "Order Payment";
  const typeEmoji = isWalletTopup ? "💰" : "🛒";

  // Mask sensitive data
  const maskedEmail = payload.userEmail
    ? payload.userEmail.replace(/(.{2})(.*)(@.*)/, "$1***$3")
    : "Unknown";

  // Build field list
  const fields: any[] = [
    {
      name: "Type",
      value: typeLabel,
      inline: true,
    },
    {
      name: "ID",
      value: `#${payload.id}`,
      inline: true,
    },
  ];

  // User info
  if (payload.userName || payload.userEmail) {
    fields.push({
      name: "User",
      value: payload.userName || maskedEmail,
      inline: true,
    });
  }

  if (payload.userEmail) {
    fields.push({
      name: "Email",
      value: maskedEmail,
      inline: true,
    });
  }

  // Amount info
  fields.push({
    name: "Expected Amount",
    value: `฿${payload.expectedAmount.toFixed(2)}`,
    inline: true,
  });

  if (payload.ocrAmount !== undefined && payload.ocrAmount !== null) {
    fields.push({
      name: "OCR Amount",
      value: `฿${payload.ocrAmount.toFixed(2)}`,
      inline: true,
    });
  }

  // Wallet top-up specific fields
  if (isWalletTopup) {
    if (payload.bonusAmount) {
      fields.push({
        name: "Bonus",
        value: `฿${payload.bonusAmount}`,
        inline: true,
      });
    }

    if (payload.creditedAmount) {
      fields.push({
        name: "Credit After Approval",
        value: `฿${payload.creditedAmount}`,
        inline: true,
      });
    }
  }

  // Review reason
  if (payload.reviewReason) {
    const reasonLabel = payload.reviewReason
      .split("_")
      .map((word: string) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(" ");

    fields.push({
      name: "Review Reason",
      value: reasonLabel,
      inline: true,
    });
  }

  // Duplicate status
  if (payload.duplicateStatus?.isDuplicate) {
    fields.push({
      name: "Duplicate Status",
      value: `⚠️ Potential duplicate detected`,
      inline: false,
    });
  }

  // Confidence
  if (payload.finalConfidence !== undefined) {
    fields.push({
      name: "Confidence",
      value: `${Math.round(payload.finalConfidence)}%`,
      inline: true,
    });
  }

  // Determine color based on reason
  let color = 0xFFA500; // Orange (default)
  if (payload.reviewReason?.includes("DUPLICATE") || payload.duplicateStatus?.isDuplicate) {
    color = 0xFF0000; // Red
  } else if (payload.reviewReason?.includes("MISMATCH")) {
    color = 0xFF6600; // Dark orange
  } else if (payload.reviewReason?.includes("ERROR")) {
    color = 0xFF0000; // Red
  }

  return {
    title: `🔎 OCR Needs Review: ${typeLabel} #${payload.id}`,
    color: color,
    fields: fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Send Discord webhook notification
 * Designed to fail gracefully - Discord errors do not block the payment/topup flow
 */
export async function sendOCRReviewNotification(payload: OCRReviewNotificationPayload): Promise<void> {
  const webhookUrl = process.env.DISCORD_OCR_REVIEW_WEBHOOK_URL;

  // Silently exit if webhook not configured
  if (!webhookUrl) {
    console.warn("[Discord OCR Review] DISCORD_OCR_REVIEW_WEBHOOK_URL not configured, skipping notification");
    return;
  }

  try {
    const embed = buildDiscordOCRReviewEmbed(payload);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "IPE OCR Review Bot",
        avatar_url: "https://emoji.gg/assets/emoji/9286_Trophy.png",
        embeds: [embed],
      }),
    });

    if (!response.ok) {
      console.warn("[Discord OCR Review] failed to send notification", {
        type: payload.type,
        id: payload.id,
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    console.info("[Discord OCR Review] notification sent", {
      type: payload.type,
      id: payload.id,
    });
  } catch (error: any) {
    // Gracefully handle Discord errors - do NOT re-throw
    console.warn("[Discord OCR Review] failed to send notification", {
      type: payload.type,
      id: payload.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Intentionally NOT throwing - payment/topup flow must not be affected
  }
}
