/**
 * The public "last updated" time for a novel comes from its published
 * episodes (or novel creation before any published episodes).
 * Draft episode updates must never change a storefront timestamp.
 * Publication filtering happens in the DB query before this comparison.
 */
export function resolveNovelDisplayUpdatedAt(
  novelCreatedAt: Date,
  latestPublishedEpisodeUpdatedAt: Date | string | null | undefined
): Date {
  if (!latestPublishedEpisodeUpdatedAt) return novelCreatedAt;
  const episodeTime = new Date(latestPublishedEpisodeUpdatedAt);
  return Number.isFinite(episodeTime.getTime()) && episodeTime > novelCreatedAt
    ? episodeTime
    : novelCreatedAt;
}
