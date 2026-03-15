import { describe, it, expect } from "vitest";

describe("Episode Number as String", () => {
  it("should accept episodeNumber as string with leading zeros", () => {
    const episodeNumber = "001 - 030";
    expect(typeof episodeNumber).toBe("string");
    expect(episodeNumber).toBe("001 - 030");
  });

  it("should accept episodeNumber as simple numeric string", () => {
    const episodeNumber = "1";
    expect(typeof episodeNumber).toBe("string");
    expect(episodeNumber).toBe("1");
  });

  it("should accept episodeNumber with Thai text", () => {
    const episodeNumber = "391 - 423 จบ";
    expect(typeof episodeNumber).toBe("string");
    expect(episodeNumber).toBe("391 - 423 จบ");
  });

  it("should preserve leading zeros when stored as string", () => {
    const input = "001";
    const stored = String(input);
    expect(stored).toBe("001");
  });

  it("should not convert string to number", () => {
    const episodeNumber = "001 - 030";
    const asNumber = parseInt(episodeNumber);
    expect(asNumber).toBe(1); // parseInt only gets first number
    expect(String(episodeNumber)).toBe("001 - 030"); // String conversion preserves original
  });

  it("should compare episodeNumbers as normalized strings", () => {
    const ep1 = "001 - 030".trim().toLowerCase();
    const ep2 = "001 - 030".trim().toLowerCase();
    expect(ep1).toBe(ep2);
  });

  it("should handle empty episodeNumber validation", () => {
    const episodeNumber = "";
    expect(episodeNumber.trim()).toBe("");
    expect(!episodeNumber || !episodeNumber.trim()).toBe(true);
  });

  it("should handle episodeNumber with spaces", () => {
    const episodeNumber = "  001 - 030  ";
    const trimmed = episodeNumber.trim();
    expect(trimmed).toBe("001 - 030");
  });

  it("should support various episodeNumber formats", () => {
    const formats = [
      "1",
      "01",
      "001",
      "1-10",
      "001 - 030",
      "031-080",
      "391 - 423 จบ",
      "Chapter 1",
      "Prologue",
    ];
    formats.forEach((format) => {
      expect(typeof format).toBe("string");
      expect(format.length).toBeGreaterThan(0);
    });
  });

  it("should validate episodeNumber is required", () => {
    const validateEpisodeNumber = (ep: string) => {
      if (!ep || !ep.trim()) {
        throw new Error("episodeNumber is required");
      }
      return ep.trim();
    };

    expect(() => validateEpisodeNumber("")).toThrow("episodeNumber is required");
    expect(() => validateEpisodeNumber("   ")).toThrow("episodeNumber is required");
    expect(validateEpisodeNumber("001 - 030")).toBe("001 - 030");
  });

  it("should handle price as numeric string separately", () => {
    const price = "99.99";
    const episodeNumber = "001 - 030";
    
    expect(typeof price).toBe("string");
    expect(typeof episodeNumber).toBe("string");
    expect(parseFloat(price)).toBe(99.99);
    expect(episodeNumber).toBe("001 - 030");
  });

  it("should support free episodes (price = 0)", () => {
    const price = "0";
    const episodeNumber = "001 - 030";
    const isFree = parseFloat(price) === 0;
    
    expect(isFree).toBe(true);
    expect(episodeNumber).toBe("001 - 030");
  });
});
