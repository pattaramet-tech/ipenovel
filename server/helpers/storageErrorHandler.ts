/**
 * Structured storage error handling with diagnostics
 * Provides detailed error information without exposing secrets
 */

export class StorageUploadError extends Error {
  constructor(
    public statusCode: number | null,
    public statusText: string | null,
    public responseSnippet: string,
    public uploadPath: string,
    public hasBaseUrl: boolean,
    public hasApiKey: boolean,
    message: string
  ) {
    super(message);
    this.name = "StorageUploadError";
  }

  /**
   * Get safe error details for logging (no secrets exposed)
   */
  getSafeDetails() {
    return {
      statusCode: this.statusCode,
      statusText: this.statusText,
      responseSnippet: this.responseSnippet.substring(0, 200),
      uploadPath: this.uploadPath,
      credentialsConfigured: {
        baseUrl: this.hasBaseUrl,
        apiKey: this.hasApiKey,
      },
    };
  }

  /**
   * Map to TRPC error code and user-friendly message
   */
  toTRPCError() {
    // Missing credentials
    if (!this.hasBaseUrl || !this.hasApiKey) {
      return {
        code: "SERVICE_UNAVAILABLE" as const,
        message: "ระบบอัปโหลดไฟล์ยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน",
      };
    }

    // Auth errors
    if (this.statusCode === 401 || this.statusCode === 403) {
      return {
        code: "SERVICE_UNAVAILABLE" as const,
        message: "ระบบจัดเก็บไฟล์มีปัญหา กรุณาติดต่อแอดมิน",
      };
    }

    // Payload too large
    if (this.statusCode === 413) {
      return {
        code: "BAD_REQUEST" as const,
        message: "ไฟล์ใหญ่เกินไป กรุณาอัปโหลดไฟล์ที่เล็กกว่า 5MB",
      };
    }

    // Network/timeout errors
    if (this.statusCode === null) {
      return {
        code: "SERVICE_UNAVAILABLE" as const,
        message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      };
    }

    // Other server errors
    if (this.statusCode && this.statusCode >= 500) {
      return {
        code: "SERVICE_UNAVAILABLE" as const,
        message: "ระบบจัดเก็บไฟล์มีปัญหา กรุณาลองใหม่อีกครั้ง",
      };
    }

    // Generic error
    return {
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    };
  }
}

/**
 * MIME type normalization
 */
export function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().trim();

  // Normalize common variations
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/heic" || normalized === "image/heif" || normalized === "image/webp") {
    throw new Error("ไฟล์นี้ยังไม่รองรับ กรุณาอัปโหลด JPG, PNG หรือ PDF");
  }

  return normalized;
}

/**
 * Magic bytes validation
 */
export function validateMagicBytes(buffer: Buffer, expectedMimeType: string): boolean {
  if (buffer.length < 4) return false;

  const magicBytes = buffer.slice(0, 4);

  switch (expectedMimeType) {
    case "image/jpeg":
      // JPEG: FF D8 FF
      return magicBytes[0] === 0xff && magicBytes[1] === 0xd8 && magicBytes[2] === 0xff;

    case "image/png":
      // PNG: 89 50 4E 47
      return (
        magicBytes[0] === 0x89 &&
        magicBytes[1] === 0x50 &&
        magicBytes[2] === 0x4e &&
        magicBytes[3] === 0x47
      );

    case "application/pdf":
      // PDF: 25 50 44 46 (%PDF)
      return (
        magicBytes[0] === 0x25 &&
        magicBytes[1] === 0x50 &&
        magicBytes[2] === 0x44 &&
        magicBytes[3] === 0x46
      );

    default:
      return false;
  }
}

/**
 * Sanitize log data
 */
export function sanitizeLogData(data: any): any {
  if (typeof data !== "object" || data === null) return data;

  const sanitized: any = {};
  for (const [key, value] of Object.entries(data)) {
    // Skip secrets
    if (key.includes("secret") || key.includes("key") || key.includes("token")) {
      sanitized[key] = "[REDACTED]";
    } else if (key.includes("base64") || key.includes("content")) {
      sanitized[key] = typeof value === "string" ? `[${value.length} chars]` : value;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
