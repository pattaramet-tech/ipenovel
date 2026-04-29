/**
 * OCR Metrics Router
 *
 * Admin endpoints for viewing OCR metrics and managing staging controls
 */

import { router, protectedProcedure } from "../_core/trpc";
import { z } from "zod";
import {
  getOCRMetricsForAdmin,
  getOCRMetricsDetailed,
  resetOCRMetrics,
} from "../ocr-slip-integration-staging";
import { getOCRConfig, logOCRConfig } from "../_core/ocr-config";

export const ocrMetricsRouter = router({
  /**
   * Get OCR metrics summary for admin dashboard
   */
  getSummary: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .query(async () => {
    return getOCRMetricsForAdmin();
  }),

  /**
   * Get detailed OCR metrics
   */
  getDetailed: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .query(async () => {
    return getOCRMetricsDetailed();
  }),

  /**
   * Get current OCR configuration
   */
  getConfig: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .query(async () => {
    const config = getOCRConfig();
    return {
      ocrEnabled: config.ocrEnabled,
      ocrAutoApproveEnabled: config.ocrAutoApproveEnabled,
      ocrShadowMode: config.ocrShadowMode,
      minConfidence: config.minConfidence,
      maxTimeWindowMinutes: config.maxTimeWindowMinutes,
      strictDuplicateCheck: config.strictDuplicateCheck,
      metricsEnabled: config.metricsEnabled,
      detailedLogging: config.detailedLogging,
      showVerificationBreakdown: config.showVerificationBreakdown,
      showOCRMetadata: config.showOCRMetadata,
    };
  }),

  /**
   * Reset OCR metrics (staging only)
   */
  resetMetrics: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .mutation(async () => {
    resetOCRMetrics();
    return { success: true, message: "OCR metrics reset" };
  }),

  /**
   * Get OCR configuration info (for debugging)
   */
  getConfigInfo: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .query(async () => {
    const config = getOCRConfig();
    logOCRConfig(config);
    return {
      environment: process.env.NODE_ENV || "development",
      config,
      envVarsSet: {
        OCR_ENABLED: process.env.OCR_ENABLED ? "yes" : "no",
        OCR_AUTO_APPROVE_ENABLED: process.env.OCR_AUTO_APPROVE_ENABLED
          ? "yes"
          : "no",
        OCR_SHADOW_MODE: process.env.OCR_SHADOW_MODE ? "yes" : "no",
        OCR_MIN_CONFIDENCE: process.env.OCR_MIN_CONFIDENCE || "not set",
        OCR_MAX_TIME_WINDOW_MINUTES:
          process.env.OCR_MAX_TIME_WINDOW_MINUTES || "not set",
        OCR_STRICT_DUPLICATE_CHECK: process.env.OCR_STRICT_DUPLICATE_CHECK
          ? "yes"
          : "no",
        OCR_METRICS_ENABLED: process.env.OCR_METRICS_ENABLED ? "yes" : "no",
        OCR_DETAILED_LOGGING: process.env.OCR_DETAILED_LOGGING ? "yes" : "no",
      },
    };
  }),
});
