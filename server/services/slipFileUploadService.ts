/**
 * Shared slip file upload service
 * Handles file validation, sanitization, and S3 upload for payment slips
 * Used by payment.uploadSlipFile endpoint and optionally /api/upload fallback
 */

import { putPrivateObject, R2PrivateStorageError } from "./r2PrivateStorage";
import { toPrivateObjectRef } from "@shared/privateFileRef";
import { TRPCError } from "@trpc/server";
import {
  normalizeMimeType,
  validateMagicBytes,
  sanitizeLogData,
} from "../helpers/storageErrorHandler";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

/** The exact four customer-facing Thai messages this service ever shows -
 *  every failure path below maps to exactly one of these, never a raw SDK/
 *  driver error and never the generic English tRPC fallback (see
 *  server/_core/trpc.ts's CLIENT_SAFE_ERROR_CODES - every TRPCError thrown
 *  here uses a code in that allowlist specifically so these messages are
 *  not silently replaced before reaching the client). */
const CUSTOMER_MESSAGES = {
  configUnavailable: "ระบบแนบสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน",
  temporaryUploadProblem: "ไม่สามารถอัปโหลดสลิปได้ชั่วคราว กรุณาลองใหม่อีกครั้ง",
  fileTooLarge: "ไฟล์มีขนาดใหญ่เกินกำหนด กรุณาเลือกไฟล์ที่เล็กลง",
  invalidFile: "ไฟล์ไม่ถูกต้อง กรุณาใช้ไฟล์ JPG, PNG หรือ PDF",
} as const;

/** Appends a safe, opaque reference ID an admin can grep for in server logs
 *  (every [SlipUpload] log line below is tagged with the same requestId) -
 *  never any internal storage detail (no endpoint, bucket, key, category,
 *  or SDK error name is ever part of the customer-visible string). */
function withReferenceId(message: string, requestId: string): string {
  return `${message} (รหัสอ้างอิง: ${requestId})`;
}

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
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: withReferenceId(CUSTOMER_MESSAGES.invalidFile, requestId),
      });
    }

    if (!ALLOWED_MIME_TYPES.includes(normalizedMimeType as any)) {
      console.warn("[SlipUpload]", requestId, "MIME type not allowed:", {
        ...context,
        mimeType: normalizedMimeType,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: withReferenceId(CUSTOMER_MESSAGES.invalidFile, requestId),
      });
    }

    // Step 2: Decode base64 to buffer
    let fileBuffer: Buffer;
    try {
      fileBuffer = base64ToBuffer(input.fileBase64);
      if (fileBuffer.length === 0) {
        throw new Error("Decoded to an empty buffer");
      }
    } catch (error: any) {
      console.warn("[SlipUpload]", requestId, "Invalid base64:", {
        ...context,
      });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: withReferenceId(CUSTOMER_MESSAGES.invalidFile, requestId),
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
        message: withReferenceId(CUSTOMER_MESSAGES.fileTooLarge, requestId),
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
        message: withReferenceId(CUSTOMER_MESSAGES.invalidFile, requestId),
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

    // Step 7: Upload to the PRIVATE R2 bucket - never the public bucket, and
    // never a URL. slipImageUrl is a private object reference
    // ("r2p:payment-slips/...") that only ever resolves to a working link
    // via resolveStoredFileValue() at the moment an authorized reader
    // (admin, OCR) actually needs it - it is never a permanent public URL.
    try {
      const { key } = await putPrivateObject("paymentSlip", fileKey, fileBuffer, normalizedMimeType);
      const slipImageUrl = toPrivateObjectRef(key);

      const isPDF = normalizedMimeType === "application/pdf";
      const userMessage = isPDF
        ? "PDF slips require manual review. We will notify you once approved."
        : "Your slip is being processed. We will notify you once approved.";

      console.info("[SlipUpload]", requestId, "Upload successful:", {
        ...context,
        fileKey: key,
        isPDF,
      });

      return {
        slipImageUrl,
        key: fileKey,
        mimeType: normalizedMimeType,
        size: fileBuffer.length,
        isPDF,
        userMessage,
        orderTotal: input.orderTotal,
      };
    } catch (error: any) {
      // Handle R2PrivateStorageError - map by `.details.retryable` (derived
      // from the safe classifier - see r2ErrorClassifier.ts) to exactly one
      // of the two allowed Thai messages, never forward `.message` (which
      // may echo an underlying SDK error string) to the client, and never
      // log/return anything beyond error.getSafeDetails()'s fixed,
      // allowlisted fields (operation, context, reason, category,
      // retryable, sdkErrorName, httpStatusCode, providerRequestId) - never
      // the bucket, key, endpoint, or credentials. Both SERVICE_UNAVAILABLE
      // paths below rely on that code being in trpc.ts's
      // CLIENT_SAFE_ERROR_CODES allowlist so this message actually survives
      // to the client instead of being replaced by the generic fallback.
      if (error instanceof R2PrivateStorageError) {
        console.error("[SlipUpload]", requestId, "Private R2 upload failed:", {
          ...context,
          ...error.getSafeDetails(),
        });

        const isConfigProblem = error.reason === "not_configured";
        const message = isConfigProblem
          ? CUSTOMER_MESSAGES.configUnavailable
          : error.details?.retryable === false
            ? CUSTOMER_MESSAGES.configUnavailable
            : CUSTOMER_MESSAGES.temporaryUploadProblem;

        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: withReferenceId(message, requestId),
        });
      }

      // Handle other (non-R2) errors - never log the raw message, only a
      // safe, non-leaking classification of the error's own constructor
      // name (e.g. "TypeError") - this is a true catch-all for a bug
      // anywhere else in this function, not a storage-specific failure, so
      // there is no SDK error shape to classify further here.
      console.error("[SlipUpload]", requestId, "Upload error:", {
        ...context,
        errorName: typeof error?.name === "string" ? error.name : "UnknownError",
      });

      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: withReferenceId(CUSTOMER_MESSAGES.temporaryUploadProblem, requestId),
      });
    }
  } catch (error: any) {
    // Re-throw TRPC errors
    if (error instanceof TRPCError) {
      throw error;
    }

    // Catch-all for unexpected errors - never the raw message, only the
    // error's own constructor name (safe, non-leaking classification).
    console.error("[SlipUpload]", requestId, "Unexpected error:", {
      ...context,
      errorName: typeof error?.name === "string" ? error.name : "UnknownError",
    });

    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: withReferenceId(CUSTOMER_MESSAGES.temporaryUploadProblem, requestId),
    });
  }
}
