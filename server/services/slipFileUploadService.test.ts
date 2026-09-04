import { describe, it, expect, beforeEach, vi } from "vitest";
import { uploadPaymentSlipFile } from "./slipFileUploadService";
import * as r2PrivateStorage from "./r2PrivateStorage";
import * as db from "../db";
import * as legacyStorage from "../storage";
import { TRPCError } from "@trpc/server";
import { computeSlipFileHash } from "./slipFileHashService";

// Mock the PRIVATE R2 adapter - payment slips must never touch the legacy
// Manus storage proxy (server/storage.ts) after this change.
vi.mock("./r2PrivateStorage", async () => {
  const actual = await vi.importActual<typeof import("./r2PrivateStorage")>("./r2PrivateStorage");
  return {
    ...actual,
    putPrivateObjectCreateOnly: vi.fn(),
  };
});

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db")>("../db");
  return { ...actual, registerImmutableSlipUpload: vi.fn() };
});

// Also mock the legacy module so a static assertion can prove
// uploadPaymentSlipFile never calls it, without needing real Manus config.
vi.mock("../storage", () => ({
  storagePut: vi.fn(),
  isStorageReady: vi.fn(() => true),
}));

describe("uploadPaymentSlipFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.registerImmutableSlipUpload).mockResolvedValue(1);
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
    it.each(["image/jpeg", "image/png", "application/pdf"])(
      "registers the same %s identifier that submission recomputes from stored bytes",
      async (mimeType) => {
        let storedBytes: Uint8Array | undefined;
        vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockImplementationOnce(
          async (_context, key, bytes) => {
            storedBytes = Uint8Array.from(bytes as Buffer);
            return { key };
          }
        );
        const result = await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip",
          mimeType,
          fileBase64: createBase64File(mimeType),
          context: "checkout",
        });
        expect(storedBytes).toBeDefined();
        const recomputedHash = await computeSlipFileHash(result.slipImageUrl, {
          resolveStoredFileValueFn: async () => "https://signed.example/slip",
          fetchImpl: vi.fn(async () => new Response(storedBytes!)),
        });
        expect(recomputedHash).toMatch(/^[a-f0-9]{64}$/);
        expect(db.registerImmutableSlipUpload).toHaveBeenCalledWith({
          objectIdentity: result.slipImageUrl,
          ownerUserId: 123,
          fileHash: recomputedHash,
          objectSize: storedBytes!.byteLength,
          mimeType,
        });
      }
    );

    it("should upload valid JPEG file to the private bucket and return an r2p: reference", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
        orderTotal: 100,
      });

      expect(result.slipImageUrl).toBe("r2p:payment-slips/123/xxx-file.jpg");
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.isPDF).toBe(false);
      expect(result.size).toBeGreaterThan(0);
      expect(vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly)).toHaveBeenCalledWith(
        "paymentSlip",
        expect.stringMatching(/^payment-slips\/123\//),
        expect.any(Buffer),
        "image/jpeg"
      );
    });

    it("should upload valid PNG file and return an r2p: reference", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.png",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.png",
        mimeType: "image/png",
        fileBase64: createBase64File("image/png"),
        context: "payment_page",
      });

      expect(result.slipImageUrl).toBe("r2p:payment-slips/123/xxx-file.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.isPDF).toBe(false);
    });

    it("should upload valid PDF file and return manual review message", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.pdf",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.pdf",
        mimeType: "application/pdf",
        fileBase64: createBase64File("application/pdf"),
        context: "payment_page",
      });

      expect(result.slipImageUrl).toBe("r2p:payment-slips/123/xxx-file.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.isPDF).toBe(true);
      expect(result.userMessage).toContain("manual review");
    });
  });

  describe("MIME type validation", () => {
    it("should normalize image/jpg to image/jpeg", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
      });

      expect(result.mimeType).toBe("image/jpeg");
      const call = vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mock.calls[0];
      expect(call[3]).toBe("image/jpeg");
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
        // Unified "invalid file" wording (task requirement) - the same
        // message shown for any rejected-file reason (MIME, base64, magic
        // bytes), not a MIME-specific string, so it stays correct even if
        // the exact rejection reason changes later.
        expect(error.message).toContain("ไฟล์ไม่ถูกต้อง");
        expect(error.message).toContain("JPG");
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
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "max.jpg",
        mimeType: "image/jpeg",
        fileBase64: maxBase64,
        context: "payment_page",
      });

      expect(result.slipImageUrl).toBe("r2p:payment-slips/123/xxx-file.jpg");
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

    it("should reject base64 that decodes to an empty (zero-byte) file", async () => {
      // zod's fileBase64 min(1) at the router boundary only checks the
      // STRING length, not the decoded byte length - a client could still
      // send a short, syntactically-valid base64 string that decodes to
      // nothing. Never let an empty buffer reach putPrivateObject().
      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: "",
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain("ไฟล์ไม่ถูกต้อง");
      }
      expect(r2PrivateStorage.putPrivateObjectCreateOnly).not.toHaveBeenCalled();
    });
  });

  describe("Storage error handling", () => {
    it("should return SERVICE_UNAVAILABLE with the config-unavailable Thai message for missing private R2 config", async () => {
      const { R2PrivateStorageError } = await import("./r2PrivateStorage");
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockRejectedValueOnce(
        new R2PrivateStorageError(
          "Private R2 storage is not configured - missing env var(s): R2_PRIVATE_BUCKET_NAME",
          "not_configured",
          { category: "CONFIG_MISSING", retryable: false }
        )
      );

      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(error.message).toContain("ระบบแนบสลิปยังไม่พร้อมใช้งาน");
        // Safe reference ID present so an admin can correlate this exact
        // customer error with the server-side [SlipUpload] log line.
        expect(error.message).toMatch(/รหัสอ้างอิง: upload-/);
      }
    });

    it("should never leak the underlying error message to the client on a missing-config failure", async () => {
      const { R2PrivateStorageError } = await import("./r2PrivateStorage");
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockRejectedValueOnce(
        new R2PrivateStorageError("Private R2 storage is not configured - missing env var(s): R2_PRIVATE_SECRET_ACCESS_KEY", "not_configured")
      );

      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).not.toContain("R2_PRIVATE_SECRET_ACCESS_KEY");
        expect(error.message).not.toMatch(/https?:\/\//);
      }
    });

    it("should return SERVICE_UNAVAILABLE with the temporary-retry Thai message for a retryable upload failure", async () => {
      const { R2PrivateStorageError } = await import("./r2PrivateStorage");
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockRejectedValueOnce(
        new R2PrivateStorageError("Private R2 upload failed", "upload_failed", {
          key: "payment-slips/123/x.jpg",
          context: "paymentSlip",
          category: "NETWORK_FAILED",
          retryable: true,
        })
      );

      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error).toBeInstanceOf(TRPCError);
        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(error.message).toContain("ไม่สามารถอัปโหลดสลิปได้ชั่วคราว");
        expect(error.message).toMatch(/รหัสอ้างอิง: upload-/);
      }
    });

    it("should return SERVICE_UNAVAILABLE with the config/admin Thai message for a non-retryable (e.g. access-denied) upload failure", async () => {
      const { R2PrivateStorageError } = await import("./r2PrivateStorage");
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockRejectedValueOnce(
        new R2PrivateStorageError("Private R2 upload failed", "upload_failed", {
          key: "payment-slips/123/x.jpg",
          context: "paymentSlip",
          category: "ACCESS_DENIED",
          retryable: false,
        })
      );

      try {
        await uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.jpg",
          mimeType: "image/jpeg",
          fileBase64: createBase64File("image/jpeg"),
          context: "payment_page",
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(error.message).toContain("ระบบแนบสลิปยังไม่พร้อมใช้งาน");
      }
    });
  });

  describe("Order total validation", () => {
    it("should accept valid order total", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
      });

      const result = await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
        orderTotal: 99.99,
      });

      expect(result.orderTotal).toBe(99.99);
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
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
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

      expect(result.slipImageUrl).toBe("r2p:payment-slips/123/xxx-file.jpg");
    });
  });

  describe("Manus storage removal (static assertion)", () => {
    it("never calls the legacy storagePut, for any successful upload", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObjectCreateOnly).mockResolvedValueOnce({
        key: "payment-slips/123/xxx-file.jpg",
      });

      await uploadPaymentSlipFile({
        userId: 123,
        fileName: "slip.jpg",
        mimeType: "image/jpeg",
        fileBase64: createBase64File("image/jpeg"),
        context: "payment_page",
      });

      expect(legacyStorage.storagePut).not.toHaveBeenCalled();
      expect(r2PrivateStorage.putPrivateObjectCreateOnly).toHaveBeenCalledTimes(1);
    });

    it("never calls the legacy storagePut, even when the upload path is never reached (validation failure)", async () => {
      await expect(
        uploadPaymentSlipFile({
          userId: 123,
          fileName: "slip.webp",
          mimeType: "image/webp",
          fileBase64: createBase64File("image/webp"),
          context: "payment_page",
        })
      ).rejects.toThrow();

      expect(legacyStorage.storagePut).not.toHaveBeenCalled();
    });
  });
});
