/**
 * Safe Money Normalization Helpers
 *
 * Handles conversion of various numeric types (number, string, Decimal, etc.)
 * to safe JavaScript numbers for financial calculations.
 *
 * This prevents crashes when database returns Decimal objects or strings
 * instead of native JavaScript numbers.
 */

/**
 * Normalize a value to a safe JavaScript number
 *
 * Handles:
 * - number: 100 → 100
 * - string: "100.00" → 100
 * - Decimal: Decimal { d: [100] } → 100
 * - null/undefined: throws error
 * - invalid: throws error
 *
 * @param value - The value to normalize
 * @param fieldName - Field name for error messages
 * @returns Safe JavaScript number rounded to 2 decimal places
 * @throws Error if value is null, undefined, empty, or not a valid number
 */
export function normalizeMoneyAmount(value: unknown, fieldName: string): number {
  // Check for null/undefined/empty
  if (value === null || value === undefined || value === "") {
    throw new Error(`${fieldName} is required`);
  }

  let num: number;

  if (typeof value === "number") {
    // Already a number
    num = value;
  } else if (typeof value === "string") {
    // Parse string
    num = Number(value);
  } else if (typeof value === "object" && value !== null) {
    // Handle Decimal objects from database
    // Decimal objects have a toString() method
    if ("toString" in value && typeof (value as any).toString === "function") {
      num = Number((value as any).toString());
    } else {
      // Try to convert object to number
      num = Number(value);
    }
  } else {
    // Fallback: try to convert anything to number
    num = Number(value);
  }

  // Validate the result
  if (!Number.isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number, got: ${String(value)}`);
  }

  // Reject negative amounts
  if (num < 0) {
    throw new Error(`${fieldName} must be non-negative, got: ${num}`);
  }

  // Round to 2 decimal places to avoid floating point errors
  // e.g., 100.005 → 100.01 (banker's rounding)
  return Math.round(num * 100) / 100;
}

/**
 * Format a normalized money amount as a string with 2 decimal places
 *
 * @param value - The value to format
 * @param fieldName - Field name for error messages
 * @returns Formatted string like "100.00"
 */
export function formatMoney(value: unknown, fieldName: string): string {
  const normalized = normalizeMoneyAmount(value, fieldName);
  return normalized.toFixed(2);
}

/**
 * Safely compare two money amounts with floating-point tolerance
 *
 * @param amount1 - First amount (can be number, string, or Decimal)
 * @param amount2 - Second amount (can be number, string, or Decimal)
 * @param tolerance - Tolerance for comparison (default 0.01 for cent-level)
 * @returns true if amounts are equal within tolerance
 */
export function moneyEquals(
  amount1: unknown,
  amount2: unknown,
  tolerance: number = 0.01
): boolean {
  try {
    const normalized1 = normalizeMoneyAmount(amount1, "amount1");
    const normalized2 = normalizeMoneyAmount(amount2, "amount2");
    return Math.abs(normalized1 - normalized2) < tolerance;
  } catch {
    return false;
  }
}

/**
 * Safely subtract two money amounts
 *
 * @param minuend - Amount to subtract from
 * @param subtrahend - Amount to subtract
 * @returns Difference rounded to 2 decimal places
 */
export function moneyDifference(minuend: unknown, subtrahend: unknown): number {
  const norm1 = normalizeMoneyAmount(minuend, "minuend");
  const norm2 = normalizeMoneyAmount(subtrahend, "subtrahend");
  return Math.round((norm1 - norm2) * 100) / 100;
}

/**
 * Safely add two money amounts
 *
 * @param amount1 - First amount
 * @param amount2 - Second amount
 * @returns Sum rounded to 2 decimal places
 */
export function moneyAdd(amount1: unknown, amount2: unknown): number {
  const norm1 = normalizeMoneyAmount(amount1, "amount1");
  const norm2 = normalizeMoneyAmount(amount2, "amount2");
  return Math.round((norm1 + norm2) * 100) / 100;
}
