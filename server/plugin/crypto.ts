import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// IPE-PLUGIN-001B crypto helpers for the plugin OAuth foundation.
//
// Deliberately NO symmetric-encryption machinery here: every plugin
// credential (authorization code, access token, refresh token, client
// secret, consent CSRF token, OAuth state) is a random opaque value stored
// ONLY as a sha256 hex digest (or, for state/CSRF, verified by re-hashing).
// A hash cannot be decrypted, so there is no ciphertext to protect, no key
// to rotate, and no workspace-googleDocs-style cipher to maintain - losing
// the database does not leak usable credentials. This is the appropriate
// reuse of the repo's existing hash-at-rest precedents (stateHash /
// tokenHash patterns in server/workspace/googleDocs.domain.ts and
// duplicateConfirmationKey in server/payments/duplicateException.ts), not a
// new crypto design.

/** Cryptographically random, URL-safe opaque credential (RFC 4648 §5, no padding). */
export function generatePluginOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex digest (64 chars) - the at-rest representation of every plugin credential. */
export function hashPluginSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Constant-time comparison of two sha256 hex digests. Inputs are always the
 * same fixed length (64 hex chars) when they come from our own columns, but
 * a forged request can make them anything, so length is checked first -
 * timingSafeEqual throws on mismatched lengths and must never be reached
 * with attacker-chosen shapes.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== 64 || b.length !== 64) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** PKCE S256 code_challenge derivation (RFC 7636 §4.2): BASE64URL(SHA256(verifier)). */
export function computePkceS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/**
 * PKCE verification for one authorization-code exchange: the presented
 * verifier must hash (S256) to exactly the challenge that was bound to the
 * code at authorize time. Compared in constant time over the base64url
 * strings (fixed 43-char shape for a 32-byte digest) - a wrong verifier
 * must be indistinguishable from a wrong code to anything watching timing.
 */
export function verifyPkceS256(input: {
  codeVerifier: string;
  codeChallenge: string;
}): boolean {
  if (!input.codeVerifier || !input.codeChallenge) return false;
  const computed = computePkceS256Challenge(input.codeVerifier);
  if (computed.length !== input.codeChallenge.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(input.codeChallenge));
  } catch {
    return false;
  }
}

/**
 * Opaque-token prefix constants. Prefixes exist so a leaked value in a log
 * or ticket is self-identifying as a plugin credential (and of what kind) -
 * they are NOT parsed back out anywhere; validation is always hash lookup.
 */
export const PLUGIN_ACCESS_TOKEN_PREFIX = "plg_at_";
export const PLUGIN_REFRESH_TOKEN_PREFIX = "plg_rt_";
export const PLUGIN_AUTHORIZATION_CODE_PREFIX = "plg_ac_";
