/**
 * Upload service health check
 * Verifies storage configuration at server startup
 */

import { isStorageReady } from "../storage";

export function checkUploadServiceHealth(): void {
  const isReady = isStorageReady();

  if (isReady) {
    console.info("[UploadHealth] ✓ Storage service is configured and ready");
  } else {
    console.warn(
      "[UploadHealth] ⚠ Storage service is NOT configured. Set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }
}

/**
 * Get upload service status for admin diagnostics
 */
export function getUploadServiceStatus(): {
  ready: boolean;
  message: string;
} {
  const ready = isStorageReady();
  return {
    ready,
    message: ready
      ? "Upload service is ready"
      : "Upload service is not configured. Contact admin.",
  };
}
