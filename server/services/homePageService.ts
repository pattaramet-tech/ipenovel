import { getDb } from "../db";
import { banners, novels, episodes, purchases } from "../../drizzle/schema";
import { eq, and, desc, isNull } from "drizzle-orm";

export interface HomePageData {
  banners: typeof banners.$inferSelect[];
  featuredNovels: (typeof novels.$inferSelect & { episodeCount: number })[];
  newNovels: (typeof novels.$inferSelect & { episodeCount: number })[];
  latestUpdatedNovels: (typeof novels.$inferSelect & { latestEpisodeDate: Date | null })[];
  freeHighlights: (typeof novels.$inferSelect & { freeEpisodeCount: number })[];
  categories: { id: number; name: string; novelCount: number }[];
}

export async function getHomePageData(): Promise<HomePageData> {
  const db = await getDb();
  if (!db) {
    return {
      banners: [],
      featuredNovels: [],
      newNovels: [],
      latestUpdatedNovels: [],
      freeHighlights: [],
      categories: [],
    };
  }

  try {
    // Get active banners
    const bannerList = await db
      .select()
      .from(banners)
      .orderBy(desc(banners.createdAt))
      .limit(5);

    // Get featured novels (all published novels, sorted by creation date)
    const featuredNovelsList = await db
      .select()
      .from(novels)
      .orderBy(desc(novels.createdAt))
      .limit(8);

    // Get new novels
    const newNovelsList = await db
      .select()
      .from(novels)
      .orderBy(desc(novels.createdAt))
      .limit(8);

    // Get latest updated novels (by episode creation)
    const latestUpdatedNovelsList = await db
      .select()
      .from(novels)
      .orderBy(desc(novels.updatedAt))
      .limit(8);

    // Get free highlights (novels with free episodes)
    const freeHighlightsList = await db
      .select()
      .from(novels)
      .orderBy(desc(novels.createdAt))
      .limit(8);

    // Get categories with novel counts
    const categoryList = await db
      .selectDistinct()
      .from(novels)
      .limit(12);

    return {
      banners: bannerList,
      featuredNovels: featuredNovelsList.map((n) => ({
        ...n,
        episodeCount: 0, // Will be calculated on frontend or in separate query
      })),
      newNovels: newNovelsList.map((n) => ({
        ...n,
        episodeCount: 0,
      })),
      latestUpdatedNovels: latestUpdatedNovelsList.map((n) => ({
        ...n,
        latestEpisodeDate: n.updatedAt,
      })),
      freeHighlights: freeHighlightsList.map((n) => ({
        ...n,
        freeEpisodeCount: 0,
      })),
      categories: categoryList.map((n) => ({
        id: n.id,
        name: n.title,
        novelCount: 1,
      })),
    };
  } catch (error) {
    console.error("[HomePageService] Error fetching home page data:", error);
    return {
      banners: [],
      featuredNovels: [],
      newNovels: [],
      latestUpdatedNovels: [],
      freeHighlights: [],
      categories: [],
    };
  }
}
