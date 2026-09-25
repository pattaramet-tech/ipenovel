export const EDITORIAL_BOARD_SLUG = "editorial";
export const EDITORIAL_BOARD_NAME = "Editorial";

export const EDITORIAL_COLUMNS = [
  { key: "new", name: "ใหม่เข้า", position: 0 },
  { key: "pending_check", name: "รอตรวจ", position: 1 },
  { key: "needs_fix", name: "ต้องแก้", position: 2 },
  { key: "editing", name: "กำลังแก้", position: 3 },
  { key: "pending_confirm", name: "รอยืนยัน", position: 4 },
  { key: "ready_to_publish", name: "พร้อมเผยแพร่", position: 5 },
  { key: "published", name: "เผยแพร่แล้ว", position: 6 },
] as const;

export type EditorialColumnKey = (typeof EDITORIAL_COLUMNS)[number]["key"];

export function editorialStoryLogicalKey(workspaceNovelId: number) {
  if (!Number.isInteger(workspaceNovelId) || workspaceNovelId <= 0) {
    throw new Error("workspaceNovelId must be a positive integer.");
  }
  return `story:${workspaceNovelId}`;
}
export function parseEditorialStoryLogicalKey(value: string) {
  const match = /^story:(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  const workspaceNovelId = Number(match[1]);
  return Number.isInteger(workspaceNovelId) && workspaceNovelId > 0
    ? { workItemType: "NEW_STORY" as const, workspaceNovelId }
    : null;
}

export function normalizeEditorialEpisodeKey(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function editorialEpisodeLogicalKey(
  workspaceNovelId: number,
  episodeNumber: string
) {
  if (!Number.isInteger(workspaceNovelId) || workspaceNovelId <= 0) {
    throw new Error("workspaceNovelId must be a positive integer.");
  }
  const itemKey = normalizeEditorialEpisodeKey(episodeNumber);
  if (!itemKey) throw new Error("episodeNumber is required.");
  if (itemKey.length > 100) throw new Error("episodeNumber is too long.");
  return `episode:${workspaceNovelId}:${itemKey}`;
}

export function parseEditorialEpisodeLogicalKey(value: string) {
  const match = /^episode:(\d+):(.+)$/.exec(String(value || ""));
  if (!match) return null;
  const workspaceNovelId = Number(match[1]);
  const itemKey = normalizeEditorialEpisodeKey(match[2]);
  return Number.isInteger(workspaceNovelId) && workspaceNovelId > 0 && itemKey
    ? { workItemType: "NEW_EPISODE" as const, workspaceNovelId, itemKey }
    : null;
}

export function parseEditorialLogicalKey(value: string) {
  return (
    parseEditorialStoryLogicalKey(value) ??
    parseEditorialEpisodeLogicalKey(value)
  );
}

export function isCanonicalEditorialColumn(column: {
  key: string;
  name: string;
  position: number;
}) {
  const canonical = EDITORIAL_COLUMNS.find(item => item.key === column.key);
  return Boolean(
    canonical &&
    canonical.name === column.name &&
    canonical.position === column.position
  );
}
