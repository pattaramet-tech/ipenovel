/**
 * Resolves a driver duplicate-key error (ER_DUP_ENTRY / errno 1062) into the
 * EXACT colliding axis/owner(s).
 *
 * ── The bug this closes (IPE-004-C03) ─────────────────────────────────────
 * A duplicate-key error from `paymentSlipClaims`' UNIQUE indexes does not
 * say which column collided - MySQL just rejects the whole INSERT/UPDATE.
 * The prior fallback therefore had two failure modes: (a) record only the
 * CURRENT row as a collision "member" (never naming the real historical
 * owner, leaving a one-member "group" that is not authoritative from every
 * angle), or (b) on a generic multi-identifier insert, mark EVERY present
 * identifier (reference, file, AND qr) as colliding even though only ONE of
 * them actually clashed - permanently poisoning two unrelated, perfectly
 * claimable hashes.
 *
 * The fix: after ANY duplicate-key failure, RE-READ `paymentSlipClaims` by
 * EACH present identifier hash. Only an axis where another source (not this
 * row) already owns that exact hash is a genuine collision - record a proper
 * two-member finding (the foreign owner + this row) for exactly that axis.
 * An axis where nobody else owns the hash was not the cause of the driver
 * rejection and must be left untouched.
 *
 * Pure logic, no direct DB access: `lookupOwners(field, hash)` is the only
 * I/O, injected so this can be tested without a real database - mirrors
 * `backfillFileHashRecovery.mjs`'s injected `computeSlipFileHash`.
 */

/**
 * @param {{
 *   ids: Record<string, string | undefined>,
 *   sourceType: "order_payment" | "wallet_topup",
 *   rowId: number,
 *   stage: string,
 *   strongFields: Array<[string, string]>,
 *   lookupOwners: (field: string, hash: string) => Promise<Array<{ sourceType: string, sourceId: number }>>,
 * }} input
 * @returns {Promise<{
 *   confirmed: number,
 *   selfOwnsEvery: boolean,
 *   collisions: Array<{
 *     kind: string,
 *     identifier: string,
 *     hash: string,
 *     first: string,
 *     second: string,
 *     firstSource: { sourceType: string, sourceId: number },
 *     secondSource: { sourceType: string, sourceId: number },
 *     detail: string,
 *   }>,
 * }>}
 */
export async function resolveDuplicateKeyCollisions({
  ids,
  sourceType,
  rowId,
  stage,
  strongFields,
  lookupOwners,
}) {
  let confirmed = 0;
  let selfOwnsEvery = true;
  const collisions = [];

  for (const [kind, field] of strongFields) {
    const hash = ids[field];
    if (!hash) continue;

    const owners = (await lookupOwners(field, hash)) ?? [];
    const mine = owners.some((o) => o.sourceType === sourceType && o.sourceId === rowId);
    if (!mine) selfOwnsEvery = false;

    const foreign = owners.filter((o) => !(o.sourceType === sourceType && o.sourceId === rowId));
    if (foreign.length === 0) continue;

    for (const owner of foreign) {
      collisions.push({
        kind,
        identifier: `${String(hash).slice(0, 12)}...`,
        hash,
        first: `${owner.sourceType}#${owner.sourceId}`,
        second: `${sourceType}#${rowId}`,
        firstSource: { sourceType: owner.sourceType, sourceId: owner.sourceId },
        secondSource: { sourceType, sourceId: rowId },
        detail: `duplicate-key on ${stage}: another source already owns this exact ${kind} identifier`,
      });
    }
    confirmed += 1;
  }

  return { confirmed, selfOwnsEvery, collisions };
}
