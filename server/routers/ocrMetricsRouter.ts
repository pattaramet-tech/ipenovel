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
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";

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
   * Get current OCR configuration (effective config used by runtime)
   */
  getConfig: protectedProcedure
    .use(async ({ ctx, next }) => {
      if (ctx.user?.role !== "admin") {
        throw new Error("Unauthorized: admin only");
      }
      return next({ ctx });
    })
    .query(async () => {
    const { getEffectiveOCRConfig } = await import("../_core/ocr-effective-config");
    const effective = await getEffectiveOCRConfig();
    return {
      // Effective config (what runtime actually uses)
      enabled: effective.enabled,
      autoApproveEnabled: effective.autoApproveEnabled,
      shadowModeEnabled: effective.shadowModeEnabled,
      minConfidence: effective.minConfidence,
      maxTimeWindowMinutes: effective.maxTimeWindowMinutes,
      source: effective.source,
      environmentOverride: effective.environmentOverride,
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
   * Get OCR configuration info (for debugging - shows both effective and raw env)
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
    const effective = await getEffectiveOCRConfig();
    logOCRConfig(config);
    console.log("[OCR Metrics] Effective config:", effective);
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
