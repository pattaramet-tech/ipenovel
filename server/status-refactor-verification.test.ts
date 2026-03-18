import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Novel Status Refactoring Verification", () => {
  let testNovelId: number;

  beforeAll(async () => {
    // Clean up any existing test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test%Status%'`);
    }
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test%Status%'`);
    }
  });

  it("should create new novel with default statuses: published + ongoing", async () => {
    const result = await db.createNovel({
      title: "Test Novel - Default Status",
      author: "Test Author",
      description: "Test description",
    });

    expect(result).toBeDefined();
    testNovelId = result;

    const novel = await db.getNovelById(testNovelId, false); // false = admin access
    expect(novel).toBeDefined();
    expect(novel?.publicationStatus).toBe("published");
    expect(novel?.storyStatus).toBe("ongoing");
  });

  it("should create novel with explicit statuses", async () => {
    const result = await db.createNovel({
      title: "Test Novel - Explicit Status",
      author: "Test Author",
      publicationStatus: "archived",
      storyStatus: "finished",
    });

    expect(result).toBeDefined();

    const novel = await db.getNovelById(result, false);
    expect(novel?.publicationStatus).toBe("archived");
    expect(novel?.storyStatus).toBe("finished");

    // Clean up
    await db.deleteNovel(result);
  });

  it("should update novel publication status independently", async () => {
    const result = await db.createNovel({
      title: "Test Novel - Update Publication",
    });

    await db.updateNovel(result, { publicationStatus: "archived" });

    const novel = await db.getNovelById(result, false);
    expect(novel?.publicationStatus).toBe("archived");
    expect(novel?.storyStatus).toBe("ongoing"); // Should remain unchanged

    // Clean up
    await db.deleteNovel(result);
  });

  it("should update novel story status independently", async () => {
    const result = await db.createNovel({
      title: "Test Novel - Update Story",
    });

    await db.updateNovel(result, { storyStatus: "finished" });

    const novel = await db.getNovelById(result, false);
    expect(novel?.publicationStatus).toBe("published"); // Should remain unchanged
    expect(novel?.storyStatus).toBe("finished");

    // Clean up
    await db.deleteNovel(result);
  });

  it("should hide archived novels from public queries", async () => {
    // Create published novel
    const publishedId = await db.createNovel({
      title: "Test Novel - Published Public",
      publicationStatus: "published",
    });

    // Create archived novel
    const archivedId = await db.createNovel({
      title: "Test Novel - Archived Public",
      publicationStatus: "archived",
    });

    // Get all novels (public query)
    const allNovels = await db.getAllNovels();
    const publishedNovel = allNovels.find((n: any) => n.id === publishedId);
    const archivedNovel = allNovels.find((n: any) => n.id === archivedId);

    expect(publishedNovel).toBeDefined();
    expect(archivedNovel).toBeUndefined(); // Should not appear in public query

    // Clean up
    await db.deleteNovel(publishedId);
    await db.deleteNovel(archivedId);
  });

  it("should show published novels regardless of story status", async () => {
    // Create published + ongoing
    const ongoingId = await db.createNovel({
      title: "Test Novel - Published Ongoing",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });

    // Create published + finished
    const finishedId = await db.createNovel({
      title: "Test Novel - Published Finished",
      publicationStatus: "published",
      storyStatus: "finished",
    });

    // Get popular novels (public query)
    const popular = await db.getPopularNovels(10);
    const ongoingNovel = popular.find((n: any) => n.id === ongoingId);
    const finishedNovel = popular.find((n: any) => n.id === finishedId);

    expect(ongoingNovel).toBeDefined();
    expect(finishedNovel).toBeDefined();

    // Clean up
    await db.deleteNovel(ongoingId);
    await db.deleteNovel(finishedId);
  });

  it("should hide archived novels regardless of story status", async () => {
    // Create archived + ongoing
    const archivedOngoingId = await db.createNovel({
      title: "Test Novel - Archived Ongoing",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    // Create archived + finished
    const archivedFinishedId = await db.createNovel({
      title: "Test Novel - Archived Finished",
      publicationStatus: "archived",
      storyStatus: "finished",
    });

    // Get new novels (public query)
    const newNovels = await db.getNewNovels(10);
    const archivedOngoing = newNovels.find((n: any) => n.id === archivedOngoingId);
    const archivedFinished = newNovels.find((n: any) => n.id === archivedFinishedId);

    expect(archivedOngoing).toBeUndefined();
    expect(archivedFinished).toBeUndefined();

    // Clean up
    await db.deleteNovel(archivedOngoingId);
    await db.deleteNovel(archivedFinishedId);
  });

  it("should allow admin to access archived novels via publicOnly=false", async () => {
    const archivedId = await db.createNovel({
      title: "Test Novel - Admin Access Archived",
      publicationStatus: "archived",
    });

    // Public access should fail
    const publicAccess = await db.getNovelById(archivedId, true);
    expect(publicAccess).toBeUndefined();

    // Admin access should succeed
    const adminAccess = await db.getNovelById(archivedId, false);
    expect(adminAccess).toBeDefined();
    expect(adminAccess?.publicationStatus).toBe("archived");

    // Clean up
    await db.deleteNovel(archivedId);
  });

  it("should preserve story status when changing publication status", async () => {
    const novelId = await db.createNovel({
      title: "Test Novel - Preserve Story Status",
      storyStatus: "finished",
    });

    // Change publication status
    await db.updateNovel(novelId, { publicationStatus: "archived" });

    const novel = await db.getNovelById(novelId, false);
    expect(novel?.storyStatus).toBe("finished"); // Should be preserved
    expect(novel?.publicationStatus).toBe("archived");

    // Clean up
    await db.deleteNovel(novelId);
  });

  it("should preserve publication status when changing story status", async () => {
    const novelId = await db.createNovel({
      title: "Test Novel - Preserve Publication Status",
      publicationStatus: "archived",
    });

    // Change story status
    await db.updateNovel(novelId, { storyStatus: "finished" });

    const novel = await db.getNovelById(novelId, false);
    expect(novel?.publicationStatus).toBe("archived"); // Should be preserved
    expect(novel?.storyStatus).toBe("finished");

    // Clean up
    await db.deleteNovel(novelId);
  });
});
