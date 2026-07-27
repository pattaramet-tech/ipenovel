/**
 * Distinguishes a legacy absolute storage URL (Manus proxy, public R2, or
 * any other pre-existing value) from a private R2 object reference, both of
 * which are stored as plain strings in the same `text` columns
 * (payments.slipImageUrl, walletTopups.slipImageUrl, episodes.fileUrl) -
 * no schema change, no migration, no rewriting of existing rows.
 *
 * Zero server-only dependencies (no AWS SDK, no env access) so this is safe
 * to import from both client and server code - see shared/validation.ts and
 * server/services/r2PrivateStorage.ts.
 */

export const PRIVATE_REF_PREFIX = "r2p:";

/** Any pre-existing value in these columns is always a full http(s) URL. */
export function isLegacyStorageUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** A NEW-format reference pointing at an object in the private R2 bucket. */
export function isPrivateObjectRef(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(PRIVATE_REF_PREFIX) && value.length > PRIVATE_REF_PREFIX.length;
}

export function toPrivateObjectRef(key: string): string {
  return `${PRIVATE_REF_PREFIX}${key}`;
}

/** Caller must have already checked isPrivateObjectRef(ref). */
export function extractPrivateObjectKey(ref: string): string {
  return ref.slice(PRIVATE_REF_PREFIX.length);
}

/**
 * Accepts an empty/absent value (these fields are always optional), a
 * legacy absolute http(s) URL, or a new-format private object reference.
 * Rejects everything else (e.g. javascript:, file://, bare paths) so a
 * slipImageUrl/fileUrl input can never smuggle something other than one of
 * these two well-understood forms into storage.
 */
export function isValidStoredFileRef(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return true;
  return isLegacyStorageUrl(value) || isPrivateObjectRef(value);
}
