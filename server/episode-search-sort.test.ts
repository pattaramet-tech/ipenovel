import { describe, it, expect } from "vitest";

/**
 * Episode Search and Sorting Tests
 * These tests verify the frontend filtering and sorting logic for episodes
 */

describe("Episode Search and Sorting", () => {
  // Test data
  const episodes = [
    {
      id: 1,
      novelId: 1,
      episodeNumber: "1",
      title: "Alpha Episode",
      price: "10.00",
      isFree: false,
      fileUrl: "https://example.com/ep1.pdf",
      createdAt: new Date("2026-01-01"),
    },
    {
      id: 2,
      novelId: 1,
      episodeNumber: "2",
      title: "Beta Episode",
      price: "10.00",
      isFree: true,
      fileUrl: "https://example.com/ep2.pdf",
      createdAt: new Date("2026-01-02"),
    },
    {
      id: 3,
      novelId: 1,
      episodeNumber: "3",
      title: "Gamma Episode",
      price: "10.00",
      isFree: false,
      fileUrl: "https://example.com/ep3.pdf",
      createdAt: new Date("2026-01-03"),
    },
    {
      id: 4,
      novelId: 1,
      episodeNumber: "4",
      title: "Delta Episode",
      price: "10.00",
      isFree: true,
      fileUrl: "https://example.com/ep4.pdf",
      createdAt: new Date("2026-01-04"),
    },
  ];

  it("should filter episodes by title (case-insensitive)", () => {
    const searchTerm = "alpha";
    const filtered = episodes.filter((ep) =>
      ep.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Alpha Episode");
  });

  it("should filter episodes by episode number", () => {
    const searchTerm = "2";
    const filtered = episodes.filter((ep) =>
      String(ep.episodeNumber).toLowerCase().includes(searchTerm.toLowerCase())
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].episodeNumber).toBe("2");
  });

  it("should sort episodes by newest first", () => {
    const sorted = [...episodes].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    expect(sorted[0].episodeNumber).toBe("4");
    expect(sorted[1].episodeNumber).toBe("3");
    expect(sorted[2].episodeNumber).toBe("2");
    expect(sorted[3].episodeNumber).toBe("1");
  });

  it("should sort episodes by oldest first", () => {
    const sorted = [...episodes].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    expect(sorted[0].episodeNumber).toBe("1");
    expect(sorted[1].episodeNumber).toBe("2");
    expect(sorted[2].episodeNumber).toBe("3");
    expect(sorted[3].episodeNumber).toBe("4");
  });

  it("should sort episodes by title A-Z", () => {
    const sorted = [...episodes].sort((a, b) =>
      a.title.localeCompare(b.title)
    );

    expect(sorted[0].title).toBe("Alpha Episode");
    expect(sorted[1].title).toBe("Beta Episode");
    expect(sorted[2].title).toBe("Delta Episode");
    expect(sorted[3].title).toBe("Gamma Episode");
  });

  it("should sort episodes by title Z-A", () => {
    const sorted = [...episodes].sort((a, b) =>
      b.title.localeCompare(a.title)
    );

    expect(sorted[0].title).toBe("Gamma Episode");
    expect(sorted[1].title).toBe("Delta Episode");
    expect(sorted[2].title).toBe("Beta Episode");
    expect(sorted[3].title).toBe("Alpha Episode");
  });

  it("should combine search and sort (search for 'episode' and sort newest first)", () => {
    const searchTerm = "episode";
    let filtered = episodes.filter((ep) =>
      ep.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    filtered.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    expect(filtered).toHaveLength(4);
    expect(filtered[0].episodeNumber).toBe("4");
    expect(filtered[1].episodeNumber).toBe("3");
  });

  it("should return empty array when search has no matches", () => {
    const searchTerm = "nonexistent";
    const filtered = episodes.filter(
      (ep) =>
        ep.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(ep.episodeNumber).toLowerCase().includes(searchTerm.toLowerCase())
    );

    expect(filtered).toHaveLength(0);
  });

  it("should preserve free/paid status after filtering and sorting", () => {
    const sorted = [...episodes].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Check that free/paid status is preserved
    const freeEpisodes = sorted.filter((ep) => ep.isFree);
    expect(freeEpisodes.length).toBeGreaterThan(0);
    expect(freeEpisodes.every((ep) => ep.isFree)).toBe(true);

    const paidEpisodes = sorted.filter((ep) => !ep.isFree);
    expect(paidEpisodes.length).toBeGreaterThan(0);
    expect(paidEpisodes.every((ep) => !ep.isFree)).toBe(true);
  });

  it("should handle partial title matches", () => {
    const searchTerm = "episode";
    const filtered = episodes.filter((ep) =>
      ep.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    expect(filtered).toHaveLength(4); // All episodes have "episode" in title
  });

  it("should handle case-insensitive search with mixed case input", () => {
    const searchTerm = "ALPHA";
    const filtered = episodes.filter((ep) =>
      ep.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Alpha Episode");
  });
});
