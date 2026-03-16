import { describe, it, expect } from "vitest";

// CSV Parser logic for testing (mirrors client-side implementation)
function parseCSVText(text: string): { rows: Array<Record<string, string>>; error?: string } {
  try {
    const lines = text.trim().split("\n").filter(line => line.trim());
    
    if (lines.length < 2) {
      return {
        rows: [],
        error: "CSV must have at least a header row and one data row",
      };
    }

    const headers = parseCSVLine(lines[0]);
    if (headers.length === 0) {
      return {
        rows: [],
        error: "CSV header is empty or invalid",
      };
    }

    const rows: Array<Record<string, string>> = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const row: Record<string, string> = {};
      
      headers.forEach((header, idx) => {
        row[header] = values[idx] || "";
      });
      
      rows.push(row);
    }

    return { rows };
  } catch (err) {
    return {
      rows: [],
      error: `Failed to parse CSV: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function validateCSVRows(
  rows: Array<Record<string, string>>,
  requiredFields: string[]
): { valid: boolean; error?: string } {
  if (rows.length === 0) {
    return { valid: false, error: "No data rows found" };
  }

  const missingFields = requiredFields.filter(
    field => !Object.keys(rows[0]).includes(field)
  );

  if (missingFields.length > 0) {
    return {
      valid: false,
      error: `Missing required columns: ${missingFields.join(", ")}`,
    };
  }

  return { valid: true };
}

describe("CSV Parser", () => {
  describe("parseCSVText", () => {
    it("should parse valid CSV with headers and data", () => {
      const csv = "title,price\nNovel 1,100\nNovel 2,200";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ title: "Novel 1", price: "100" });
      expect(result.rows[1]).toEqual({ title: "Novel 2", price: "200" });
      expect(result.error).toBeUndefined();
    });

    it("should handle Thai characters", () => {
      const csv = "title\nเกิดใหม่ที่โตเกียว\nสามก๊ก";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].title).toBe("เกิดใหม่ที่โตเกียว");
      expect(result.rows[1].title).toBe("สามก๊ก");
    });

    it("should handle quoted values with commas", () => {
      const csv = 'title,description\n"Novel 1","A great, novel"\n"Novel 2","Another, great, novel"';
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].description).toBe("A great, novel");
      expect(result.rows[1].description).toBe("Another, great, novel");
    });

    it("should handle empty CSV", () => {
      const csv = "";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(0);
      expect(result.error).toBeDefined();
    });

    it("should handle CSV with only header", () => {
      const csv = "title,price";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(0);
      expect(result.error).toBeDefined();
    });

    it("should handle missing fields", () => {
      const csv = "title,price,episodeNumber\nNovel 1,100\nNovel 2,200,1";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].episodeNumber).toBe("");
      expect(result.rows[1].episodeNumber).toBe("1");
    });

    it("should trim whitespace", () => {
      const csv = "  title  ,  price  \n  Novel 1  ,  100  ";
      const result = parseCSVText(csv);
      
      expect(result.rows[0].title).toBe("Novel 1");
      expect(result.rows[0].price).toBe("100");
    });

    it("should handle episodeNumber as string", () => {
      const csv = "title,episodeNumber\nEpisode 1,001 - 050\nEpisode 2,051 - 100";
      const result = parseCSVText(csv);
      
      expect(result.rows[0].episodeNumber).toBe("001 - 050");
      expect(result.rows[1].episodeNumber).toBe("051 - 100");
      expect(typeof result.rows[0].episodeNumber).toBe("string");
    });

    it("should handle novel CSV with novelTitle", () => {
      const csv = "novelTitle,title,price,episodeNumber,fileUrl\nMy Novel,Episode 1,0,1,https://example.com/ep1.pdf";
      const result = parseCSVText(csv);
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].novelTitle).toBe("My Novel");
      expect(result.rows[0].episodeNumber).toBe("1");
    });
  });

  describe("validateCSVRows", () => {
    it("should validate required fields present", () => {
      const rows = [
        { title: "Novel 1", price: "100" },
        { title: "Novel 2", price: "200" },
      ];
      const result = validateCSVRows(rows, ["title", "price"]);
      
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should error on missing required fields", () => {
      const rows = [
        { title: "Novel 1" },
        { title: "Novel 2" },
      ];
      const result = validateCSVRows(rows, ["title", "price"]);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain("price");
    });

    it("should error on empty rows", () => {
      const result = validateCSVRows([], ["title"]);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain("No data rows");
    });

    it("should validate multiple required fields", () => {
      const rows = [
        { novelTitle: "Novel 1", title: "Ep 1", price: "0", episodeNumber: "1", fileUrl: "http://..." },
      ];
      const result = validateCSVRows(rows, ["novelTitle", "title", "price", "episodeNumber", "fileUrl"]);
      
      expect(result.valid).toBe(true);
    });

    it("should validate novel CSV fields", () => {
      const rows = [
        { title: "Novel 1" },
        { title: "Novel 2" },
      ];
      const result = validateCSVRows(rows, ["title"]);
      
      expect(result.valid).toBe(true);
    });

    it("should validate episode CSV fields", () => {
      const rows = [
        { title: "Ep 1", price: "0", episodeNumber: "1", fileUrl: "http://..." },
      ];
      const result = validateCSVRows(rows, ["title", "price", "episodeNumber", "fileUrl"]);
      
      expect(result.valid).toBe(true);
    });
  });
});
