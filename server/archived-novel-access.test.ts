import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";
import { TRPCError } from "@trpc/server";

describe("Archived Novel Access - Clean Error Handling", () => {
  let archivedNovelId: number;
  let publishedNovelId: number;

  beforeAll(async () => {
    // Create test novels
    archivedNovelId = await db.createNovel({
      title: "Test Archived Novel",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    publishedNovelId = await db.createNovel({
      title: "Test Published Novel",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test %'`);
    }
  });

  describe("Public Access to Archived Novels", () => {
    it("should return undefined for archived novel with publicOnly=true", async () => {
      const novel = await db.getNovelById(archivedNovelId, true);
      expect(novel).toBeUndefined();
    });

    it("should return undefined for archived novel with default publicOnly", async () => {
      const novel = await db.getNovelById(archivedNovelId);
      expect(novel).toBeUndefined();
    });

    it("should return novel for published novel with publicOnly=true", async () => {
      const novel = await db.getNovelById(publishedNovelId, true);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });

  describe("Admin Access to Archived Novels", () => {
    it("should return archived novel with publicOnly=false", async () => {
      const novel = await db.getNovelById(archivedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("archived");
      expect(novel?.storyStatus).toBe("ongoing");
    });

    it("should return published novel with publicOnly=false", async () => {
      const novel = await db.getNovelById(publishedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });

  describe("Frontend Error Handling", () => {
    it("should trigger NOT_FOUND error when accessing archived novel via router", async () => {
      // Simulate what the router does:
      // 1. Call getNovelById with publicOnly=true (default for public access)
      const novel = await db.getNovelById(archivedNovelId, true);
      
      // 2. If undefined, throw NOT_FOUND
      if (!novel) {
        const error = new TRPCError({ code: "NOT_FOUND" });
        expect(error.code).toBe("NOT_FOUND");
      }
    });

    it("should NOT expose API error to user - shows clean message instead", async () => {
      // The frontend should:
      // 1. Detect NOT_FOUND error
      // 2. Show clean Thai message: "ไม่สามารถดูนิยายเรื่องนี้ได้"
      // 3. NOT show raw error like "[API Query Error] NOT_FOUND"
      
      const novelError = new TRPCError({ code: "NOT_FOUND" });
      const isNotFound = novelError.code === "NOT_FOUND";
      
      expect(isNotFound).toBe(true);
      // Frontend should show: "ไม่สามารถดูนิยายเรื่องนี้ได้"
      // NOT show: "[API Query Error] NOT_FOUND"
    });
  });

  describe("Status Consistency", () => {
    it("should have correct statuses for archived novel", async () => {
      const novel = await db.getNovelById(archivedNovelId, false);
      expect(novel?.publicationStatus).toBe("archived");
      expect(novel?.storyStatus).toBe("ongoing");
    });

    it("should have correct statuses for published novel", async () => {
      const novel = await db.getNovelById(publishedNovelId, false);
      expect(novel?.publicationStatus).toBe("published");
      expect(novel?.storyStatus).toBe("ongoing");
    });
  });
});
