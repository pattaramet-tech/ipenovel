/**
 * OCR Datetime Hardener
 * 
 * Robust datetime parsing with:
 * - Timezone handling (Asia/Bangkok)
 * - Multi-pass parsing (strict → relaxed)
 * - Thai Buddhist year conversion
 * - Ambiguity rejection
 * - ISO output (UTC internally)
 */

/**
 * Parse datetime with strict and relaxed fallback
 * Returns ISO string (UTC) or null if cannot parse confidently
 */
export function parseOCRDatetime(text: string): string | null {
  if (!text || typeof text !== "string") return null;

  const cleaned = text.trim();

  // Try strict parsing first
  let result = parseStrict(cleaned);
  if (result) return result;

  // Try relaxed parsing as fallback
  result = parseRelaxed(cleaned);
  if (result) return result;

  return null;
}

/**
 * STRICT parsing - only accept unambiguous formats
 */
function parseStrict(text: string): string | null {
  // Format 1: DD/MM/YYYY HH:MM or DD/MM/YYYY HH:MM:SS
  const fmt1 = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  const m1 = text.match(fmt1);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const month = parseInt(m1[2], 10);
    let year = parseInt(m1[3], 10);
    const hour = parseInt(m1[4], 10);
    const min = parseInt(m1[5], 10);
    const sec = m1[6] ? parseInt(m1[6], 10) : 0;

    // Convert Buddhist year to AD
    if (year > 2500) year -= 543;

    // Validate ranges
    if (day < 1 || day > 31 || month < 1 || month > 12 || hour < 0 || hour > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) {
      return null;
    }

    // Create date in Bangkok timezone
    return toISOString(year, month, day, hour, min, sec);
  }

  // Format 2: DD-MM-YY HH:MM (short year)
  const fmt2 = /(\d{1,2})-(\d{1,2})-(\d{2})\s+(\d{1,2}):(\d{2})/;
  const m2 = text.match(fmt2);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10);
    let year = parseInt(m2[3], 10);
    const hour = parseInt(m2[4], 10);
    const min = parseInt(m2[5], 10);

    // Assume 20XX for 2-digit years
    if (year < 100) year += 2000;

    // Convert Buddhist year to AD
    if (year > 2500) year -= 543;

    // Validate ranges
    if (day < 1 || day > 31 || month < 1 || month > 12 || hour < 0 || hour > 23 || min < 0 || min > 59) {
      return null;
    }

    return toISOString(year, month, day, hour, min, 0);
  }

  // Format 3: DD Mon YYYY HH:MM (e.g., 18 Apr 2026 10:00)
  const fmt3 = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})/;
  const m3 = text.match(fmt3);
  if (m3) {
    const day = parseInt(m3[1], 10);
    const monthStr = m3[2];
    let year = parseInt(m3[3], 10);
    const hour = parseInt(m3[4], 10);
    const min = parseInt(m3[5], 10);

    const month = monthNameToNumber(monthStr);
    if (month === null) return null;

    // Convert Buddhist year to AD
    if (year > 2500) year -= 543;

    // Validate ranges
    if (day < 1 || day > 31 || hour < 0 || hour > 23 || min < 0 || min > 59) {
      return null;
    }

    return toISOString(year, month, day, hour, min, 0);
  }

  return null;
}

/**
 * RELAXED parsing - accept more formats but with caution
 */
function parseRelaxed(text: string): string | null {
  // Try to extract date and time separately
  const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);

  if (!dateMatch) return null;

  const day = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  let year = parseInt(dateMatch[3], 10);

  // Assume 20XX for 2-digit years
  if (year < 100) year += 2000;

  // Convert Buddhist year to AD
  if (year > 2500) year -= 543;

  // Validate date ranges
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return null;
  }

  // Extract time or default to midnight
  let hour = 0;
  let min = 0;
  let sec = 0;

  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    min = parseInt(timeMatch[2], 10);
    sec = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;

    if (hour < 0 || hour > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) {
      return null;
    }
  }

  return toISOString(year, month, day, hour, min, sec);
}

/**
 * Convert to ISO string (UTC)
 * Input: Bangkok time components
 * Output: ISO string in UTC
 */
function toISOString(year: number, month: number, day: number, hour: number, min: number, sec: number): string {
  // Create date in Bangkok timezone (UTC+7)
  // We need to account for the timezone offset
  const bangkokOffset = 7 * 60 * 60 * 1000; // 7 hours in milliseconds

  // Create UTC date
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, min, sec));

  // Adjust for Bangkok timezone (subtract 7 hours to get UTC equivalent)
  const bangkokDate = new Date(utcDate.getTime() - bangkokOffset);

  return bangkokDate.toISOString();
}

/**
 * Convert month name to number
 */
function monthNameToNumber(name: string): number | null {
  const months: { [key: string]: number } = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  return months[name.toLowerCase()] || null;
}

/**
 * Extract date only (YYYY-MM-DD) from ISO string
 * Used for fingerprinting
 */
export function extractDateOnly(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toISOString().split("T")[0];
  } catch {
    return "";
  }
}

/**
 * Validate datetime is within acceptable window
 * Returns true if datetime is within ±30 days of now
 */
export function isDatetimeWithinWindow(isoString: string, windowDays: number = 30): boolean {
  try {
    const date = new Date(isoString);
    const now = new Date();

    const diffMs = Math.abs(now.getTime() - date.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    return diffDays <= windowDays;
  } catch {
    return false;
  }
}

/**
 * Debug helper - show parsing steps
 */
export function debugDatetimeParsing(text: string): {
  input: string;
  strictResult: string | null;
  relaxedResult: string | null;
  finalResult: string | null;
  dateOnly: string | null;
} {
  const strictResult = parseStrict(text);
  const relaxedResult = parseRelaxed(text);
  const finalResult = parseOCRDatetime(text);

  return {
    input: text,
    strictResult,
    relaxedResult,
    finalResult,
    dateOnly: finalResult ? extractDateOnly(finalResult) : null,
  };
}
