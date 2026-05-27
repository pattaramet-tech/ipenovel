/**
 * Shared slip file upload service
 * Handles file validation, sanitization, and S3 upload for payment slips
 * Used by payment.uploadSlipFile endpoint and optionally /api/upload fallback
 */

import { storagePut } from "../storage";
import { TRPCError } from "@trpc/server";
import {
  StorageUploadError,
  normalizeMimeType,
  validateMagicBytes,
  sanitizeLogData,
} from "../helpers/storageErrorHandler";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

export interface UploadPaymentSlipFileInput {
  userId: number;
  fileName: string;
  mimeType: string;
  fileBase64: string;
  context: "checkout" | "payment_page" | "wallet";
  orderTotal?: number;
  requestId?: string;
}

export interface UploadPaymentSlipFileResult {
  slipImageUrl: string;
  key: string;
  mimeType: string;
  size: number;
  isPDF: boolean;
  userMessage: string;
  orderTotal?: number;
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
  const requestId = input.requestId || `upload-${Date.now()}`;
  const context = {
    userId: input.userId,
    context: input.context,
    fileName: sanitizeFileName(input.fileName),
    requestId,
  };

  try {
    // Step 1: Normalize and validate MIME type
    let normalizedMimeType: string;
    try {
      normalizedMimeType = normalizeMimeType(input.mimeType);
    } catch (error: any) {
      console.warn("[SlipUpload]", requestId, "MIME type not supported:", {
        ...context,
        mimeType: input.mimeType,
        error: error.message,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error.message || "ไฟล์นี้ยังไม่รองรับ กรุณาอัปโหลด JPG, PNG หรือ PDF",
      });
    }

    if (!ALLOWED_MIME_TYPES.includes(normalizedMimeType as any)) {
      console.warn("[SlipUpload]", requestId, "MIME type not allowed:", {
        ...context,
        mimeType: normalizedMimeType,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ไฟล์นี้ยังไม่รองรับ กรุณาอัปโหลด JPG, PNG หรือ PDF",
      });
    }

    // Step 2: Decode base64 to buffer
    let fileBuffer: Buffer;
    try {
      fileBuffer = base64ToBuffer(input.fileBase64);
    } catch (error: any) {
      console.warn("[SlipUpload]", requestId, "Invalid base64:", {
        ...context,
        error: error.message,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ไฟล์ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง",
      });
    }

    // Step 3: Validate file size
    if (fileBuffer.length > MAX_FILE_SIZE) {
      const sizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
      console.warn("[SlipUpload]", requestId, "File too large:", {
        ...context,
        size: fileBuffer.length,
        sizeMB,
        maxSize: MAX_FILE_SIZE,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `ไฟล์ใหญ่เกินไป (${sizeMB}MB) กรุณาอัปโหลดไฟล์ที่เล็กกว่า 5MB`,
      });
    }

    // Step 4: Validate magic bytes
    if (!validateMagicBytes(fileBuffer, normalizedMimeType)) {
      console.warn("[SlipUpload]", requestId, "Magic bytes mismatch:", {
        ...context,
        mimeType: normalizedMimeType,
        firstBytes: fileBuffer.slice(0, 4).toString("hex"),
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ไฟล์ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง",
      });
    }

    // Step 5: Validate orderTotal if provided
    if (input.orderTotal !== undefined && typeof input.orderTotal !== "number") {
      console.warn("[SlipUpload]", requestId, "Invalid order total:", {
        ...context,
        orderTotal: input.orderTotal,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ข้อมูลการสั่งซื้อไม่ถูกต้อง",
      });
    }

    // Step 6: Prepare file key
    const sanitized = sanitizeFileName(input.fileName);
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const fileKey = `payment-slips/${input.userId}/${timestamp}-${random}-${sanitized}`;

    console.info("[SlipUpload]", requestId, "File ready for upload:", {
      ...context,
      fileKey,
      size: fileBuffer.length,
      mimeType: normalizedMimeType,
    });

    // Step 7: Upload to S3
    try {
      const { url } = await storagePut(fileKey, fileBuffer, normalizedMimeType);

      const isPDF = normalizedMimeType === "application/pdf";
      const userMessage = isPDF
        ? "PDF slips require manual review. We will notify you once approved."
        : "Your slip is being processed. We will notify you once approved.";

      console.info("[SlipUpload]", requestId, "Upload successful:", {
        ...context,
        fileKey,
        url: url.substring(0, 100) + "...",
        isPDF,
      });

      return {
        slipImageUrl: url,
        key: fileKey,
        mimeType: normalizedMimeType,
        size: fileBuffer.length,
        isPDF,
        userMessage,
        orderTotal: input.orderTotal,
      };
    } catch (error: any) {
      // Handle StorageUploadError
      if (error instanceof StorageUploadError) {
        console.error("[SlipUpload]", requestId, "Storage upload failed:", {
          ...context,
          ...error.getSafeDetails(),
        });

        const trpcError = error.toTRPCError();
        throw new TRPCError({
          code: trpcError.code,
          message: trpcError.message,
        });
      }

      // Handle other errors
      console.error("[SlipUpload]", requestId, "Upload error:", {
        ...context,
        error: error.message,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      });
    }
  } catch (error: any) {
    // Re-throw TRPC errors
    if (error instanceof TRPCError) {
      throw error;
    }

    // Catch-all for unexpected errors
    console.error("[SlipUpload]", requestId, "Unexpected error:", {
      ...context,
      error: error.message,
    });

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    });
  }
}
