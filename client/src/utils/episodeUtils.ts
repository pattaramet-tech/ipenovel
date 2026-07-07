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
 * Descending version of compareEpisodes (highest episode number first).
 */
export function compareEpisodesDesc(a: any, b: any): number {
  return compareEpisodes(b, a);
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

export type EpisodeGroup = {
  key: string;
  label: string;
  start: number;
  end: number;
  episodes: any[];
};

/**
 * Group episodes into table-of-contents buckets of 100 (บทที่ 1-100, 101-200, ...).
 * Grouping is based on the episode's own numeric episodeNumber (not sortOrder),
 * since the range should reflect the chapter number a reader recognizes, not an
 * admin-assigned manual ordering override. Episodes whose episodeNumber can't be
 * parsed into a number fall into a trailing "unknown" bucket.
 *
 * For range-style episodeNumbers like "436 - 508", the first number (436) decides
 * the bucket - the episode still displays its full original label via
 * formatEpisodeLabel elsewhere, this only affects which group it's filed under.
 */
export function groupEpisodesByHundreds(episodes: any[]): EpisodeGroup[] {
  const groups = new Map<string, EpisodeGroup>();

  for (const episode of episodes) {
    const num = parseEpisodeNumber(episode?.episodeNumber);

    if (num === null) {
      const key = "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: "ไม่ทราบเลขตอน",
          start: Number.MAX_SAFE_INTEGER,
          end: Number.MAX_SAFE_INTEGER,
          episodes: [],
        });
      }
      groups.get(key)!.episodes.push(episode);
      continue;
    }

    const start = Math.floor((Math.max(1, Math.floor(num)) - 1) / 100) * 100 + 1;
    const end = start + 99;
    const key = `${start}-${end}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: `บทที่ ${start} - ${end}`,
        start,
        end,
        episodes: [],
      });
    }

    groups.get(key)!.episodes.push(episode);
  }

  return Array.from(groups.values())
    .sort((a, b) => a.start - b.start)
    .map((group) => ({
      ...group,
      episodes: [...group.episodes].sort(compareEpisodes),
    }));
}
