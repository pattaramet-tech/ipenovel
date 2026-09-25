import type { NqaNovelCatalogCandidate } from "./contracts";

export function normalizeNqaNovelTitle(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function exactNqaNovelTitleCandidates(input: {
  novelTitle: string;
  candidates: readonly NqaNovelCatalogCandidate[];
}): NqaNovelCatalogCandidate[] {
  const normalized = normalizeNqaNovelTitle(input.novelTitle);
  const byId = new Map<number, NqaNovelCatalogCandidate>();

  for (const candidate of input.candidates) {
    if (
      candidate.novelId > 0 &&
      normalizeNqaNovelTitle(candidate.title) === normalized
    ) {
      byId.set(candidate.novelId, candidate);
    }
  }

  return Array.from(byId.values()).sort(
    (left, right) => left.novelId - right.novelId
  );
}
