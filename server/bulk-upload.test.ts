import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Bulk Upload - Validation", () => {
  it("should validate novel CSV - missing title", async () => {
    const rows = [
      { title: "" },
      { title: `Valid Title ${Date.now()}` },
    ];

    const result = await db.bulkCreateNovels(rows);

    expect(result.success.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain("Title is required");
  });

  it("should validate episode CSV - missing required fields", async () => {
    // Create a test novel
    const novelResult = await db.createNovel({
      title: `Test Novel Validation ${Date.now()}`,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
    const novelId = (novelResult as any).insertId;

    const rows = [
      {
        title: "", // Missing title
        episodeNumber: "1",
        price: "99",
        fileUrl: "https://example.com/ep1.pdf",
      },
      {
        title: "Episode 2",
        episodeNumber: "", // Missing episode number
        price: "99",
        fileUrl: "https://example.com/ep2.pdf",
      },
      {
        title: "Episode 3",
        episodeNumber: "3",
        price: "", // Missing price
        fileUrl: "https://example.com/ep3.pdf",
      },
      {
        title: "Episode 4",
        episodeNumber: "4",
        price: "99",
        fileUrl: "", // Missing fileUrl
      },
    ];

    const result = await db.bulkCreateEpisodes(novelId, rows);

    expect(result.errors.length).toBe(4);
    expect(result.errors[0].error).toContain("Title is required");
    expect(result.errors[1].error).toContain("Episode number is required");
    expect(result.errors[2].error).toContain("Price is required");
    expect(result.errors[3].error).toContain("File URL is required");
  });

  it("should validate episode CSV - invalid price", async () => {
    // Create a test novel
    const novelResult = await db.createNovel({
      title: `Test Novel Price Validation ${Date.now()}`,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
    const novelId = (novelResult as any).insertId;

    const rows = [
      {
        title: "Episode 1",
        episodeNumber: "1",
        price: "invalid", // Non-numeric price
        fileUrl: "https://example.com/ep1.pdf",
      },
    ];

    const result = await db.bulkCreateEpisodes(novelId, rows);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("Invalid price");
  });
});

describe("Free Episode Behavior", () => {
  it("should mark episodes as free when price is 0", async () => {
    const timestamp = Date.now();
    
    // Create a test novel
    const novelResult = await db.createNovel({
      title: `Test Novel Free Behavior ${timestamp}`,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
    const novelId = (novelResult as any).insertId;

    // Create a free episode directly
    const freeResult = await db.createEpisode({
      novelId,
      episodeNumber: "1",
      title: "Free Episode",
      price: "0",
      isFree: true,
      fileUrl: "https://example.com/free.pdf",
    });

    const freeEpisodeId = (freeResult as any).insertId;
    const freeEpisode = await db.getEpisodeById(freeEpisodeId);

    expect(freeEpisode?.isFree).toBe(true);
    expect(freeEpisode?.price).toBe("0");
  });

  it("should mark episodes as paid when price > 0", async () => {
    const timestamp = Date.now();
    
    // Create a test novel
    const novelResult = await db.createNovel({
      title: `Test Novel Paid Behavior ${timestamp}`,
      author: "Test Author",
      description: "Test Description",
      coverImageUrl: "",
    });
    const novelId = (novelResult as any).insertId;

    // Create a paid episode directly
    const paidResult = await db.createEpisode({
      novelId,
      episodeNumber: "1",
      title: "Paid Episode",
      price: "99",
      isFree: false,
      fileUrl: "https://example.com/paid.pdf",
    });

    const paidEpisodeId = (paidResult as any).insertId;
    const paidEpisode = await db.getEpisodeById(paidEpisodeId);

    expect(paidEpisode?.isFree).toBe(false);
    expect(paidEpisode?.price).toBe("99");
  });
});
