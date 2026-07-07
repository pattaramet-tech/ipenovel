/**
 * Parse episode number to numeric value for sorting
 * Extracts first number from strings like "12", "12.5", "581 - 619", etc.
 */
export function parseEpisodeNumber(value: unknown): number | null {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Get sort value for an episode
 * Priority: sortOrder > parsed episodeNumber > id
 */
export function getEpisodeSortValue(episode: any): number {
  if (episode?.sortOrder !== null && episode?.sortOrder !== undefined) {
    const sortOrder = Number(episode.sortOrder);
    if (Number.isFinite(sortOrder)) return sortOrder;
  }

  const episodeNumber = parseEpisodeNumber(episode?.episodeNumber);
  if (episodeNumber !== null) return episodeNumber;

  const id = Number(episode?.id);
  return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
}

/**
 * Compare function for sorting episodes numerically
 */
export function compareEpisodes(a: any, b: any): number {
  const sortA = getEpisodeSortValue(a);
  const sortB = getEpisodeSortValue(b);

  if (sortA !== sortB) return sortA - sortB;

  // Tiebreaker: sort by id
  const idA = Number(a?.id) || 0;
  const idB = Number(b?.id) || 0;
  return idA - idB;
}

/**
 * Format episode display label
 * Shows: #12 title
 * If title is empty, shows: #12
 */
export function formatEpisodeLabel(episodeNumber: unknown, title?: string | null): string {
  const num = episodeNumber ?? "?";
  const titleStr = title?.trim();
  return titleStr ? `#${num} ${titleStr}` : `#${num}`;
}
