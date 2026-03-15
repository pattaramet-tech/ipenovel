import { describe, it, expect, beforeAll } from "vitest";
import * as db from "./db";

describe("Novel Title Matching for Bulk Episode Upload", () => {
  const timestamp = Date.now();
  const testNovelTitle = `Test Novel for Title Matching ${timestamp}`;

  beforeAll(async () => {
    // Create a test novel
    await db.createNovel({
      title: testNovelTitle,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
  });

  it("should find novel by exact title match", async () => {
    const novel = await db.findNovelByTitle(testNovelTitle);
    expect(novel).not.toBeNull();
    expect(novel?.title).toBe(testNovelTitle);
  });

  it("should find novel by case-insensitive title match", async () => {
    const novel = await db.findNovelByTitle(testNovelTitle.toUpperCase());
    expect(novel).not.toBeNull();
    expect(novel?.title).toBe(testNovelTitle);
  });

  it("should find novel by title with extra spaces", async () => {
    const novel = await db.findNovelByTitle(`  ${testNovelTitle}  `);
    expect(novel).not.toBeNull();
    expect(novel?.title).toBe(testNovelTitle);
  });

  it("should return null for non-existent novel", async () => {
    const novel = await db.findNovelByTitle("Non Existent Novel XYZ 123");
    expect(novel).toBeNull();
  });


});

describe("Bulk Episode Upload with Novel Title Matching", () => {
  const timestamp = Date.now();
  const testNovelTitle = `Novel for Episode Upload ${timestamp}`;

  beforeAll(async () => {
    // Create a test novel
    await db.createNovel({
      title: testNovelTitle,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
  });

  it("should validate required novelTitle field", async () => {
    const rows = [
      { novelTitle: "", title: "Episode 1", episodeNumber: "1", price: "0", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Novel title is required");
  });

  it("should validate required title field", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "", episodeNumber: "1", price: "0", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Episode title is required");
  });

  it("should validate required episodeNumber field", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "Episode 1", episodeNumber: "", price: "0", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Episode number is required");
  });

  it("should validate required price field", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "Episode 1", episodeNumber: "1", price: "", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Price is required");
  });

  it("should validate required fileUrl field", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "Episode 1", episodeNumber: "1", price: "0", fileUrl: "" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("File URL is required");
  });

  it("should validate numeric price", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "Episode 1", episodeNumber: "1", price: "invalid", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Invalid price");
  });

  it("should fail for non-existent novel", async () => {
    const rows = [
      { novelTitle: "Non Existent Novel XYZ", title: "Episode 1", episodeNumber: "1", price: "0", fileUrl: "https://example.com/ep1.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("No novel found");
  });

  it("should successfully create episodes with novel title matching", async () => {
    const rows = [
      { novelTitle: testNovelTitle, title: "Free Episode", episodeNumber: "1", price: "0", fileUrl: "https://example.com/free.pdf" },
      { novelTitle: testNovelTitle, title: "Paid Episode", episodeNumber: "2", price: "99", fileUrl: "https://example.com/paid.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.success.length).toBe(2);
    expect(result.errors.length).toBe(0);
    expect(result.success[0].novelTitle).toBe(testNovelTitle);
    expect(result.success[1].novelTitle).toBe(testNovelTitle);
  });

  it("should match novel by title case-insensitively", async () => {
    const rows = [
      { novelTitle: testNovelTitle.toUpperCase(), title: "Case Test Episode", episodeNumber: "3", price: "0", fileUrl: "https://example.com/case.pdf" },
    ];

    const result = await db.bulkCreateEpisodesWithNovelTitle(rows);

    expect(result.success.length).toBe(1);
    expect(result.errors.length).toBe(0);
    expect(result.success[0].novelTitle).toBe(testNovelTitle);
  });
});
