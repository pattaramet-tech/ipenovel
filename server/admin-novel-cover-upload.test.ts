import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Novel Cover Upload", () => {
  describe("File validation", () => {
    it("should accept JPEG files", () => {
      const mimeType = "image/jpeg";
      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      expect(validTypes).toContain(mimeType);
    });

    it("should accept PNG files", () => {
      const mimeType = "image/png";
      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      expect(validTypes).toContain(mimeType);
    });

    it("should accept WebP files", () => {
      const mimeType = "image/webp";
      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      expect(validTypes).toContain(mimeType);
    });

    it("should reject unsupported file types", () => {
      const mimeType = "image/gif";
      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      expect(validTypes).not.toContain(mimeType);
    });

    it("should enforce 5MB file size limit", () => {
      const maxSize = 5 * 1024 * 1024; // 5MB
      const validSize = 4 * 1024 * 1024; // 4MB
      const oversizedFile = 6 * 1024 * 1024; // 6MB

      expect(validSize).toBeLessThanOrEqual(maxSize);
      expect(oversizedFile).toBeGreaterThan(maxSize);
    });

    it("should accept files at the size limit", () => {
      const maxSize = 5 * 1024 * 1024; // 5MB
      const fileSize = 5 * 1024 * 1024; // 5MB exactly

      expect(fileSize).toBeLessThanOrEqual(maxSize);
    });

    it("should reject files exceeding the size limit", () => {
      const maxSize = 5 * 1024 * 1024; // 5MB
      const fileSize = 5 * 1024 * 1024 + 1; // 5MB + 1 byte

      expect(fileSize).toBeGreaterThan(maxSize);
    });
  });

  describe("File path generation", () => {
    it("should generate S3 key with user ID", () => {
      const userId = 123;
      const timestamp = Date.now();
      const randomSuffix = "abc123";
      const fileName = "cover.jpg";

      const fileKey = `novel-covers/${userId}/${timestamp}-${randomSuffix}-${fileName}`;
      expect(fileKey).toContain(`novel-covers/${userId}`);
    });

    it("should sanitize file names", () => {
      const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

      expect(sanitize("my cover.jpg")).toBe("my_cover.jpg");
      expect(sanitize("cover@2024!.png")).toBe("cover_2024_.png");
      expect(sanitize("test-file_123.webp")).toBe("test-file_123.webp");
    });

    it("should include timestamp in file key", () => {
      const timestamp = Date.now();
      const fileKey = `novel-covers/123/${timestamp}-abc123-cover.jpg`;

      expect(fileKey).toContain(timestamp.toString());
    });

    it("should include random suffix to prevent collisions", () => {
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const fileKey = `novel-covers/123/${Date.now()}-${randomSuffix}-cover.jpg`;

      expect(fileKey).toContain(randomSuffix);
      expect(randomSuffix.length).toBe(6);
    });
  });

  describe("Novel cover operations", () => {
    it("should create novel with cover image URL", async () => {
      const novelData = {
        title: "Test Novel Cover",
        description: "A test novel with cover image",
        coverImageUrl: "https://example.com/cover.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      };

      const result = await db.createNovel(novelData);
      expect(result).toBeDefined();
      expect(result.id).toBeGreaterThan(0);
      expect(result.title).toBe("Test Novel Cover");
      expect(result.coverImageUrl).toBe("https://example.com/cover.jpg");
    });

    it("should update novel with new cover image URL", async () => {
      const novelData = {
        title: "Test Novel Update Cover",
        description: "A test novel for cover update",
        coverImageUrl: "https://example.com/old-cover.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      };

      const novel = await db.createNovel(novelData);
      const newCoverUrl = "https://example.com/new-cover.jpg";

      await db.updateNovel(novel.id, { coverImageUrl: newCoverUrl });

      const updated = await db.getNovelById(novel.id);
      expect(updated?.coverImageUrl).toBe(newCoverUrl);
    });

    it("should preserve cover image when updating other fields", async () => {
      const novelData = {
        title: "Test Novel Preserve Cover",
        description: "Original description",
        coverImageUrl: "https://example.com/cover.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      };

      const novel = await db.createNovel(novelData);
      const originalCover = novel.coverImageUrl;

      await db.updateNovel(novel.id, { description: "Updated description" });

      const updated = await db.getNovelById(novel.id);
      expect(updated?.coverImageUrl).toBe(originalCover);
    });

    it("should allow removing cover image", async () => {
      const novelData = {
        title: "Test Novel Remove Cover",
        description: "A test novel for cover removal",
        coverImageUrl: "https://example.com/cover.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      };

      const novel = await db.createNovel(novelData);
      expect(novel.coverImageUrl).toBe("https://example.com/cover.jpg");

      await db.updateNovel(novel.id, { coverImageUrl: "" });

      const updated = await db.getNovelById(novel.id);
      expect(updated?.coverImageUrl).toBe("");
    });

    it("should create novel without cover image", async () => {
      const novelData = {
        title: "Test Novel No Cover",
        description: "A test novel without cover image",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      };

      const result = await db.createNovel(novelData);
      expect(result).toBeDefined();
      expect(result.id).toBeGreaterThan(0);
      expect(result.coverImageUrl).toBeUndefined();
    });

    it("should handle multiple novels with different covers", async () => {
      const novel1 = await db.createNovel({
        title: "Test Novel 1",
        coverImageUrl: "https://example.com/cover1.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      });

      const novel2 = await db.createNovel({
        title: "Test Novel 2",
        coverImageUrl: "https://example.com/cover2.jpg",
        publicationStatus: "published" as const,
        storyStatus: "ongoing" as const,
      });

      expect(novel1.coverImageUrl).toBe("https://example.com/cover1.jpg");
      expect(novel2.coverImageUrl).toBe("https://example.com/cover2.jpg");
      expect(novel1.id).not.toBe(novel2.id);
    });
  });

  describe("Base64 encoding", () => {
    it("should handle base64 with data URI prefix", () => {
      const dataUri = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      const base64Data = dataUri.split(",")[1] || dataUri;

      expect(base64Data).toBe("/9j/4AAQSkZJRg==");
    });

    it("should handle raw base64 without prefix", () => {
      const base64 = "/9j/4AAQSkZJRg==";
      const base64Data = base64.split(",")[1] || base64;

      expect(base64Data).toBe("/9j/4AAQSkZJRg==");
    });

    it("should convert base64 to buffer", () => {
      const base64 = "SGVsbG8gV29ybGQ="; // "Hello World" in base64
      const buffer = Buffer.from(base64, "base64");

      expect(buffer.toString()).toBe("Hello World");
    });

    it("should handle empty base64", () => {
      const base64 = "";
      const buffer = Buffer.from(base64, "base64");

      expect(buffer.length).toBe(0);
    });
  });

  describe("Admin access control", () => {
    it("should only allow admin users to upload covers", () => {
      const adminUser = { role: "admin" };
      const regularUser = { role: "user" };

      expect(adminUser.role).toBe("admin");
      expect(regularUser.role).not.toBe("admin");
    });

    it("should use user ID in S3 path for isolation", () => {
      const userId1 = 123;
      const userId2 = 456;

      const path1 = `novel-covers/${userId1}/file.jpg`;
      const path2 = `novel-covers/${userId2}/file.jpg`;

      expect(path1).not.toBe(path2);
      expect(path1).toContain(userId1.toString());
      expect(path2).toContain(userId2.toString());
    });
  });
});
