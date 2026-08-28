/**
 * IPE-004-C04 P2: "Unknown cleanup after collision" - a stale
 * paymentSlipLegacyUnknown row for a source whose file-axis identity turns
 * out to collide with another historical row (found via the registry, the
 * in-run tracker, or a duplicate-insert re-read) must only be cleared AFTER
 * the collision finding has been durably written by finalizeCollisionRegistry
 * - not eagerly at the moment the finding was first discovered in memory.
 * Clearing eagerly would assert a protection that had not actually been
 * persisted yet; a crash or a per-member write failure between the eager
 * clear and the batched write would leave the row un-classified in either
 * table.
 *
 * Pure selection logic, no I/O: given the list of sources deferred while
 * pending (each `{ sourceType, sourceId }`, appended once per source the
 * moment its file-axis collision was found in memory - duplicates across the
 * three accumulation sites are expected and harmless) and the set of member
 * keys that finalizeCollisionRegistry() confirmed were ACTUALLY durably
 * written (`${sourceType}#${sourceId}#file`), returns exactly the pending
 * entries whose own file-axis collision member landed durably - deduplicated,
 * since the caller performs one DB round-trip per entry it applies.
 */

/**
 * @param {Array<{ sourceType: string, sourceId: number | string }>} pending
 * @param {Set<string>} succeededMemberKeys
 * @returns {Array<{ sourceType: string, sourceId: number | string }>}
 */
export function selectPendingClearsToApply(pending, succeededMemberKeys) {
  const seen = new Set();
  const toApply = [];
  for (const { sourceType, sourceId } of pending) {
    const key = `${sourceType}#${sourceId}`;
    if (seen.has(key)) continue;
    if (!succeededMemberKeys.has(`${key}#file`)) continue;
    seen.add(key);
    toApply.push({ sourceType, sourceId });
  }
  return toApply;
}
