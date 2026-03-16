/**
 * CSV Parser Helper
 * Parses CSV file content into structured rows
 */

export interface ParsedCSVResult {
  rows: Array<Record<string, string>>;
  error?: string;
}

/**
 * Parse CSV content from text
 * Handles basic CSV parsing with header row
 */
export function parseCSVText(text: string): ParsedCSVResult {
  try {
    const lines = text.trim().split("\n").filter(line => line.trim());
    
    if (lines.length < 2) {
      return {
        rows: [],
        error: "CSV must have at least a header row and one data row",
      };
    }

    // Parse header
    const headers = parseCSVLine(lines[0]);
    if (headers.length === 0) {
      return {
        rows: [],
        error: "CSV header is empty or invalid",
      };
    }

    // Parse data rows
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

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      // Field separator
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  // Add last field
  result.push(current.trim());

  return result;
}

/**
 * Validate CSV rows have required fields
 */
export function validateCSVRows(
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

/**
 * Read CSV file and return text content
 */
export async function readCSVFile(file: File): Promise<{ content: string; error?: string }> {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        resolve({ content });
      } catch (err) {
        resolve({
          content: "",
          error: `Failed to read file: ${err instanceof Error ? err.message : "Unknown error"}`,
        });
      }
    };

    reader.onerror = () => {
      resolve({
        content: "",
        error: "Failed to read file",
      });
    };

    reader.readAsText(file);
  });
}
