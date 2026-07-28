/**
 * Normalizes a display name reported by an OAuth provider. Some providers
 * (notably Apple, and any provider on a returning-user login) send `null`,
 * `undefined`, `""`, or a whitespace-only string instead of a real name.
 * Those all mean "no new name data" - never "clear the name" - so callers
 * that upsert a user must treat a `null` return here as "omit the field",
 * not "write null over whatever name is already stored". See
 * server/_core/oauth.ts and server/_core/sdk.ts's authenticateRequest.
 */
export function normalizeProviderName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}
