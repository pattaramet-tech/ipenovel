/** Effective time for a *published* episode: publication or later edit. */
export function publishedEpisodeDisplayTime(episode: {
  createdAt?: Date | string | null;
  publishedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): Date | null {
  const parse = (value: Date | string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const published = parse(episode.publishedAt) ?? parse(episode.createdAt);
  const updated = parse(episode.updatedAt);
  if (!updated) return published;
  if (!published) return updated;
  return updated > published ? updated : published;
}

/** Consistent Bangkok-local wall time for public and admin content metadata. */
export function formatContentTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(parsed) + " น.";
}
