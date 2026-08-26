/**
 * In-run strong-identifier collision tracking for the backfill dry-run audit.
 *
 * ── The bug this replaces ─────────────────────────────────────────────────
 * The tracker previously keyed rows on `referenceHash ?? fileHash`. Two
 * approved rows with DIFFERENT references but the SAME fileHash therefore got
 * different keys, so dry-run reported both as claimable and the file
 * collision only surfaced when the live UNIQUE index rejected the second
 * insert - exactly defeating the dry-run-first audit the tool documents.
 *
 * Each strong identifier is now tracked in its own namespace, and every
 * identifier present on a row is checked. One row may legitimately produce
 * more than one collision finding (same reference AND same file as an earlier
 * row is two distinct facts an operator should see).
 *
 * Extracted from the script so the matrix can be unit tested without a
 * database.
 */

export const STRONG_KINDS = ["reference", "file", "qr"];

export const KIND_FIELD = {
  reference: "referenceHash",
  file: "fileHash",
  qr: "qrPayloadHash",
};

export function createCollisionTracker() {
  const seen = {
    reference: new Map(),
    file: new Map(),
    qr: new Map(),
  };
  const collisions = [];

  /**
   * Checks every identifier present on `ids` against what has already been
   * seen. Returns the kinds that collided (possibly more than one).
   *
   * Deliberately does NOT record the row when it collides: the colliding row
   * is not claimable, so letting it occupy the index would mask a later,
   * genuinely different collision against the original owner.
   */
  function check(ids, current) {
    const collidingKinds = [];
    for (const kind of STRONG_KINDS) {
      const hash = ids?.[KIND_FIELD[kind]];
      if (!hash) continue;
      const prior = seen[kind].get(hash);
      if (prior) {
        collisions.push({
          kind,
          // Only a prefix - the full hash is a fingerprint of a customer's
          // payment document and is not needed to act on the finding.
          identifier: `${String(hash).slice(0, 12)}...`,
          first: `${prior.sourceType}#${prior.sourceId}`,
          second: `${current.sourceType}#${current.sourceId}`,
        });
        collidingKinds.push(kind);
      }
    }
    return collidingKinds;
  }

  /** Indexes every present identifier under its own namespace. */
  function remember(ids, current) {
    for (const kind of STRONG_KINDS) {
      const hash = ids?.[KIND_FIELD[kind]];
      if (hash && !seen[kind].has(hash)) seen[kind].set(hash, current);
    }
  }

  return {
    check,
    remember,
    get collisions() {
      return collisions;
    },
    /** Test/diagnostic helper: how many identifiers are indexed per kind. */
    size(kind) {
      return seen[kind].size;
    },
  };
}
