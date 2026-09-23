export const DATABASE_IDENTITY_PATTERN: RegExp;
export function normalizeDatabaseIdentityFingerprint(
  value: unknown
): string | undefined;
export function databaseIdentityMaterial(databaseUrl: string): string;
export function databaseIdentityFingerprint(databaseUrl: string): string;
