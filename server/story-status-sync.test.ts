import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Story Status Sync on Browse", () => {
  let testNovelId: number;

  beforeAll(async () => {
    // Create a test novel with storyStatus = "ongoing"
    testNovelId = await db.createNovel({
      title: "Test Story Status Sync Novel",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test Story Status%'`);
    }
  });

  describe("getBrowseCatalog returns storyStatus", () => {
    it("should return storyStatus field in browse results", async () => {
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      // Find our test novel
      const testNovel = result.find((n: any) => n.id === testNovelId);
      expect(testNovel).toBeDefined();
      expect(testNovel?.storyStatus).toBeDefined();
    });

    it("should return 'ongoing' for newly created novel", async () => {
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      expect(testNovel?.storyStatus).toBe("ongoing");
    });

    it("should NOT return old status field", async () => {
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      // The old status field should not be in the result
      expect(testNovel?.status).toBeUndefined();
    });

    it("should reflect storyStatus changes after update", async () => {
      // Update novel to finished
      await db.updateNovel(testNovelId, {
        storyStatus: "finished",
      });

      // Query browse catalog
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      expect(testNovel?.storyStatus).toBe("finished");
    });

    it("should reflect storyStatus changes back to ongoing", async () => {
      // Update novel back to ongoing
      await db.updateNovel(testNovelId, {
        storyStatus: "ongoing",
      });

      // Query browse catalog
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      expect(testNovel?.storyStatus).toBe("ongoing");
    });
  });

  describe("Browse page displays correct storyStatus", () => {
    it("should show 'Ongoing' badge for ongoing novels", async () => {
      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      const displayText = testNovel?.storyStatus === "finished" ? "Finished" : "Ongoing";
      expect(displayText).toBe("Ongoing");
    });

    it("should show 'Finished' badge for finished novels", async () => {
      // Update to finished
      await db.updateNovel(testNovelId, {
        storyStatus: "finished",
      });

      const { items: result } = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
      });
      
      const testNovel = result.find((n: any) => n.id === testNovelId);
      const displayText = testNovel?.storyStatus === "finished" ? "Finished" : "Ongoing";
      expect(displayText).toBe("Finished");
    });
  });
});
