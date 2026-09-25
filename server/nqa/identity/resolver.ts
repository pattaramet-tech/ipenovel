import type { SourceContract } from "../contracts";
import { makeNovelCandidateIdentity, normalizeIdentityTitle } from "../core";
import type {
  NqaFuzzyCandidate,
  NqaIdentityCatalog,
  NqaIdentityResolution,
  NqaNovelCatalogEntry,
} from "./contracts";

export type NqaNovelIdentityResolverOptions = {
  fuzzyThreshold?: number;
  fuzzyLimit?: number;
};

const DEFAULT_FUZZY_THRESHOLD = 0.86;
const DEFAULT_FUZZY_LIMIT = 5;

function characterBigrams(input: string): string[] {
  const compact = normalizeIdentityTitle(input).replace(/\s+/g, "");
  if (compact.length < 2) {
    return compact ? [compact] : [];
  }

  const output: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    output.push(compact.slice(index, index + 2));
  }
  return output;
}

export function titleDiceSimilarity(left: string, right: string): number {
  const a = characterBigrams(left);
  const b = characterBigrams(right);

  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of a) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let intersection = 0;
  for (const token of b) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(token, count - 1);
    }
  }

  return (2 * intersection) / (a.length + b.length);
}
function uniqueNovels(entries: NqaNovelCatalogEntry[]): NqaNovelCatalogEntry[] {
  const byId = new Map<string, NqaNovelCatalogEntry>();
  for (const entry of entries) {
    byId.set(entry.novel.novelId, entry);
  }
  return Array.from(byId.values());
}

function withAuthority(
  entry: NqaNovelCatalogEntry,
  authority: "EXACT" | "ALIAS"
) {
  return {
    ...entry.novel,
    aliases: [...entry.novel.aliases],
    authority,
  };
}

export class NqaNovelIdentityResolver {
  private readonly fuzzyThreshold: number;
  private readonly fuzzyLimit: number;

  constructor(
    private readonly catalog: NqaIdentityCatalog,
    options: NqaNovelIdentityResolverOptions = {}
  ) {
    this.fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
    this.fuzzyLimit = Math.max(1, options.fuzzyLimit ?? DEFAULT_FUZZY_LIMIT);
  }

  resolve(input: {
    canonicalTitle: string;
    contract: SourceContract;
  }): NqaIdentityResolution {
    const documentMatches = uniqueNovels(
      this.catalog.novels.filter(entry => {
        const translationId = input.contract.translationRef.documentId;
        const sourceId = input.contract.preparedSourceRef.documentId;
        return (
          entry.translationDocumentIds.includes(translationId) ||
          entry.sourceDocumentIds.includes(sourceId)
        );
      })
    );

    if (documentMatches.length > 1) {
      return {
        status: "REVIEW",
        kind: "AMBIGUOUS",
        novel: null,
        candidates: documentMatches.map(entry => ({
          novelId: entry.novel.novelId,
          canonicalTitle: entry.novel.canonicalTitle,
          score: 1,
        })),
      };
    }
    const normalized = normalizeIdentityTitle(input.canonicalTitle);
    const exactTitleMatches = uniqueNovels(
      this.catalog.novels.filter(
        entry =>
          normalizeIdentityTitle(entry.novel.canonicalTitle) === normalized
      )
    );
    const aliasMatches = uniqueNovels(
      this.catalog.novels.filter(entry =>
        entry.novel.aliases.some(
          alias => normalizeIdentityTitle(alias) === normalized
        )
      )
    );

    const titleIdentityIds = new Set([
      ...exactTitleMatches.map(entry => entry.novel.novelId),
      ...aliasMatches.map(entry => entry.novel.novelId),
    ]);

    if (
      documentMatches.length === 1 &&
      titleIdentityIds.size > 0 &&
      !titleIdentityIds.has(documentMatches[0].novel.novelId)
    ) {
      const candidates = uniqueNovels([
        documentMatches[0],
        ...exactTitleMatches,
        ...aliasMatches,
      ]);
      return {
        status: "REVIEW",
        kind: "AMBIGUOUS",
        novel: null,
        candidates: candidates.map(entry => ({
          novelId: entry.novel.novelId,
          canonicalTitle: entry.novel.canonicalTitle,
          score: 1,
        })),
      };
    }

    if (documentMatches.length === 1) {
      return {
        status: "RESOLVED",
        kind: "KNOWN_DOCUMENT",
        novel: withAuthority(documentMatches[0], "EXACT"),
        candidates: [],
      };
    }

    if (exactTitleMatches.length > 1) {
      return {
        status: "REVIEW",
        kind: "AMBIGUOUS",
        novel: null,
        candidates: exactTitleMatches.map(entry => ({
          novelId: entry.novel.novelId,
          canonicalTitle: entry.novel.canonicalTitle,
          score: 1,
        })),
      };
    }
    if (exactTitleMatches.length === 1) {
      return {
        status: "RESOLVED",
        kind: "EXACT_TITLE",
        novel: withAuthority(exactTitleMatches[0], "EXACT"),
        candidates: [],
      };
    }

    if (aliasMatches.length > 1) {
      return {
        status: "REVIEW",
        kind: "AMBIGUOUS",
        novel: null,
        candidates: aliasMatches.map(entry => ({
          novelId: entry.novel.novelId,
          canonicalTitle: entry.novel.canonicalTitle,
          score: 1,
        })),
      };
    }

    if (aliasMatches.length === 1) {
      return {
        status: "RESOLVED",
        kind: "ALIAS",
        novel: withAuthority(aliasMatches[0], "ALIAS"),
        candidates: [],
      };
    }

    const fuzzyCandidates: NqaFuzzyCandidate[] = this.catalog.novels
      .map(entry => ({
        novelId: entry.novel.novelId,
        canonicalTitle: entry.novel.canonicalTitle,
        score: titleDiceSimilarity(
          input.canonicalTitle,
          entry.novel.canonicalTitle
        ),
      }))
      .filter(candidate => candidate.score >= this.fuzzyThreshold)
      .sort(
        (left, right) =>
          right.score - left.score || left.novelId.localeCompare(right.novelId)
      )
      .slice(0, this.fuzzyLimit);

    if (fuzzyCandidates.length > 0) {
      return {
        status: "REVIEW",
        kind: "FUZZY_REVIEW",
        novel: null,
        candidates: fuzzyCandidates,
      };
    }

    return {
      status: "NEW",
      kind: "STRUCTURED_NEW",
      novel: makeNovelCandidateIdentity(input.canonicalTitle),
      candidates: [],
    };
  }
}
