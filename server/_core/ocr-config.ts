/**
 * OCR Configuration Module
 *
 * Centralizes all OCR-related environment flags and defaults.
 * Enables safe staging rollout with configurable controls.
 *
 * Production defaults are conservative (prefer manual review over false approval).
 * Staging can adjust through explicit env flags.
 */

export interface OCRConfig {
  // Feature Enablement
  ocrEnabled: boolean;
  ocrAutoApproveEnabled: boolean;
  ocrShadowMode: boolean;

  // Verification Thresholds
  minConfidence: number;
  maxTimeWindowMinutes: number;
  strictDuplicateCheck: boolean;

  // Metrics & Observability
  metricsEnabled: boolean;
  detailedLogging: boolean;

  // Admin Visibility
  showVerificationBreakdown: boolean;
  showOCRMetadata: boolean;
}

/**
 * Parse boolean from env string
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Parse number from env string
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get OCR configuration from environment
 *
 * Production Defaults (Conservative):
 * - OCR enabled, auto-approve enabled, shadow mode disabled
 * - High confidence threshold (85%)
 * - Tight time window (120 minutes for full datetime, 1440 for date-only)
 * - Strict duplicate checking
 * - Metrics enabled, detailed logging disabled
 * - Admin visibility enabled
 *
 * Staging Overrides (via env flags):
 * - Can enable shadow mode for testing without approvals
 * - Can adjust thresholds for testing edge cases
 * - Can enable detailed logging for debugging
 */
export function getOCRConfig(): OCRConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const isStaging = process.env.NODE_ENV === "staging";

  return {
    // Feature Enablement
    ocrEnabled: parseBoolean(process.env.OCR_ENABLED, true),
    ocrAutoApproveEnabled: parseBoolean(
      process.env.OCR_AUTO_APPROVE_ENABLED,
      !isStaging // Disabled by default in staging (shadow mode preferred)
    ),
    ocrShadowMode: parseBoolean(
      process.env.OCR_SHADOW_MODE,
      isStaging // Enabled by default in staging
    ),

    // Verification Thresholds
    minConfidence: parseNumber(
      process.env.OCR_MIN_CONFIDENCE,
      85 // Production default: 85%
    ),
    maxTimeWindowMinutes: parseNumber(
      process.env.OCR_MAX_TIME_WINDOW_MINUTES,
      120 // Production default: 2 hours for full datetime
    ),
    strictDuplicateCheck: parseBoolean(
      process.env.OCR_STRICT_DUPLICATE_CHECK,
      true // Production default: strict
    ),

    // Metrics & Observability
    metricsEnabled: parseBoolean(process.env.OCR_METRICS_ENABLED, true),
    detailedLogging: parseBoolean(
      process.env.OCR_DETAILED_LOGGING,
      isStaging // Enabled by default in staging for debugging
    ),

    // Admin Visibility
    showVerificationBreakdown: parseBoolean(
      process.env.OCR_SHOW_BREAKDOWN,
      true
    ),
    showOCRMetadata: parseBoolean(process.env.OCR_SHOW_METADATA, true),
  };
}

/**
 * Validate OCR configuration
 * Ensures production safety is maintained
 */
export function validateOCRConfig(config: OCRConfig): string[] {
  const errors: string[] = [];

  if (config.minConfidence < 0 || config.minConfidence > 100) {
    errors.push("OCR_MIN_CONFIDENCE must be between 0 and 100");
  }

  if (config.maxTimeWindowMinutes < 5 || config.maxTimeWindowMinutes > 10080) {
    // 5 minutes to 7 days
    errors.push("OCR_MAX_TIME_WINDOW_MINUTES must be between 5 and 10080");
  }

  // Production safety check: ensure shadow mode is not enabled in production
  if (
    process.env.NODE_ENV === "production" &&
    config.ocrShadowMode
  ) {
    errors.push(
      "OCR_SHADOW_MODE must not be enabled in production environment"
    );
  }

  // Production safety check: ensure auto-approve is enabled in production
  if (
    process.env.NODE_ENV === "production" &&
    !config.ocrAutoApproveEnabled
  ) {
    errors.push(
      "OCR_AUTO_APPROVE_ENABLED must be true in production environment"
    );
  }

  return errors;
}

/**
 * Log OCR configuration (for debugging)
 */
export function logOCRConfig(config: OCRConfig): void {
  console.log("[OCR Config]", {
    enabled: config.ocrEnabled,
    autoApproveEnabled: config.ocrAutoApproveEnabled,
    shadowMode: config.ocrShadowMode,
    minConfidence: `${config.minConfidence}%`,
    maxTimeWindow: `${config.maxTimeWindowMinutes} min`,
    strictDuplicateCheck: config.strictDuplicateCheck,
    metricsEnabled: config.metricsEnabled,
    detailedLogging: config.detailedLogging,
  });
}
