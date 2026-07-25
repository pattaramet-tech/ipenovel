import { describe, it, expect, beforeEach, vi } from "vitest";
import { uploadEpisodeFile, getEpisodeDownloadUrl, validateEpisodeFile } from "./fileService";
import * as r2PrivateStorage from "./r2PrivateStorage";
import * as legacyStorage from "../storage";
import * as db from "../db";

vi.mock("./r2PrivateStorage", async () => {
  const actual = await vi.importActual<typeof import("./r2PrivateStorage")>("./r2PrivateStorage");
  return {
    ...actual,
    putPrivateObject: vi.fn(),
    resolveStoredFileValue: vi.fn(),
  };
});

vi.mock("../storage", () => ({
  storagePut: vi.fn(),
  isStorageReady: vi.fn(() => true),
}));

vi.mock("../db", () => ({
  getEpisodeById: vi.fn(),
  getPurchaseByUserAndEpisode: vi.fn(),
}));

describe("fileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("uploadEpisodeFile", () => {
    it("uploads to the private bucket under episodes/ and returns an r2p: reference", async () => {
      vi.mocked(r2PrivateStorage.putPrivateObject).mockResolvedValueOnce({ key: "episodes/9/123-abc-file.pdf" });

      const result = await uploadEpisodeFile(9, "file.pdf", Buffer.from("pdf-bytes"), "application/pdf");

      expect(result.url).toBe("r2p:episodes/9/123-abc-file.pdf");
      expect(r2PrivateStorage.putPrivateObject).toHaveBeenCalledWith(
        "episodeFile",
        expect.stringMatching(/^episodes\/9\//),
        expect.any(Buffer),
        "application/pdf"
      );
      expect(legacyStorage.storagePut).not.toHaveBeenCalled();
    });

    it("rejects a disallowed MIME type before ever touching storage", async () => {
      await expect(uploadEpisodeFile(9, "file.exe", Buffer.from("x"), "application/x-msdownload")).rejects.toThrow(
        /not allowed/
      );
      expect(r2PrivateStorage.putPrivateObject).not.toHaveBeenCalled();
    });

    it("rejects a file over the 100MB limit before ever touching storage", async () => {
      const big = Buffer.alloc(101 * 1024 * 1024);
      await expect(uploadEpisodeFile(9, "file.pdf", big, "application/pdf")).rejects.toThrow(/100MB/);
      expect(r2PrivateStorage.putPrivateObject).not.toHaveBeenCalled();
    });
  });

  describe("getEpisodeDownloadUrl - entitlement gating", () => {
    it("denies a paid episode with no purchase record, without ever resolving a signed URL", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({ id: 5, isFree: false, fileUrl: "r2p:episodes/5/f.pdf" } as any);
      vi.mocked(db.getPurchaseByUserAndEpisode).mockResolvedValueOnce(undefined as any);

      await expect(getEpisodeDownloadUrl(1, 5)).rejects.toThrow(/not purchased/);
      expect(r2PrivateStorage.resolveStoredFileValue).not.toHaveBeenCalled();
    });

    it("resolves a signed URL for a paid episode only after a purchase record is found", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({ id: 5, isFree: false, fileUrl: "r2p:episodes/5/f.pdf" } as any);
      vi.mocked(db.getPurchaseByUserAndEpisode).mockResolvedValueOnce({ id: 1 } as any);
      vi.mocked(r2PrivateStorage.resolveStoredFileValue).mockResolvedValueOnce("https://signed.example/episodes/5/f.pdf?sig=abc");

      const url = await getEpisodeDownloadUrl(1, 5);

      expect(url).toBe("https://signed.example/episodes/5/f.pdf?sig=abc");
      expect(db.getPurchaseByUserAndEpisode).toHaveBeenCalledWith(1, 5);
      expect(r2PrivateStorage.resolveStoredFileValue).toHaveBeenCalledWith("r2p:episodes/5/f.pdf", "episodeFile");
    });

    it("free episode: checks entitlement (skips purchase lookup) then resolves a signed URL, never returning the raw r2p: reference", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({ id: 6, isFree: true, fileUrl: "r2p:episodes/6/free.pdf" } as any);
      vi.mocked(r2PrivateStorage.resolveStoredFileValue).mockResolvedValueOnce("https://signed.example/episodes/6/free.pdf?sig=xyz");

      const url = await getEpisodeDownloadUrl(1, 6);

      expect(db.getPurchaseByUserAndEpisode).not.toHaveBeenCalled();
      expect(url).toBe("https://signed.example/episodes/6/free.pdf?sig=xyz");
      expect(url).not.toContain("r2p:");
    });

    it("free episode with a legacy https:// fileUrl still works unchanged (no regression)", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({
        id: 7,
        isFree: true,
        fileUrl: "https://media.ipenovel.com/episodes/7/free.pdf",
      } as any);
      vi.mocked(r2PrivateStorage.resolveStoredFileValue).mockResolvedValueOnce("https://media.ipenovel.com/episodes/7/free.pdf");

      const url = await getEpisodeDownloadUrl(1, 7);
      expect(url).toBe("https://media.ipenovel.com/episodes/7/free.pdf");
    });

    it("throws Episode not found for a missing episode", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce(undefined as any);
      await expect(getEpisodeDownloadUrl(1, 999)).rejects.toThrow(/not found/i);
    });

    it("returns an empty string when the episode has no fileUrl at all", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({ id: 8, isFree: true, fileUrl: null } as any);
      const url = await getEpisodeDownloadUrl(1, 8);
      expect(url).toBe("");
      expect(r2PrivateStorage.resolveStoredFileValue).not.toHaveBeenCalled();
    });

    it("never leaks bucket/key/endpoint details when resolution fails", async () => {
      vi.mocked(db.getEpisodeById).mockResolvedValueOnce({ id: 6, isFree: true, fileUrl: "r2p:episodes/6/free.pdf" } as any);
      const { R2PrivateStorageError } = await vi.importActual<typeof import("./r2PrivateStorage")>("./r2PrivateStorage");
      vi.mocked(r2PrivateStorage.resolveStoredFileValue).mockRejectedValueOnce(
        new R2PrivateStorageError("Private R2 storage is not configured - missing env var(s): R2_PRIVATE_BUCKET_NAME", "not_configured")
      );

      try {
        await getEpisodeDownloadUrl(1, 6);
        expect.fail("should have thrown");
      } catch (error: any) {
        expect(error.message).not.toContain("R2_PRIVATE_BUCKET_NAME");
        expect(error.message).not.toMatch(/https?:\/\//);
      }
    });
  });

  describe("validateEpisodeFile", () => {
    it("accepts a valid pdf", () => {
      expect(validateEpisodeFile("book.pdf", "application/pdf", 1000).valid).toBe(true);
    });

    it("rejects an invalid extension", () => {
      const result = validateEpisodeFile("book.exe", "application/pdf", 1000);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/extension/i);
    });
  });
});
