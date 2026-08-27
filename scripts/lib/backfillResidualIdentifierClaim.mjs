/**
 * IPE-004-C04 P1: "Partial duplicate insert" - after a multi-identifier
 * INSERT into `paymentSlipClaims` hits a duplicate-key error and
 * `resolveDuplicateKeyCollisions` has identified exactly which axis(es)
 * genuinely collide, every OTHER present identifier this historical row
 * carries - owned by nobody, never touched by the failed INSERT - must
 * still end the run in a safe state: claimed for this source, or itself
 * proven a collision. `confirmed > 0` alone says nothing about the axes
 * that did NOT collide, so treating it as sufficient left them silently
 * unclaimed - a replay hole the completion gate never caught.
 *
 * `paymentSlipClaims` has no UNIQUE constraint on (sourceType, sourceId),
 * only on each identifier hash, so inserting a SECOND claim row for the
 * same historical source - containing only the residual (non-colliding)
 * axes - is a normal, supported shape here; the colliding axis lives in
 * the separate collision registry, not in this row.
 *
 * Bounded at 2 attempts: if the residual insert itself hits a duplicate key
 * (a genuine TOCTOU race a moment after the first check), the newly
 * confirmed collision axes are subtracted and the remainder is retried
 * EXACTLY once more. Anything still uncovered after that is reported, never
 * silently dropped.
 *
 * Pure logic, no direct DB access: `insertClaim` and `resolveCollisions`
 * are the only I/O, injected so this can be tested without a real database.
 */

/**
 * @param {{
 *   ids: Record<string, string | undefined>,
 *   confirmedKinds: Set<string>,
 *   strongFields: Array<[string, string]>,
 *   insertClaim: (fields: Record<string, string>) => Promise<void>,
 *   resolveCollisions: (residualIds: Record<string, string | undefined>) => Promise<{
 *     confirmed: number,
 *     selfOwnsEvery: boolean,
 *     collisions: Array<{ kind: string }>,
 *   }>,
 * }} input
 * @returns {Promise<{
 *   claimedKinds: string[],
 *   uncoveredKinds: string[],
 *   failed: boolean,
 * }>}
 */
export async function claimResidualIdentifiers({
  ids,
  confirmedKinds,
  strongFields,
  insertClaim,
  resolveCollisions,
}) {
  let residual = strongFields.filter(([kind, field]) => ids[field] && !confirmedKinds.has(kind));
  if (residual.length === 0) {
    return { claimedKinds: [], uncoveredKinds: [], failed: false };
  }

  for (let attempt = 0; attempt < 2 && residual.length > 0; attempt++) {
    const fields = {};
    for (const [, field] of residual) fields[field] = ids[field];

    try {
      await insertClaim(fields);
      return { claimedKinds: residual.map(([kind]) => kind), uncoveredKinds: [], failed: false };
    } catch (error) {
      const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
      if (!isDuplicate) {
        return { claimedKinds: [], uncoveredKinds: residual.map(([kind]) => kind), failed: true };
      }

      const residualIds = {};
      for (const [, field] of residual) residualIds[field] = ids[field];
      const retry = await resolveCollisions(residualIds);
      const newlyConfirmed = new Set(retry.collisions.map((c) => c.kind));
      residual = residual.filter(([kind]) => !newlyConfirmed.has(kind));
      // Loop continues into attempt 1 with whatever remains, if anything.
    }
  }

  if (residual.length === 0) {
    // Every remaining axis turned out to be a confirmed collision on the
    // retry read - nothing left to claim, and nothing uncovered either.
    return { claimedKinds: [], uncoveredKinds: [], failed: false };
  }

  // Bounded retry exhausted with axes still neither claimed nor confirmed a
  // collision - a repeated race the retry could not resolve. Never invent
  // coverage; report it so the caller blocks completion.
  return { claimedKinds: [], uncoveredKinds: residual.map(([kind]) => kind), failed: true };
}
