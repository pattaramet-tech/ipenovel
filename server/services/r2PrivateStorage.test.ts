import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the private-R2 adapter. Every test imports the module
 * fresh (vi.resetModules() + dynamic import) so the module-level S3Client
 * cache (cachedClient) never leaks state between a "missing config" test
 * and a "configured" test - see getPrivateR2Client() in r2PrivateStorage.ts.
 */

const FULL_ENV = {
  r2PrivateAccountId: "test-account",
  r2PrivateAccessKeyId: "test-access-key-id",
  r2PrivateSecretAccessKey: "super-secret-value-should-never-be-logged",
  r2PrivateEndpoint: "https://test-account.r2.cloudflarestorage.com",
  r2PrivateBucketName: "test-private-bucket",
  r2PrivateSignedUrlExpiresSeconds: 900,
};

let mockEnv: typeof FULL_ENV;

vi.mock("../_core/env", () => ({
  get ENV() {
    return mockEnv;
  },
}));

const sendMock = vi.fn();
const putObjectCommandMock = vi.fn((input: any) => ({ __type: "PutObjectCommand", input }));
const getObjectCommandMock = vi.fn((input: any) => ({ __type: "GetObjectCommand", input }));
const deleteObjectCommandMock = vi.fn((input: any) => ({ __type: "DeleteObjectCommand", input }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: putObjectCommandMock,
  GetObjectCommand: getObjectCommandMock,
  DeleteObjectCommand: deleteObjectCommandMock,
}));

const getSignedUrlMock = vi.fn();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

async function freshModule() {
  vi.resetModules();
  return import("./r2PrivateStorage");
}

describe("r2PrivateStorage", () => {
  beforeEach(() => {
    mockEnv = { ...FULL_ENV };
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
    putObjectCommandMock.mockClear();
    getObjectCommandMock.mockClear();
    deleteObjectCommandMock.mockClear();
  });

  describe("isR2PrivateConfigured", () => {
    it("is true when every env var is present", async () => {
      const mod = await freshModule();
      expect(mod.isR2PrivateConfigured()).toBe(true);
    });

    it.each([
      "r2PrivateAccountId",
      "r2PrivateAccessKeyId",
      "r2PrivateSecretAccessKey",
      "r2PrivateEndpoint",
      "r2PrivateBucketName",
    ] as const)("is false when %s is missing", async (field) => {
      mockEnv = { ...FULL_ENV, [field]: "" };
      const mod = await freshModule();
      expect(mod.isR2PrivateConfigured()).toBe(false);
    });
  });

  describe("putPrivateObject", () => {
    it("uploads to the configured bucket and returns only the key (never a URL)", async () => {
      sendMock.mockResolvedValueOnce({});
      const mod = await freshModule();

      const result = await mod.putPrivateObject("paymentSlip", "payment-slips/42/slip.jpg", Buffer.from("data"), "image/jpeg");

      expect(result).toEqual({ key: "payment-slips/42/slip.jpg" });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(putObjectCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: "test-private-bucket", Key: "payment-slips/42/slip.jpg", ContentType: "image/jpeg" })
      );
    });

    it("strips a leading slash from an otherwise-valid key", async () => {
      sendMock.mockResolvedValueOnce({});
      const mod = await freshModule();
      const result = await mod.putPrivateObject("episodeFile", "/episodes/9/file.pdf", Buffer.from("x"), "application/pdf");
      expect(result.key).toBe("episodes/9/file.pdf");
    });

    it("throws not_configured and never calls S3 when a private-R2 env var is missing", async () => {
      mockEnv = { ...FULL_ENV, r2PrivateBucketName: "" };
      const mod = await freshModule();

      await expect(
        mod.putPrivateObject("paymentSlip", "payment-slips/1/x.jpg", Buffer.from("x"), "image/jpeg")
      ).rejects.toMatchObject({ reason: "not_configured" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("throws upload_failed when the S3 call rejects", async () => {
      sendMock.mockRejectedValueOnce(new Error("network blip"));
      const mod = await freshModule();

      await expect(
        mod.putPrivateObject("paymentSlip", "payment-slips/1/x.jpg", Buffer.from("x"), "image/jpeg")
      ).rejects.toMatchObject({ reason: "upload_failed" });
    });

    describe("key safety (context: paymentSlip requires payment-slips/ prefix)", () => {
      it.each([
        ["empty key", ""],
        ["wrong prefix", "episodes/1/x.jpg"],
        ["path traversal", "payment-slips/../secrets/x.jpg"],
        ["backslash", "payment-slips\\1\\x.jpg"],
        ["null byte", "payment-slips/1/x\x00.jpg"],
        ["control character", "payment-slips/1/x\x01.jpg"],
      ])("rejects %s without ever calling S3", async (_label, badKey) => {
        const mod = await freshModule();
        await expect(
          mod.putPrivateObject("paymentSlip", badKey, Buffer.from("x"), "image/jpeg")
        ).rejects.toMatchObject({ reason: "invalid_reference" });
        expect(sendMock).not.toHaveBeenCalled();
      });
    });

    it("rejects an episodes/ key when the context is paymentSlip (cross-context confusion)", async () => {
      const mod = await freshModule();
      await expect(
        mod.putPrivateObject("paymentSlip", "episodes/1/file.pdf", Buffer.from("x"), "application/pdf")
      ).rejects.toMatchObject({ reason: "invalid_reference" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("rejects a payment-slips/ key when the context is episodeFile (cross-context confusion)", async () => {
      const mod = await freshModule();
      await expect(
        mod.putPrivateObject("episodeFile", "payment-slips/1/slip.jpg", Buffer.from("x"), "image/jpeg")
      ).rejects.toMatchObject({ reason: "invalid_reference" });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("getPrivateObjectSignedUrl", () => {
    it("defaults to the configured expiry (900s) when none is passed", async () => {
      getSignedUrlMock.mockResolvedValueOnce("https://signed.example/payment-slips/1/x.jpg?X-Amz-Signature=abc");
      const mod = await freshModule();

      await mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/1/x.jpg");

      expect(getSignedUrlMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ __type: "GetObjectCommand" }),
        { expiresIn: 900 }
      );
    });

    it("honors a custom expiry in seconds", async () => {
      getSignedUrlMock.mockResolvedValueOnce("https://signed.example/x");
      const mod = await freshModule();

      await mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/1/x.jpg", 120);

      expect(getSignedUrlMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 120 });
    });

    it("returns an expiring URL, i.e. the presigner is always invoked with an explicit expiresIn", async () => {
      getSignedUrlMock.mockResolvedValueOnce("https://signed.example/x");
      const mod = await freshModule();
      await mod.getPrivateObjectSignedUrl("episodeFile", "episodes/1/f.pdf");
      const call = getSignedUrlMock.mock.calls[0];
      expect(call[2]).toHaveProperty("expiresIn");
      expect(typeof call[2].expiresIn).toBe("number");
      expect(call[2].expiresIn).toBeGreaterThan(0);
    });

    it("throws not_configured and never calls the presigner when misconfigured", async () => {
      mockEnv = { ...FULL_ENV, r2PrivateAccessKeyId: "" };
      const mod = await freshModule();
      await expect(mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/1/x.jpg")).rejects.toMatchObject({
        reason: "not_configured",
      });
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    });

    it("throws download_failed when the presigner throws", async () => {
      getSignedUrlMock.mockRejectedValueOnce(new Error("boom"));
      const mod = await freshModule();
      await expect(mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/1/x.jpg")).rejects.toMatchObject({
        reason: "download_failed",
      });
    });

    it("rejects an unsafe key before ever calling the presigner", async () => {
      const mod = await freshModule();
      await expect(mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/../x.jpg")).rejects.toMatchObject({
        reason: "invalid_reference",
      });
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    });
  });

  describe("deletePrivateObject", () => {
    it("sends a DeleteObjectCommand for the configured bucket/key", async () => {
      sendMock.mockResolvedValueOnce({});
      const mod = await freshModule();
      await mod.deletePrivateObject("paymentSlip", "payment-slips/1/x.jpg");
      expect(deleteObjectCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: "test-private-bucket", Key: "payment-slips/1/x.jpg" })
      );
    });

    it("throws delete_failed when the S3 call rejects", async () => {
      sendMock.mockRejectedValueOnce(new Error("boom"));
      const mod = await freshModule();
      await expect(mod.deletePrivateObject("paymentSlip", "payment-slips/1/x.jpg")).rejects.toMatchObject({
        reason: "delete_failed",
      });
    });

    it("rejects an unsafe key before ever calling S3", async () => {
      const mod = await freshModule();
      await expect(mod.deletePrivateObject("episodeFile", "episodes/../x.pdf")).rejects.toMatchObject({
        reason: "invalid_reference",
      });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("resolveStoredFileValue", () => {
    it("returns null for empty/null/undefined input", async () => {
      const mod = await freshModule();
      expect(await mod.resolveStoredFileValue(null, "paymentSlip")).toBeNull();
      expect(await mod.resolveStoredFileValue(undefined, "paymentSlip")).toBeNull();
      expect(await mod.resolveStoredFileValue("", "paymentSlip")).toBeNull();
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    });

    it("passes a legacy https:// URL through completely unchanged, never touching R2", async () => {
      const mod = await freshModule();
      const legacy = "https://media.ipenovel.com/novel-covers/1.webp";
      expect(await mod.resolveStoredFileValue(legacy, "paymentSlip")).toBe(legacy);
      expect(getSignedUrlMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("passes a legacy http:// URL through unchanged too", async () => {
      const mod = await freshModule();
      const legacy = "http://old-manus-storage.example.com/file.pdf";
      expect(await mod.resolveStoredFileValue(legacy, "episodeFile")).toBe(legacy);
    });

    it("resolves an r2p: reference to a signed URL", async () => {
      getSignedUrlMock.mockResolvedValueOnce("https://signed.example/payment-slips/1/x.jpg?X-Amz-Signature=abc");
      const mod = await freshModule();

      const result = await mod.resolveStoredFileValue("r2p:payment-slips/1/x.jpg", "paymentSlip");

      expect(result).toBe("https://signed.example/payment-slips/1/x.jpg?X-Amz-Signature=abc");
      expect(getObjectCommandMock).toHaveBeenCalledWith(expect.objectContaining({ Key: "payment-slips/1/x.jpg" }));
    });

    it("never caches a signed URL - two resolves of the same reference call the presigner twice", async () => {
      getSignedUrlMock.mockResolvedValueOnce("https://signed.example/a?sig=1").mockResolvedValueOnce("https://signed.example/a?sig=2");
      const mod = await freshModule();

      const first = await mod.resolveStoredFileValue("r2p:payment-slips/1/x.jpg", "paymentSlip");
      const second = await mod.resolveStoredFileValue("r2p:payment-slips/1/x.jpg", "paymentSlip");

      expect(getSignedUrlMock).toHaveBeenCalledTimes(2);
      expect(first).not.toBe(second);
    });
  });

  describe("credential/secret safety", () => {
    it("R2PrivateStorageError.getSafeDetails() never includes bucket, endpoint, or credential values", async () => {
      const mod = await freshModule();
      const error = new mod.R2PrivateStorageError("Private R2 upload failed", "upload_failed", {
        key: "payment-slips/1/x.jpg",
        context: "paymentSlip",
      });
      const details = error.getSafeDetails();
      const serialized = JSON.stringify(details);
      expect(serialized).not.toContain(FULL_ENV.r2PrivateSecretAccessKey);
      expect(serialized).not.toContain(FULL_ENV.r2PrivateAccessKeyId);
      expect(serialized).not.toContain(FULL_ENV.r2PrivateBucketName);
      expect(serialized).not.toContain(FULL_ENV.r2PrivateEndpoint);
      expect(details).toEqual({ reason: "upload_failed", context: "paymentSlip", key: "payment-slips/1/x.jpg" });
    });

    it("never logs the secret access key or a full signed URL to the console on any code path", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      try {
        const signedUrl = "https://test-private-bucket.r2.cloudflarestorage.com/payment-slips/1/x.jpg?X-Amz-Signature=deadbeef&X-Amz-Credential=abc";
        getSignedUrlMock.mockResolvedValueOnce(signedUrl);
        sendMock.mockRejectedValueOnce(new Error("boom"));

        const mod = await freshModule();

        // Successful signed-URL resolution.
        await mod.getPrivateObjectSignedUrl("paymentSlip", "payment-slips/1/x.jpg");
        // A failing upload (triggers the adapter's own console.error).
        await mod.putPrivateObject("paymentSlip", "payment-slips/1/y.jpg", Buffer.from("x"), "image/jpeg").catch(() => {});

        const allCalls = [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls, ...consoleInfoSpy.mock.calls];
        const serialized = JSON.stringify(allCalls);

        expect(serialized).not.toContain(FULL_ENV.r2PrivateSecretAccessKey);
        expect(serialized).not.toContain(FULL_ENV.r2PrivateAccessKeyId);
        expect(serialized).not.toContain("X-Amz-Signature");
        expect(serialized).not.toContain(signedUrl);
      } finally {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
        consoleInfoSpy.mockRestore();
      }
    });
  });
});
