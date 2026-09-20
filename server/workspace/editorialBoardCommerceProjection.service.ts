import { and, eq, inArray } from "drizzle-orm";
import { episodes } from "../../drizzle/schema";
import { getDb } from "../db";

function parseSpan(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start ? { start, end } : null;
}

function sameSpan(a: string | null | undefined, b: string | null | undefined) {
  const left = parseSpan(a);
  const right = parseSpan(b);
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

export async function projectEditorialBoardSaleFallback<T extends { columns?: any[] }>(board: T): Promise<T> {
  const db = await getDb();
  if (!db || !Array.isArray(board.columns)) return board;
  const cards = board.columns.flatMap((column: any) => column.cards ?? []);
  const novelIds = Array.from(new Set(cards.map((card: any) => card.novel?.id).filter((id: any): id is number => Number.isInteger(id) && id > 0)));
  if (!novelIds.length) return board;

  const published = await db.select({
    id: episodes.id,
    novelId: episodes.novelId,
    episodeNumber: episodes.episodeNumber,
    saleMode: episodes.saleMode,
    price: episodes.price,
    isFree: episodes.isFree,
  }).from(episodes).where(and(inArray(episodes.novelId, novelIds), eq(episodes.isPublished, true)));

  return {
    ...board,
    columns: board.columns.map((column: any) => ({
      ...column,
      cards: (column.cards ?? []).map((card: any) => {
        const workItemComplete =
          (card.saleMode === "chapter" || card.saleMode === "package") &&
          card.price !== null &&
          typeof card.isFree === "boolean";
        if (workItemComplete || !card.novel?.id || !card.episodeNumber) {
          return { ...card, saleMetadataSource: workItemComplete ? "work_item" : null };
        }
        const fallback = published.find((episode: any) =>
          episode.novelId === card.novel.id && sameSpan(episode.episodeNumber, card.episodeNumber)
        );
        if (!fallback) return { ...card, saleMetadataSource: null };
        return {
          ...card,
          saleMode: fallback.saleMode,
          price: fallback.price,
          isFree: fallback.isFree,
          saleMetadataSource: "published_episode",
          saleMetadataEpisodeId: fallback.id,
        };
      }),
    })),
  } as T;
}
