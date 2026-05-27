import { describe, it, expect, beforeEach, vi } from "vitest";
import { uploadPaymentSlipFile } from "./slipFileUploadService";
import * as storage from "../storage";
import { TRPCError } from "@trpc/server";

// Mock storage module
vi.mock("../storage", () => ({
  storagePut: vi.fn(),
  isStorageReady: vi.fn(() => true),
}));

describe("uploadPaymentSlipFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to create base64 file
  function createBase64File(mimeType: string, size: number = 1000): string {
    const buffer = Buffer.alloc(size);

    // Add magic bytes
    if (mimeType === "image/jpeg") {
      buffer[0] = 0xff;
      buffer[1] = 0xd8;
      buffer[2] = 0xff;
    } else if (mimeType === "image/png") {
      buffer[0] = 0x89;
      buffer[1] = 0x50;
      buffer[2] = 0x4e;
      buffer[3] = 0x47;
    } else if (mimeType === "application/pdf") {
      buffer[0] = 0x25; // %
      buffer[1] = 0x50; // P
      buffer[2] = 0x44; // D
      buffer[3] = 0x46; // F
    }

    return buffer.toString("base64");
  }

  describe("Valid uploads", () => {
    it("should upload valid JPEG file and return URL", async () => {
      const mockUrl = "https://storage.example.com/file.jpg";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
        orderTotal: 100,
      });

      await expect(result.slipImageUrl).toBe(mockUrl);
      await expect(result.mimeType).toBe("image/jpeg");
      await expect(result.isPDF).toBe(false);
      await expect(result.size).toBeGreaterThan(0);
      await expect(vi.mocked(storage.storagePut)).toHaveBeenCalled();
    });

    it("should upload valid PNG file and return URL", async () => {
      const mockUrl = "https://storage.example.com/file.png";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.png",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.png",
        mimeType: "image/png",
        fileBase64: createBase64File("image/png"),
        context: "payment_page",
      });

      await expect(result.slipImageUrl).toBe(mockUrl);
      await expect(result.mimeType).toBe("image/png");
      await expect(result.isPDF).toBe(false);
    });

    it("should upload valid PDF file and return URL with manual review message", async () => {
      const mockUrl = "https://storage.example.com/file.pdf";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.pdf",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.pdf",
        mimeType: "application/pdf",
        fileBase64: createBase64File("application/pdf"),
        context: "payment_page",
      });

      await expect(result.slipImageUrl).toBe(mockUrl);
      await expect(result.mimeType).toBe("application/pdf");
      await expect(result.isPDF).toBe(true);
      await expect(result.userMessage).toContain("manual review");
    });
  });

  describe("MIME type validation", () => {
    it("should normalize image/jpg to image/jpeg", async () => {
      const mockUrl = "https://storage.example.com/file.jpg";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
      });

      await expect(result.mimeType).toBe("image/jpeg");
      const call = vi.mocked(storage.storagePut).mock.calls[0];
      await expect(call[2]).toBe("image/jpeg");
    });

    it("should reject unsupported MIME types", async () => {
      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.webp",
          mimeType: "image/webp",
          fileBase64: createBase64File("image/webp"),
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should reject image/heic with clear Thai message", async () => {
      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.heic",
          mimeType: "image/heic",
          fileBase64: createBase64File("image/heic"),
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        await expect(error.message).toContain("ยังไม่รองรับ");
        await expect(error.message).toContain("JPG");
      }
    });
  });

  describe("File size validation", () => {
    it("should reject files larger than 5MB", async () => {
      const largeBase64 = createBase64File("image/jpeg", 6 * 1024 * 1024);

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "large.jpg",
          mimeType: "image/jpeg",
          fileBase64: largeBase64,
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should accept files exactly at 5MB limit", async () => {
      const maxBase64 = createBase64File("image/jpeg", 5 * 1024 * 1024);
      const mockUrl = "https://storage.example.com/file.jpg";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "max.jpg",
        mimeType: "image/jpeg",
        fileBase64: maxBase64,
        context: "payment_page",
      });

      await expect(result.slipImageUrl).toBe(mockUrl);
    });
  });

  describe("Magic bytes validation", () => {
    it("should reject JPEG with invalid magic bytes", async () => {
      const invalidBase64 = Buffer.alloc(1000).toString("base64");

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "fake.jpg",
          mimeType: "image/jpeg",
          fileBase64: invalidBase64,
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should reject PNG with invalid magic bytes", async () => {
      const invalidBase64 = Buffer.alloc(1000).toString("base64");

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "fake.png",
          mimeType: "image/png",
          fileBase64: invalidBase64,
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should reject PDF with invalid magic bytes", async () => {
      const invalidBase64 = Buffer.alloc(1000).toString("base64");

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "fake.pdf",
          mimeType: "application/pdf",
          fileBase64: invalidBase64,
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("Base64 validation", () => {
    it("should reject invalid base64", async () => {
      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: "not-valid-base64!!!",
          context: "payment_page",
        })
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("Storage error handling", () => {
    it("should return SERVICE_UNAVAILABLE for missing credentials", async () => {
      const { StorageUploadError } = await import("../helpers/storageErrorHandler");
      vi.mocked(storage.storagePut).mockRejectedValueOnce(
        new StorageUploadError(null, null, "Missing config", "path", false, false, "No credentials")
      );

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        })
      ).rejects.toThrow();
    });

    it("should return SERVICE_UNAVAILABLE for 401 auth error", async () => {
      const { StorageUploadError } = await import("../helpers/storageErrorHandler");
      vi.mocked(storage.storagePut).mockRejectedValueOnce(
        new StorageUploadError(401, "Unauthorized", "Auth failed", "path", true, true, "Auth error")
      );

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        })
      ).rejects.toThrow();
    });

    it("should return SERVICE_UNAVAILABLE for network timeout", async () => {
      const { StorageUploadError } = await import("../helpers/storageErrorHandler");
      vi.mocked(storage.storagePut).mockRejectedValueOnce(
        new StorageUploadError(null, null, "Timeout", "path", true, true, "Network timeout")
      );

      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        })
      ).rejects.toThrow();
    });
  });

  describe("Order total validation", () => {
    it("should accept valid order total", async () => {
      const mockUrl = "https://storage.example.com/file.jpg";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
        url: mockUrl,
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
        orderTotal: 99.99,
      });

      await expect(result.orderTotal).toBe(99.99);
    });

    it("should reject invalid order total", async () => {
      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
          orderTotal: "100" as any,
        })
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("Data URL handling", () => {
    it("should handle data URL format", async () => {
      const mockUrl = "https://storage.example.com/file.jpg";
      vi.mocked(storage.storagePut).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
        url: mockUrl,
      });

      const base64 = createBase64File("image/jpeg");
      const dataUrl = `data:image/jpeg;base64,${base64}`;

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: dataUrl,
        context: "payment_page",
      });

      await expect(result.slipImageUrl).toBe(mockUrl);
    });
  });
});
