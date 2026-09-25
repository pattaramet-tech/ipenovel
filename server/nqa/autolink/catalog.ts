import { getNovelById, searchNovelsForAdmin } from "../../db";
import type {
  NqaNovelCatalogCandidate,
  NqaNovelCatalogReader,
} from "./contracts";

function candidateFromNovel(novel: any): NqaNovelCatalogCandidate {
  return {
    novelId: Number(novel.id),
    title: String(novel.title ?? ""),
    slug: typeof novel.slug === "string" ? novel.slug : null,
    author: typeof novel.author === "string" ? novel.author : null,
    publicationStatus:
      typeof novel.publicationStatus === "string"
        ? novel.publicationStatus
        : null,
  };
}

export class DatabaseNqaNovelCatalogReader implements NqaNovelCatalogReader {
  async searchByTitle(title: string): Promise<NqaNovelCatalogCandidate[]> {
    const candidates = await searchNovelsForAdmin(title, 100);
    return candidates.map(candidateFromNovel);
  }

  async getById(novelId: number): Promise<NqaNovelCatalogCandidate | null> {
    const novel = await getNovelById(novelId, false);
    return novel ? candidateFromNovel(novel) : null;
  }
}
