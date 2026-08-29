export type FixedDecimalSpec = {
  precision: number;
  scale: number;
};

function pow10(exp: number): number {
  return 10 ** exp;
}

function maxMinorUnits(spec: FixedDecimalSpec): number {
  const max = pow10(spec.precision) - 1;
  if (!Number.isSafeInteger(max)) {
    throw new Error(`DECIMAL(${spec.precision},${spec.scale}) exceeds safe integer arithmetic capacity`);
  }
  return max;
}

/**
 * Convert a fixed-point decimal to integer minor units without performing
 * binary floating-point DECIMAL arithmetic. DECIMAL(12,2)'s largest minor
 * unit value is 999,999,999,999 - comfortably below MAX_SAFE_INTEGER - so
 * parsing the whole/fraction digit groups as integers is exact on this repo's
 * pre-ES2020 TypeScript target (where BigInt syntax is unavailable).
 */
export function decimalToMinorUnits(
  value: unknown,
  fieldName: string,
  spec: FixedDecimalSpec,
  options: { allowNegative?: boolean } = {}
): number {
  if (!Number.isInteger(spec.precision) || !Number.isInteger(spec.scale) || spec.precision <= 0 || spec.scale < 0 || spec.scale > spec.precision) {
    throw new Error(`Invalid fixed-decimal spec for ${fieldName}`);
  }

  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${fieldName} is required`);

  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${fieldName} must be a plain decimal value, got: ${raw}`);

  const negative = match[1] === "-";
  if (negative && !options.allowNegative) {
    throw new Error(`${fieldName} must be non-negative, got: ${raw}`);
  }

  const fraction = match[3] ?? "";
  if (fraction.length > spec.scale) {
    throw new Error(`${fieldName} exceeds scale ${spec.scale}: ${raw}`);
  }

  const factor = pow10(spec.scale);
  const whole = Number(match[2]);
  const paddedFraction = fraction.padEnd(spec.scale, "0");
  const fractionalMinor = paddedFraction ? Number(paddedFraction) : 0;
  const absoluteMinor = whole * factor + fractionalMinor;

  if (!Number.isSafeInteger(absoluteMinor)) {
    throw new Error(`${fieldName} exceeds safe integer arithmetic capacity: ${raw}`);
  }
  if (absoluteMinor > maxMinorUnits(spec)) {
    throw new Error(`${fieldName} exceeds DECIMAL(${spec.precision},${spec.scale}) capacity: ${raw}`);
  }

  return negative ? -absoluteMinor : absoluteMinor;
}

export function minorUnitsToDecimal(minorUnits: number, scale: number): string {
  if (!Number.isSafeInteger(minorUnits)) throw new Error("minorUnits must be a safe integer");
  if (!Number.isInteger(scale) || scale < 0) throw new Error("scale must be a non-negative integer");

  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  if (scale === 0) return `${negative ? "-" : ""}${absolute}`;

  const factor = pow10(scale);
  const whole = Math.floor(absolute / factor);
  const fraction = String(absolute % factor).padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function addNonNegativeFixedDecimals(
  left: unknown,
  right: unknown,
  fieldName: string,
  spec: FixedDecimalSpec
): { leftMinor: number; rightMinor: number; sumMinor: number; sum: string } {
  const leftMinor = decimalToMinorUnits(left, `${fieldName}.left`, spec);
  const rightMinor = decimalToMinorUnits(right, `${fieldName}.right`, spec);
  const sumMinor = leftMinor + rightMinor;
  if (!Number.isSafeInteger(sumMinor) || sumMinor > maxMinorUnits(spec)) {
    throw new Error(`${fieldName} exceeds DECIMAL(${spec.precision},${spec.scale}) capacity after merge`);
  }
  return {
    leftMinor,
    rightMinor,
    sumMinor,
    sum: minorUnitsToDecimal(sumMinor, spec.scale),
  };
}
