// IPE-064R4B review round 28 (P2): the export dialog's recovery picker is
// authoritative — its checkbox list renders from the preview response's
// sourceEpisodes. A selected episode that becomes unpublished / contentless
// is absent from that set, and without reconciliation the stale ID stays
// selected invisibly while every subsequent preview resubmits it, dead-ending
// the recovery flow until a page reload. This pure helper intersects the
// selection with the returned picker set; it returns the ORIGINAL array
// reference when nothing needs pruning so React state updates bail out and
// the prune effect can never loop or refetch on its own.
export function pruneEpisodeSelection(
  selected: readonly number[],
  pickerIds: readonly number[]
): number[] {
  const allowed = new Set(pickerIds);
  const pruned = selected.filter(id => allowed.has(id));
  return pruned.length === selected.length ? (selected as number[]) : pruned;
}
