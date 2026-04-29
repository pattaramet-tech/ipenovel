/**
 * OCR Staging Controls & Metrics Tests
 *
 * Validates shadow mode, metrics tracking, and configuration flags
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getOCRConfig,
  validateOCRConfig,
  logOCRConfig,
} from "./_core/ocr-config";
import {
  getMetrics,
  getMetricsSummary,
  recordSlipProcessed,
  recordSuccessfulExtraction,
  recordFailedExtraction,
  recordAutoApproved,
  recordManualReview,
  recordShadowApproved,
  recordFailureReason,
  recordBankDetected,
  recordConfidenceLevel,
  recordApprovalSource,
  resetMetrics,
} from "./_core/ocr-metrics";

describe("OCR Configuration", () => {
  it("should load default production configuration", () => {
    process.env.NODE_ENV = "production";
    const config = getOCRConfig();

    expect(config.ocrEnabled).toBe(true);
    expect(config.ocrAutoApproveEnabled).toBe(true);
    expect(config.ocrShadowMode).toBe(false);
    expect(config.minConfidence).toBe(85);
    expect(config.maxTimeWindowMinutes).toBe(120);
    expect(config.strictDuplicateCheck).toBe(true);
  });

  it("should load default staging configuration", () => {
    process.env.NODE_ENV = "staging";
    const config = getOCRConfig();

    expect(config.ocrEnabled).toBe(true);
    expect(config.ocrAutoApproveEnabled).toBe(false); // Disabled by default in staging
    expect(config.ocrShadowMode).toBe(true); // Enabled by default in staging
    expect(config.detailedLogging).toBe(true); // Enabled by default in staging
  });

  it("should override configuration via environment variables", () => {
    process.env.OCR_ENABLED = "false";
    process.env.OCR_MIN_CONFIDENCE = "75";
    process.env.OCR_MAX_TIME_WINDOW_MINUTES = "60";

    const config = getOCRConfig();

    expect(config.ocrEnabled).toBe(false);
    expect(config.minConfidence).toBe(75);
    expect(config.maxTimeWindowMinutes).toBe(60);

    // Cleanup
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_MIN_CONFIDENCE;
    delete process.env.OCR_MAX_TIME_WINDOW_MINUTES;
  });

  it("should validate configuration", () => {
    const validConfig = getOCRConfig();
    const errors = validateOCRConfig(validConfig);
    expect(errors).toHaveLength(0);
  });

  it("should reject invalid confidence threshold", () => {
    const invalidConfig = {
      ...getOCRConfig(),
      minConfidence: 150,
    };
    const errors = validateOCRConfig(invalidConfig);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("OCR_MIN_CONFIDENCE");
  });

  it("should reject shadow mode in production", () => {
    process.env.NODE_ENV = "production";
    const invalidConfig = {
      ...getOCRConfig(),
      ocrShadowMode: true,
    };
    const errors = validateOCRConfig(invalidConfig);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("OCR_SHADOW_MODE");
    expect(errors[0]).toContain("production");
  });

  it("should reject auto-approve disabled in production", () => {
    process.env.NODE_ENV = "production";
    const invalidConfig = {
      ...getOCRConfig(),
      ocrAutoApproveEnabled: false,
    };
    const errors = validateOCRConfig(invalidConfig);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("OCR_AUTO_APPROVE_ENABLED");
    expect(errors[0]).toContain("production");
  });
});

describe("OCR Metrics Tracking", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("should track slip processing", () => {
    recordSlipProcessed();
    recordSlipProcessed();
    recordSlipProcessed();

    const metrics = getMetrics();
    expect(metrics.totalSlipsProcessed).toBe(3);
  });

  it("should track successful and failed extractions", () => {
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordSlipProcessed();
    recordFailedExtraction();

    const metrics = getMetrics();
    expect(metrics.totalSlipsProcessed).toBe(3);
    expect(metrics.successfulExtractions).toBe(2);
    expect(metrics.failedExtractions).toBe(1);
  });

  it("should track auto-approval and manual review", () => {
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordAutoApproved();

    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordManualReview();

    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordShadowApproved();

    const metrics = getMetrics();
    expect(metrics.autoApprovedCount).toBe(1);
    expect(metrics.manualReviewCount).toBe(1);
    expect(metrics.shadowApprovedCount).toBe(1);
  });

  it("should track failure reasons", () => {
    recordFailureReason("MISSING_AMOUNT");
    recordFailureReason("MISSING_AMOUNT");
    recordFailureReason("AMOUNT_MISMATCH");
    recordFailureReason("DUPLICATE_REFERENCE");
    recordFailureReason("LOW_CONFIDENCE");

    const metrics = getMetrics();
    expect(metrics.missingAmountCount).toBe(2);
    expect(metrics.amountMismatchCount).toBe(1);
    expect(metrics.duplicateReferenceCount).toBe(1);
    expect(metrics.lowConfidenceCount).toBe(1);
  });

  it("should track bank detection", () => {
    recordBankDetected("BBL");
    recordBankDetected("BBL");
    recordBankDetected("KBANK");
    recordBankDetected("PROMPTPAY");

    const metrics = getMetrics();
    expect(metrics.bankDetectionDistribution["BBL"]).toBe(2);
    expect(metrics.bankDetectionDistribution["KBANK"]).toBe(1);
    expect(metrics.bankDetectionDistribution["PROMPTPAY"]).toBe(1);
  });

  it("should track confidence distribution", () => {
    recordConfidenceLevel(20); // veryLow
    recordConfidenceLevel(40); // low
    recordConfidenceLevel(60); // medium
    recordConfidenceLevel(80); // high
    recordConfidenceLevel(92); // veryHigh

    const metrics = getMetrics();
    expect(metrics.confidenceDistribution.veryLow).toBe(1);
    expect(metrics.confidenceDistribution.low).toBe(1);
    expect(metrics.confidenceDistribution.medium).toBe(1);
    expect(metrics.confidenceDistribution.high).toBe(1);
    expect(metrics.confidenceDistribution.veryHigh).toBe(1);
  });

  it("should track approval source", () => {
    recordApprovalSource("ocr");
    recordApprovalSource("ocr");
    recordApprovalSource("wallet");
    recordApprovalSource("manual");

    const metrics = getMetrics();
    expect(metrics.approvalSourceDistribution.ocr).toBe(2);
    expect(metrics.approvalSourceDistribution.wallet).toBe(1);
    expect(metrics.approvalSourceDistribution.manual).toBe(1);
  });

  it("should generate metrics summary", () => {
    // Setup: 10 slips, 8 successful, 2 failed
    for (let i = 0; i < 8; i++) {
      recordSlipProcessed();
      recordSuccessfulExtraction();
    }
    for (let i = 0; i < 2; i++) {
      recordSlipProcessed();
      recordFailedExtraction();
    }

    // 5 auto-approved, 3 manual review
    for (let i = 0; i < 5; i++) {
      recordAutoApproved();
    }
    for (let i = 0; i < 3; i++) {
      recordManualReview();
    }

    // Record some confidence levels
    for (let i = 0; i < 5; i++) {
      recordConfidenceLevel(90);
    }
    for (let i = 0; i < 3; i++) {
      recordConfidenceLevel(70);
    }

    const summary = getMetricsSummary();

    expect(summary.totalProcessed).toBe(10);
    expect(summary.successRate).toBe("80.0%");
    expect(summary.autoApprovalRate).toBe("62.5%"); // 5 out of 8
    expect(summary.topFailureReasons).toBeDefined();
    expect(summary.averageConfidence).toBeDefined();
    expect(summary.uptime).toBeDefined();
  });

  it("should reset metrics", () => {
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordAutoApproved();

    let metrics = getMetrics();
    expect(metrics.totalSlipsProcessed).toBe(1);

    resetMetrics();

    metrics = getMetrics();
    expect(metrics.totalSlipsProcessed).toBe(0);
    expect(metrics.successfulExtractions).toBe(0);
    expect(metrics.autoApprovedCount).toBe(0);
  });

  it("should update lastUpdated timestamp on each operation", async () => {
    const metrics1 = getMetrics();
    const time1 = metrics1.lastUpdated instanceof Date
      ? metrics1.lastUpdated.getTime()
      : new Date(metrics1.lastUpdated as any).getTime();

    // Wait a tiny bit
    await new Promise((resolve) => setTimeout(resolve, 10));

    recordSlipProcessed();

    const metrics2 = getMetrics();
    const time2 = metrics2.lastUpdated instanceof Date
      ? metrics2.lastUpdated.getTime()
      : new Date(metrics2.lastUpdated as any).getTime();

    expect(time2).toBeGreaterThan(time1);
  });
});

describe("OCR Metrics Summary", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("should calculate success rate correctly", () => {
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordSlipProcessed();
    recordSuccessfulExtraction();
    recordSlipProcessed();
    recordFailedExtraction();

    const summary = getMetricsSummary();
    expect(summary.successRate).toBe("66.7%"); // 2 out of 3
  });

  it("should calculate auto-approval rate correctly", () => {
    // 8 successful extractions: 5 auto-approved, 3 manual
    for (let i = 0; i < 5; i++) {
      recordSlipProcessed();
      recordSuccessfulExtraction();
      recordAutoApproved();
    }
    for (let i = 0; i < 3; i++) {
      recordSlipProcessed();
      recordSuccessfulExtraction();
      recordManualReview();
    }

    const summary = getMetricsSummary();
    expect(summary.autoApprovalRate).toBe("62.5%"); // 5 out of 8
  });

  it("should identify top failure reasons", () => {
    recordFailureReason("MISSING_AMOUNT");
    recordFailureReason("MISSING_AMOUNT");
    recordFailureReason("MISSING_AMOUNT");
    recordFailureReason("AMOUNT_MISMATCH");
    recordFailureReason("AMOUNT_MISMATCH");
    recordFailureReason("DUPLICATE_REFERENCE");

    const summary = getMetricsSummary();
    expect(summary.topFailureReasons[0].reason).toBe("Missing Amount");
    expect(summary.topFailureReasons[0].count).toBe(3);
    expect(summary.topFailureReasons[1].reason).toBe("Amount Mismatch");
    expect(summary.topFailureReasons[1].count).toBe(2);
  });

  it("should identify top banks", () => {
    recordBankDetected("BBL");
    recordBankDetected("BBL");
    recordBankDetected("BBL");
    recordBankDetected("KBANK");
    recordBankDetected("KBANK");
    recordBankDetected("SCB");

    const summary = getMetricsSummary();
    expect(summary.topBanks[0].bank).toBe("BBL");
    expect(summary.topBanks[0].count).toBe(3);
    expect(summary.topBanks[1].bank).toBe("KBANK");
    expect(summary.topBanks[1].count).toBe(2);
  });

  it("should calculate average confidence", () => {
    // 2 at 90%, 2 at 70%
    recordConfidenceLevel(90);
    recordConfidenceLevel(90);
    recordConfidenceLevel(70);
    recordConfidenceLevel(70);

    const summary = getMetricsSummary();
    const avgConfidence = parseFloat(summary.averageConfidence);
    // Average should be around 77.5 (weighted by distribution buckets)
    expect(avgConfidence).toBeGreaterThan(70);
    expect(avgConfidence).toBeLessThan(85);
  });
});

describe("OCR Configuration Logging", () => {
  it("should log configuration without errors", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const config = getOCRConfig();
    logOCRConfig(config);

    expect(consoleSpy).toHaveBeenCalled();
    const callArgs = consoleSpy.mock.calls[0];
    expect(callArgs[0]).toContain("OCR Config");

    consoleSpy.mockRestore();
  });
});
