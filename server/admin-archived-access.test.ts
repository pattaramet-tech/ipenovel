import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Admin Access to Archived Novels", () => {
  let archivedNovelId: number;
  let publishedNovelId: number;

  beforeAll(async () => {
    // Create test novels
    archivedNovelId = await db.createNovel({
      title: "Test Admin Archived Novel",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    publishedNovelId = await db.createNovel({
      title: "Test Admin Published Novel",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test Admin %'`);
    }
  });

  describe("Admin Access (publicOnly=false)", () => {
    it("should return archived novel when publicOnly=false", async () => {
      const novel = await db.getNovelById(archivedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("archived");
    });

    it("should return published novel when publicOnly=false", async () => {
      const novel = await db.getNovelById(publishedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });

  describe("Public Access (publicOnly=true)", () => {
    it("should NOT return archived novel when publicOnly=true", async () => {
      const novel = await db.getNovelById(archivedNovelId, true);
      expect(novel).toBeUndefined();
    });

    it("should return published novel when publicOnly=true", async () => {
      const novel = await db.getNovelById(publishedNovelId, true);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });

  describe("Router Logic Simulation", () => {
    it("should allow admin to access archived novel via router", async () => {
      // Simulate router logic for admin user
      const isAdmin = true;
      const novel = await db.getNovelById(archivedNovelId, !isAdmin); // publicOnly=false for admin
      
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("archived");
    });

    it("should allow public user to access published novel via router", async () => {
      // Simulate router logic for public user
      const isAdmin = false;
      const novel = await db.getNovelById(publishedNovelId, !isAdmin); // publicOnly=true for public
      
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });

    it("should block public user from accessing archived novel via router", async () => {
      // Simulate router logic for public user trying to access archived novel
      const isAdmin = false;
      const novel = await db.getNovelById(archivedNovelId, !isAdmin); // publicOnly=true for public
      
      expect(novel).toBeUndefined();
    });
  });
});
