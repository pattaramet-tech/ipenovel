/**
 * Shared slip file upload service
 * Handles file validation, sanitization, and S3 upload for payment slips
 * Used by payment.uploadSlipFile endpoint and optionally /api/upload fallback
 */

import { storagePut } from "../storage";
import { TRPCError } from "@trpc/server";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

export interface UploadPaymentSlipFileInput {
  userId: number;
  fileName: string;
  mimeType: string;
  fileBase64: string;
  context: "checkout" | "payment_page" | "wallet";
}

export interface UploadPaymentSlipFileResult {
  slipImageUrl: string;
  key: string;
  mimeType: string;
  size: number;
  isPDF: boolean;
  userMessage: string;
}

/**
 * Sanitize filename to prevent path traversal and special characters
 */
function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "") // Remove leading dots
    .substring(0, 255); // Limit length
}

/**
 * Decode base64 to buffer
 */
function base64ToBuffer(base64: string): Buffer {
  // Handle data URL format: "data:image/png;base64,..."
  const base64Data = base64.includes(",") ? base64.split(",")[1] : base64;
  return Buffer.from(base64Data, "base64");
}

/**
 * Upload payment slip file to S3
 */
export async function uploadPaymentSlipFile(
  input: UploadPaymentSlipFileInput
): Promise<UploadPaymentSlipFileResult> {
  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.includes(input.mimeType as any)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid file type. Allowed: JPG, PNG, PDF. Got: ${input.mimeType}`,
    });
  }

  // Decode base64 to buffer
  let fileBuffer: Buffer;
  try {
    fileBuffer = base64ToBuffer(input.fileBase64);
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid base64 encoding",
    });
  }

  // Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `File too large. Maximum 5MB, got ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB`,
    });
  }

  // Sanitize filename
  const sanitized = sanitizeFileName(input.fileName);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const fileKey = `payment-slips/${input.userId}/${timestamp}-${random}-${sanitized}`;

  // Upload to S3
  try {
    const { url } = await storagePut(fileKey, fileBuffer, input.mimeType);

    const isPDF = input.mimeType === "application/pdf";
    const userMessage = isPDF
      ? "PDF slips require manual review. We will notify you once approved."
      : "Your slip is being processed. We will notify you once approved.";

    return {
      slipImageUrl: url,
      key: fileKey,
      mimeType: input.mimeType,
      size: fileBuffer.length,
      isPDF,
      userMessage,
    };
  } catch (error: any) {
    console.error("[SlipUpload] S3 upload failed:", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "File upload failed. Please try again.",
    });
  }
}
