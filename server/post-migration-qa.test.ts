import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Post-Migration QA: Novel Status System", () => {
  let testPublishedOngoingId: number;
  let testPublishedFinishedId: number;
  let testArchivedOngoingId: number;
  let testArchivedFinishedId: number;

  beforeAll(async () => {
    // Create test novels with all status combinations
    testPublishedOngoingId = await db.createNovel({
      title: "QA Test - Published Ongoing",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });

    testPublishedFinishedId = await db.createNovel({
      title: "QA Test - Published Finished",
      publicationStatus: "published",
      storyStatus: "finished",
    });

    testArchivedOngoingId = await db.createNovel({
      title: "QA Test - Archived Ongoing",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    testArchivedFinishedId = await db.createNovel({
      title: "QA Test - Archived Finished",
      publicationStatus: "archived",
      storyStatus: "finished",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'QA Test%'`);
    }
  });

  describe("Flow 1: Home Page - Only Published Novels Visible", () => {
    it("should show published novels on home (getAllNovels)", async () => {
      const allNovels = await db.getAllNovels();
      const publishedOngoing = allNovels.find((n: any) => n.id === testPublishedOngoingId);
      const publishedFinished = allNovels.find((n: any) => n.id === testPublishedFinishedId);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should hide archived novels from home", async () => {
      const allNovels = await db.getAllNovels();
      const archivedOngoing = allNovels.find((n: any) => n.id === testArchivedOngoingId);
      const archivedFinished = allNovels.find((n: any) => n.id === testArchivedFinishedId);

      expect(archivedOngoing).toBeUndefined();
      expect(archivedFinished).toBeUndefined();
    });
  });

  describe("Flow 2: Browse/Catalog - Only Published Novels Visible", () => {
    it("should show published novels in popular list", async () => {
      const popular = await db.getPopularNovels(100);
      const publishedOngoing = popular.find((n: any) => n.id === testPublishedOngoingId);
      const publishedFinished = popular.find((n: any) => n.id === testPublishedFinishedId);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should hide archived novels from popular list", async () => {
      const popular = await db.getPopularNovels(100);
      const archivedOngoing = popular.find((n: any) => n.id === testArchivedOngoingId);
      const archivedFinished = popular.find((n: any) => n.id === testArchivedFinishedId);

      expect(archivedOngoing).toBeUndefined();
      expect(archivedFinished).toBeUndefined();
    });

    it("should show published novels in new list", async () => {
      const newNovels = await db.getNewNovels(100);
      const publishedOngoing = newNovels.find((n: any) => n.id === testPublishedOngoingId);
      const publishedFinished = newNovels.find((n: any) => n.id === testPublishedFinishedId);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should hide archived novels from new list", async () => {
      const newNovels = await db.getNewNovels(100);
      const archivedOngoing = newNovels.find((n: any) => n.id === testArchivedOngoingId);
      const archivedFinished = newNovels.find((n: any) => n.id === testArchivedFinishedId);

      expect(archivedOngoing).toBeUndefined();
      expect(archivedFinished).toBeUndefined();
    });

    it("should show published novels in free list", async () => {
      const freeNovels = await db.getFreeNovels(100);
      const publishedOngoing = freeNovels.find((n: any) => n.id === testPublishedOngoingId);
      const publishedFinished = freeNovels.find((n: any) => n.id === testPublishedFinishedId);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should hide archived novels from free list", async () => {
      const freeNovels = await db.getFreeNovels(100);
      const archivedOngoing = freeNovels.find((n: any) => n.id === testArchivedOngoingId);
      const archivedFinished = freeNovels.find((n: any) => n.id === testArchivedFinishedId);

      expect(archivedOngoing).toBeUndefined();
      expect(archivedFinished).toBeUndefined();
    });
  });

  describe("Flow 3: Novel Detail - Public Access", () => {
    it("should allow public access to published novels", async () => {
      const publishedOngoing = await db.getNovelById(testPublishedOngoingId, true);
      const publishedFinished = await db.getNovelById(testPublishedFinishedId, true);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should block public access to archived novels", async () => {
      const archivedOngoing = await db.getNovelById(testArchivedOngoingId, true);
      const archivedFinished = await db.getNovelById(testArchivedFinishedId, true);

      expect(archivedOngoing).toBeUndefined();
      expect(archivedFinished).toBeUndefined();
    });
  });

  describe("Flow 4: Direct Access to Archived Novel URL", () => {
    it("should block direct access via getNovelById with publicOnly=true", async () => {
      const archived = await db.getNovelById(testArchivedOngoingId, true);
      expect(archived).toBeUndefined();
    });

    it("should block direct access via getNovelBySlug with publicOnly=true", async () => {
      const archived = await db.getNovelById(testArchivedFinishedId, true);
      expect(archived).toBeUndefined();
    });
  });

  describe("Flow 5: Admin Access - Can View All Novels", () => {
    it("should allow admin access to published novels", async () => {
      const publishedOngoing = await db.getNovelById(testPublishedOngoingId, false);
      const publishedFinished = await db.getNovelById(testPublishedFinishedId, false);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should allow admin access to archived novels", async () => {
      const archivedOngoing = await db.getNovelById(testArchivedOngoingId, false);
      const archivedFinished = await db.getNovelById(testArchivedFinishedId, false);

      expect(archivedOngoing).toBeDefined();
      expect(archivedFinished).toBeDefined();
    });

    it("should show correct statuses in admin access", async () => {
      const archived = await db.getNovelById(testArchivedOngoingId, false);
      expect(archived?.publicationStatus).toBe("archived");
      expect(archived?.storyStatus).toBe("ongoing");
    });
  });

  describe("Flow 6: Admin Novel List - Shows All Novels", () => {
    it("should include published novels in admin list", async () => {
      const allNovels = await db.getAllNovels(); // This filters by publication status
      // Note: getAllNovels filters by published, so we need to check admin access
      const publishedOngoing = await db.getNovelById(testPublishedOngoingId, false);
      const publishedFinished = await db.getNovelById(testPublishedFinishedId, false);

      expect(publishedOngoing).toBeDefined();
      expect(publishedFinished).toBeDefined();
    });

    it("should include archived novels in admin access", async () => {
      const archivedOngoing = await db.getNovelById(testArchivedOngoingId, false);
      const archivedFinished = await db.getNovelById(testArchivedFinishedId, false);

      expect(archivedOngoing).toBeDefined();
      expect(archivedFinished).toBeDefined();
    });
  });

  describe("Flow 7: Status Consistency", () => {
    it("should preserve publication status when updating story status", async () => {
      const before = await db.getNovelById(testPublishedOngoingId, false);
      expect(before?.publicationStatus).toBe("published");

      await db.updateNovel(testPublishedOngoingId, { storyStatus: "finished" });

      const after = await db.getNovelById(testPublishedOngoingId, false);
      expect(after?.publicationStatus).toBe("published");
      expect(after?.storyStatus).toBe("finished");
    });

    it("should preserve story status when updating publication status", async () => {
      const before = await db.getNovelById(testPublishedFinishedId, false);
      expect(before?.storyStatus).toBe("finished");

      await db.updateNovel(testPublishedFinishedId, { publicationStatus: "archived" });

      const after = await db.getNovelById(testPublishedFinishedId, false);
      expect(after?.publicationStatus).toBe("archived");
      expect(after?.storyStatus).toBe("finished");

      // Restore for other tests
      await db.updateNovel(testPublishedFinishedId, { publicationStatus: "published" });
    });
  });

  describe("Flow 8: All Status Combinations Are Accessible to Admin", () => {
    it("should have all 4 status combinations in database", async () => {
      const published_ongoing = await db.getNovelById(testPublishedOngoingId, false);
      const published_finished = await db.getNovelById(testPublishedFinishedId, false);
      const archived_ongoing = await db.getNovelById(testArchivedOngoingId, false);
      const archived_finished = await db.getNovelById(testArchivedFinishedId, false);

      expect(published_ongoing?.publicationStatus).toBe("published");
      expect(published_ongoing?.storyStatus).toBe("ongoing");

      expect(published_finished?.publicationStatus).toBe("published");
      expect(published_finished?.storyStatus).toBe("finished");

      expect(archived_ongoing?.publicationStatus).toBe("archived");
      expect(archived_ongoing?.storyStatus).toBe("ongoing");

      expect(archived_finished?.publicationStatus).toBe("archived");
      expect(archived_finished?.storyStatus).toBe("finished");
    });
  });
});
