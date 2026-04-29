/**
 * OCR Metrics Collection Module
 *
 * Tracks OCR pipeline metrics for staging observability.
 * Enables admins and developers to understand OCR behavior.
 */

export interface OCRMetrics {
  // Processing Counts
  totalSlipsProcessed: number;
  successfulExtractions: number;
  failedExtractions: number;

  // Decision Counts
  autoApprovedCount: number;
  manualReviewCount: number;
  shadowApprovedCount: number;

  // Failure Reasons
  missingAmountCount: number;
  amountMismatchCount: number;
  missingTransactionDateCount: number;
  transactionOutsideTimeWindowCount: number;
  missingReferenceCount: number;
  duplicateReferenceCount: number;
  duplicateFingerprintCount: number;
  lowConfidenceCount: number;
  insufficientStructuredDataCount: number;
  merchantCodeMismatchCount: number;
  shopNameMismatchCount: number;

  // Bank Detection
  bankDetectionDistribution: Record<string, number>;

  // Confidence Distribution
  confidenceDistribution: {
    veryLow: number; // 0-25%
    low: number; // 25-50%
    medium: number; // 50-75%
    high: number; // 75-85%
    veryHigh: number; // 85-100%
  };

  // Approval Source Distribution
  approvalSourceDistribution: {
    ocr: number;
    wallet: number;
    manual: number;
    transfer: number;
  };

  // Timestamps
  startTime: Date;
  lastUpdated: Date;
}

/**
 * In-memory metrics store (resets on server restart)
 * For production, consider persisting to database
 */
let metrics: OCRMetrics = {
  totalSlipsProcessed: 0,
  successfulExtractions: 0,
  failedExtractions: 0,
  autoApprovedCount: 0,
  manualReviewCount: 0,
  shadowApprovedCount: 0,
  missingAmountCount: 0,
  amountMismatchCount: 0,
  missingTransactionDateCount: 0,
  transactionOutsideTimeWindowCount: 0,
  missingReferenceCount: 0,
  duplicateReferenceCount: 0,
  duplicateFingerprintCount: 0,
  lowConfidenceCount: 0,
  insufficientStructuredDataCount: 0,
  merchantCodeMismatchCount: 0,
  shopNameMismatchCount: 0,
  bankDetectionDistribution: {},
  confidenceDistribution: {
    veryLow: 0,
    low: 0,
    medium: 0,
    high: 0,
    veryHigh: 0,
  },
  approvalSourceDistribution: {
    ocr: 0,
    wallet: 0,
    manual: 0,
    transfer: 0,
  },
  startTime: new Date(),
  lastUpdated: new Date(),
};

/**
 * Record a slip processing event
 */
export function recordSlipProcessed(): void {
  metrics.totalSlipsProcessed++;
  metrics.lastUpdated = new Date();
}

/**
 * Record successful extraction
 */
export function recordSuccessfulExtraction(): void {
  metrics.successfulExtractions++;
  metrics.lastUpdated = new Date();
}

/**
 * Record failed extraction
 */
export function recordFailedExtraction(): void {
  metrics.failedExtractions++;
  metrics.lastUpdated = new Date();
}

/**
 * Record auto-approval
 */
export function recordAutoApproved(): void {
  metrics.autoApprovedCount++;
  metrics.approvalSourceDistribution.ocr++;
  metrics.lastUpdated = new Date();
}

/**
 * Record manual review (pending)
 */
export function recordManualReview(): void {
  metrics.manualReviewCount++;
  metrics.lastUpdated = new Date();
}

/**
 * Record shadow mode approval (simulated)
 */
export function recordShadowApproved(): void {
  metrics.shadowApprovedCount++;
  metrics.lastUpdated = new Date();
}

/**
 * Record failure reason
 */
export function recordFailureReason(
  reason:
    | "MISSING_AMOUNT"
    | "AMOUNT_MISMATCH"
    | "MISSING_TRANSACTION_DATE"
    | "TRANSACTION_OUTSIDE_TIME_WINDOW"
    | "MISSING_REFERENCE"
    | "DUPLICATE_REFERENCE"
    | "DUPLICATE_FINGERPRINT"
    | "LOW_CONFIDENCE"
    | "INSUFFICIENT_STRUCTURED_DATA"
    | "MERCHANT_CODE_MISMATCH"
    | "SHOP_NAME_MISMATCH"
): void {
  switch (reason) {
    case "MISSING_AMOUNT":
      metrics.missingAmountCount++;
      break;
    case "AMOUNT_MISMATCH":
      metrics.amountMismatchCount++;
      break;
    case "MISSING_TRANSACTION_DATE":
      metrics.missingTransactionDateCount++;
      break;
    case "TRANSACTION_OUTSIDE_TIME_WINDOW":
      metrics.transactionOutsideTimeWindowCount++;
      break;
    case "MISSING_REFERENCE":
      metrics.missingReferenceCount++;
      break;
    case "DUPLICATE_REFERENCE":
      metrics.duplicateReferenceCount++;
      break;
    case "DUPLICATE_FINGERPRINT":
      metrics.duplicateFingerprintCount++;
      break;
    case "LOW_CONFIDENCE":
      metrics.lowConfidenceCount++;
      break;
    case "INSUFFICIENT_STRUCTURED_DATA":
      metrics.insufficientStructuredDataCount++;
      break;
    case "MERCHANT_CODE_MISMATCH":
      metrics.merchantCodeMismatchCount++;
      break;
    case "SHOP_NAME_MISMATCH":
      metrics.shopNameMismatchCount++;
      break;
  }
  metrics.lastUpdated = new Date();
}

/**
 * Record bank detection
 */
export function recordBankDetected(bank: string): void {
  metrics.bankDetectionDistribution[bank] =
    (metrics.bankDetectionDistribution[bank] ?? 0) + 1;
  metrics.lastUpdated = new Date();
}

/**
 * Record confidence level
 */
export function recordConfidenceLevel(confidence: number): void {
  if (confidence < 25) {
    metrics.confidenceDistribution.veryLow++;
  } else if (confidence < 50) {
    metrics.confidenceDistribution.low++;
  } else if (confidence < 75) {
    metrics.confidenceDistribution.medium++;
  } else if (confidence < 85) {
    metrics.confidenceDistribution.high++;
  } else {
    metrics.confidenceDistribution.veryHigh++;
  }
  metrics.lastUpdated = new Date();
}

/**
 * Record approval source
 */
export function recordApprovalSource(
  source: "ocr" | "wallet" | "manual" | "transfer"
): void {
  metrics.approvalSourceDistribution[source]++;
  metrics.lastUpdated = new Date();
}

/**
 * Get current metrics snapshot
 */
export function getMetrics(): OCRMetrics {
  return JSON.parse(JSON.stringify(metrics));
}

/**
 * Get metrics summary for admin dashboard
 */
export function getMetricsSummary(): {
  totalProcessed: number;
  successRate: string;
  autoApprovalRate: string;
  topFailureReasons: Array<{ reason: string; count: number }>;
  topBanks: Array<{ bank: string; count: number }>;
  averageConfidence: string;
  uptime: string;
} {
  const successRate =
    metrics.totalSlipsProcessed > 0
      ? (
          (metrics.successfulExtractions / metrics.totalSlipsProcessed) *
          100
        ).toFixed(1)
      : "0";

  const autoApprovalRate =
    metrics.successfulExtractions > 0
      ? (
          (metrics.autoApprovedCount / metrics.successfulExtractions) *
          100
        ).toFixed(1)
      : "0";

  // Top failure reasons
  const failureReasons = [
    { reason: "Missing Amount", count: metrics.missingAmountCount },
    { reason: "Amount Mismatch", count: metrics.amountMismatchCount },
    {
      reason: "Missing Transaction Date",
      count: metrics.missingTransactionDateCount,
    },
    {
      reason: "Transaction Outside Time Window",
      count: metrics.transactionOutsideTimeWindowCount,
    },
    { reason: "Missing Reference", count: metrics.missingReferenceCount },
    { reason: "Duplicate Reference", count: metrics.duplicateReferenceCount },
    { reason: "Duplicate Fingerprint", count: metrics.duplicateFingerprintCount },
    { reason: "Low Confidence", count: metrics.lowConfidenceCount },
    {
      reason: "Insufficient Structured Data",
      count: metrics.insufficientStructuredDataCount,
    },
  ];
  const topFailureReasons = failureReasons
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Top banks
  const topBanks = Object.entries(metrics.bankDetectionDistribution)
    .map(([bank, count]) => ({ bank, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Average confidence
  const totalConfidenceRecords =
    metrics.confidenceDistribution.veryLow +
    metrics.confidenceDistribution.low +
    metrics.confidenceDistribution.medium +
    metrics.confidenceDistribution.high +
    metrics.confidenceDistribution.veryHigh;
  const avgConfidence =
    totalConfidenceRecords > 0
      ? (
          (metrics.confidenceDistribution.veryLow * 12.5 +
            metrics.confidenceDistribution.low * 37.5 +
            metrics.confidenceDistribution.medium * 62.5 +
            metrics.confidenceDistribution.high * 80 +
            metrics.confidenceDistribution.veryHigh * 92.5) /
          totalConfidenceRecords
        ).toFixed(1)
      : "0";

  // Uptime
  const uptimeMs = new Date().getTime() - metrics.startTime.getTime();
  const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(1);

  return {
    totalProcessed: metrics.totalSlipsProcessed,
    successRate: `${successRate}%`,
    autoApprovalRate: `${autoApprovalRate}%`,
    topFailureReasons,
    topBanks,
    averageConfidence: `${avgConfidence}%`,
    uptime: `${uptimeHours}h`,
  };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics(): void {
  metrics = {
    totalSlipsProcessed: 0,
    successfulExtractions: 0,
    failedExtractions: 0,
    autoApprovedCount: 0,
    manualReviewCount: 0,
    shadowApprovedCount: 0,
    missingAmountCount: 0,
    amountMismatchCount: 0,
    missingTransactionDateCount: 0,
    transactionOutsideTimeWindowCount: 0,
    missingReferenceCount: 0,
    duplicateReferenceCount: 0,
    duplicateFingerprintCount: 0,
    lowConfidenceCount: 0,
    insufficientStructuredDataCount: 0,
    merchantCodeMismatchCount: 0,
    shopNameMismatchCount: 0,
    bankDetectionDistribution: {},
    confidenceDistribution: {
      veryLow: 0,
      low: 0,
      medium: 0,
      high: 0,
      veryHigh: 0,
    },
    approvalSourceDistribution: {
      ocr: 0,
      wallet: 0,
      manual: 0,
      transfer: 0,
    },
    startTime: new Date(),
    lastUpdated: new Date(),
  };
}
