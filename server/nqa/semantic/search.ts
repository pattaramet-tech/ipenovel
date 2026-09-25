import type {
  NqaChapterExtraction,
  NqaDocumentSnapshot,
} from "../chapter/contracts";
import { extractSourceChapter } from "../chapter/extractor";
import { buildSourceChapterBoundaries } from "../chapter/parser";
import { normalizeFixtureTextV1 } from "../core";
import type { NqaReasonCode, QaEvidenceRef } from "../contracts";
import type {
  NqaEmbeddingProvider,
  NqaGlobalSourceSearchResult,
  NqaSemanticSearchPolicy,
  NqaSemanticSourceCandidate,
} from "./contracts";
import { cosineSimilarity } from "./embedding";
import { mergeNqaSemanticSearchPolicy } from "./policy";

export function normalizeSemanticChapterText(text: string): string {
  const lines = normalizeFixtureTextV1(text)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const body = lines.slice(1).filter(line => {
    const normalized = line.toLocaleLowerCase("th");
    return (
      normalized !== "ความคิดเห็น" &&
      normalized !== "โหวต" &&
      normalized !== "จบตอน"
    );
  });

  return body.join("\n").trim();
}

function addReason(reasons: NqaReasonCode[], reason: NqaReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function boundedEvidence(input: {
  expectedChapter: number;
  expectedRank: number | null;
  expectedSimilarity: number | null;
  best: NqaSemanticSourceCandidate | null;
  alternate: NqaSemanticSourceCandidate | null;
  expectedLead: number | null;
  margin: number | null;
  providerId: string;
  modelVersion: string;
}): QaEvidenceRef[] {
  const summary = [
    "Global source search.",
    "expected=" + input.expectedChapter,
    "rank=" + (input.expectedRank ?? "n/a"),
    "expectedSimilarity=" + (input.expectedSimilarity?.toFixed(4) ?? "n/a"),
    "best=" +
      (input.best
        ? input.best.chapter + ":" + input.best.similarity.toFixed(4)
        : "n/a"),
    "bestAlternate=" +
      (input.alternate
        ? input.alternate.chapter + ":" + input.alternate.similarity.toFixed(4)
        : "n/a"),
    "expectedLeadOverAlternate=" + (input.expectedLead?.toFixed(4) ?? "n/a"),
    "marginOverExpected=" + (input.margin?.toFixed(4) ?? "n/a"),
    "provider=" + input.providerId,
    "model=" + input.modelVersion,
  ].join(" ");

  return [
    {
      evidenceId: "semantic-global-search",
      kind: "POLICY",
      boundedSummary: summary.slice(0, 1000),
    },
  ];
}
export async function searchGlobalSourceChapters(input: {
  sourceSnapshot: NqaDocumentSnapshot;
  translation: NqaChapterExtraction;
  expectedChapter: number;
  provider: NqaEmbeddingProvider;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  policy?: Partial<NqaSemanticSearchPolicy>;
}): Promise<NqaGlobalSourceSearchResult> {
  const policy = mergeNqaSemanticSearchPolicy(input.policy);

  const boundaries = buildSourceChapterBoundaries(input.sourceSnapshot).filter(
    boundary => {
      if (
        input.rangeStart !== undefined &&
        input.rangeStart !== null &&
        boundary.chapter < input.rangeStart
      ) {
        return false;
      }
      if (
        input.rangeEnd !== undefined &&
        input.rangeEnd !== null &&
        boundary.chapter > input.rangeEnd
      ) {
        return false;
      }
      return true;
    }
  );

  const sourceExtractions = boundaries.map(boundary =>
    extractSourceChapter({
      snapshot: input.sourceSnapshot,
      boundary,
    })
  );

  const translationText = normalizeSemanticChapterText(input.translation.text);
  const sourceTexts = sourceExtractions.map(extraction =>
    normalizeSemanticChapterText(extraction.text)
  );

  if (!translationText || sourceTexts.length === 0) {
    const reasonCodes: NqaReasonCode[] = ["INSUFFICIENT_EVIDENCE"];
    return {
      decision: "REVIEW",
      reasonCodes,
      expectedChapter: input.expectedChapter,
      expectedRank: null,
      expectedSimilarity: null,
      bestCandidate: null,
      bestAlternate: null,
      expectedLeadOverAlternate: null,
      marginOverExpected: null,
      candidates: [],
      providerId: input.provider.providerId,
      modelVersion: input.provider.modelVersion,
      policyVersion: policy.version,
      evidence: boundedEvidence({
        expectedChapter: input.expectedChapter,
        expectedRank: null,
        expectedSimilarity: null,
        best: null,
        alternate: null,
        expectedLead: null,
        margin: null,
        providerId: input.provider.providerId,
        modelVersion: input.provider.modelVersion,
      }),
    };
  }

  const vectors = await input.provider.embed([translationText, ...sourceTexts]);
  if (vectors.length !== sourceTexts.length + 1) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }

  const query = vectors[0];
  const candidates = sourceExtractions
    .map((extraction, index): NqaSemanticSourceCandidate => ({
      chapter: extraction.chapter,
      internalSequence: extraction.internalSequence ?? 0,
      title: extraction.title ?? "",
      tabId: extraction.tabId,
      sha256: extraction.sha256,
      similarity: cosineSimilarity(query, vectors[index + 1]),
    }))
    .sort(
      (left, right) =>
        right.similarity - left.similarity || left.chapter - right.chapter
    );

  const expectedIndex = candidates.findIndex(
    candidate => candidate.chapter === input.expectedChapter
  );
  const expectedRank = expectedIndex >= 0 ? expectedIndex + 1 : null;
  const expected = expectedIndex >= 0 ? candidates[expectedIndex] : null;
  const best = candidates[0] ?? null;
  const alternate =
    candidates.find(candidate => candidate.chapter !== input.expectedChapter) ??
    null;
  const expectedLead =
    expected && alternate
      ? expected.similarity - alternate.similarity
      : expected
        ? expected.similarity
        : null;
  const margin =
    expected && best && best.chapter !== input.expectedChapter
      ? best.similarity - expected.similarity
      : 0;
  const reasonCodes: NqaReasonCode[] = [];
  let decision: "PASS" | "REVIEW" | "FAIL" = "REVIEW";

  if (!expected) {
    addReason(reasonCodes, "INSUFFICIENT_EVIDENCE");
  } else if (
    expectedRank !== null &&
    expectedRank <= policy.maxExpectedRankPass &&
    expected.similarity >= policy.minExpectedSimilarityPass &&
    (alternate === null ||
      (expectedLead !== null && expectedLead >= policy.minExpectedLeadPass))
  ) {
    decision = "PASS";
  } else if (
    best &&
    best.chapter !== input.expectedChapter &&
    best.similarity >= policy.minWrongSourceSimilarityFail &&
    margin >= policy.minWrongSourceMarginFail
  ) {
    decision = "FAIL";
    addReason(reasonCodes, "WRONG_CHAPTER");

    if (
      Math.abs(best.chapter - input.expectedChapter) >
      policy.nearbyChapterDistance
    ) {
      addReason(reasonCodes, "SOURCE_DRIFT");
    }
  } else {
    addReason(reasonCodes, "LOW_CONFIDENCE");
  }

  const limitedCandidates = candidates.slice(
    0,
    Math.max(1, policy.maxCandidates)
  );

  return {
    decision,
    reasonCodes,
    expectedChapter: input.expectedChapter,
    expectedRank,
    expectedSimilarity: expected?.similarity ?? null,
    bestCandidate: best,
    bestAlternate: alternate,
    expectedLeadOverAlternate: expectedLead,
    marginOverExpected:
      best && best.chapter !== input.expectedChapter ? margin : 0,
    candidates: limitedCandidates,
    providerId: input.provider.providerId,
    modelVersion: input.provider.modelVersion,
    policyVersion: policy.version,
    evidence: boundedEvidence({
      expectedChapter: input.expectedChapter,
      expectedRank,
      expectedSimilarity: expected?.similarity ?? null,
      best,
      alternate,
      expectedLead,
      margin: best && best.chapter !== input.expectedChapter ? margin : 0,
      providerId: input.provider.providerId,
      modelVersion: input.provider.modelVersion,
    }),
  };
}
