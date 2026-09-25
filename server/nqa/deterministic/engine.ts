import type {
  NqaChapterExtraction,
  NqaChapterResolution,
} from "../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../core";
import type { NqaReasonCode, QaEvidenceRef } from "../contracts";
import type {
  NqaDeterministicMetrics,
  NqaDeterministicPolicy,
  NqaDeterministicQaResult,
  NqaForeignTextHit,
  NqaRepeatedParagraphHit,
} from "./contracts";
import { mergeNqaDeterministicPolicy } from "./policy";

const FAIL_REASONS = new Set<NqaReasonCode>([
  "MISSING_CHAPTER_ID",
  "EMPTY_CHAPTER",
  "EXACT_DUPLICATE_CHAPTER",
  "MALFORMED_CONTENT",
]);

function addReason(reasons: NqaReasonCode[], reason: NqaReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
function normalizedText(
  extraction: NqaChapterExtraction | null
): string | null {
  return extraction ? normalizeFixtureTextV1(extraction.text) : null;
}

function malformed(text: string | null): boolean {
  if (text === null) return false;
  return (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
    text.includes("\ufffd")
  );
}

function scanForeignText(
  text: string | null,
  policy: NqaDeterministicPolicy
): NqaForeignTextHit[] {
  if (!text) return [];

  const hits: NqaForeignTextHit[] = [];
  const characters = Array.from(text);
  let logicalIndex = 0;

  for (const character of characters) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;

    for (const rule of policy.foreignScriptRules) {
      if (codePoint >= rule.startCodePoint && codePoint <= rule.endCodePoint) {
        hits.push({
          ruleId: rule.id,
          label: rule.label,
          codePoint,
          character,
          index: logicalIndex,
        });
        if (hits.length >= 50) return hits;
      }
    }
    logicalIndex += character.length;
  }

  return hits;
}
function repeatedParagraphs(
  text: string | null,
  policy: NqaDeterministicPolicy
): NqaRepeatedParagraphHit[] {
  if (!text) return [];

  const counts = new Map<string, number>();
  for (const rawParagraph of text.split("\n")) {
    const paragraph = rawParagraph.normalize("NFC").trim().replace(/\s+/g, " ");
    if (paragraph.length < policy.repeatedParagraphMinChars) {
      continue;
    }
    counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(
      ([, occurrences]) =>
        occurrences >= policy.repeatedParagraphOccurrencesReview
    )
    .map(([normalizedText, occurrences]) => ({
      normalizedText,
      occurrences,
    }))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.normalizedText.localeCompare(right.normalizedText)
    )
    .slice(0, 10);
}

function hasEndingMarker(
  text: string | null,
  policy: NqaDeterministicPolicy
): boolean | null {
  if (text === null) return null;

  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  return policy.translationEndingMarkers.some(marker =>
    lines.some(line => line === marker || line.endsWith(marker))
  );
}
function ratio(
  numerator: number | null,
  denominator: number | null
): number | null {
  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}
function resolverReasons(
  resolution: NqaChapterResolution,
  reasons: NqaReasonCode[]
): void {
  for (const reason of resolution.reasonCodes) {
    if (reason === "DUPLICATE_CHAPTER_ID") {
      addReason(reasons, "DUPLICATE_CHAPTER_ID");
    } else if (reason === "INTERNAL_SEQUENCE_DRIFT") {
      addReason(reasons, "INTERNAL_SEQUENCE_DRIFT");
    } else if (
      reason === "SOURCE_CHAPTER_MISSING" ||
      reason === "TRANSLATION_CHAPTER_MISSING"
    ) {
      addReason(reasons, "MISSING_CHAPTER_ID");
    } else if (
      reason === "SOURCE_CHAPTER_AMBIGUOUS" ||
      reason === "TRANSLATION_CHAPTER_AMBIGUOUS"
    ) {
      addReason(reasons, "AMBIGUOUS_CHAPTER_MAPPING");
    }
  }

  if (resolution.status === "NOT_FOUND") {
    addReason(reasons, "MISSING_CHAPTER_ID");
  } else if (resolution.status === "REVIEW") {
    addReason(reasons, "AMBIGUOUS_CHAPTER_MAPPING");
  } else if (resolution.status === "RESOLVED_WITH_VARIANTS") {
    addReason(reasons, "DUPLICATE_CHAPTER_ID");
  }
}
function baseEvidence(input: {
  source: NqaChapterExtraction | null;
  translation: NqaChapterExtraction | null;
  metrics: NqaDeterministicMetrics;
}): QaEvidenceRef[] {
  const evidence: QaEvidenceRef[] = [];

  if (input.source) {
    evidence.push({
      evidenceId: "det-source-range",
      kind: "SOURCE_RANGE",
      sourceStartIndex: input.source.startIndex,
      sourceEndIndex: input.source.endIndex,
      sourceHash: input.source.sha256,
      boundedSummary:
        "Source snapshot: " +
        String(input.metrics.sourceChars ?? 0) +
        " chars, " +
        String(input.metrics.sourceParagraphs ?? 0) +
        " paragraphs.",
    });
  }

  if (input.translation) {
    evidence.push({
      evidenceId: "det-translation-range",
      kind: "TRANSLATION_RANGE",
      translationStartIndex: input.translation.startIndex,
      translationEndIndex: input.translation.endIndex,
      translationHash: input.translation.sha256,
      boundedSummary:
        "Translation snapshot: " +
        String(input.metrics.translationChars ?? 0) +
        " chars, " +
        String(input.metrics.translationParagraphs ?? 0) +
        " paragraphs.",
    });
  }

  return evidence;
}
function policyEvidence(
  reasonCodes: NqaReasonCode[],
  metrics: NqaDeterministicMetrics,
  policy: NqaDeterministicPolicy
): QaEvidenceRef[] {
  return reasonCodes.map((reason, index) => {
    let summary = "Deterministic policy triggered " + reason + ".";

    if (reason === "LENGTH_RATIO_OUTLIER") {
      summary =
        "Length ratio " +
        (metrics.lengthRatio?.toFixed(3) ?? "n/a") +
        " outside [" +
        policy.minLengthRatioReview +
        ", " +
        policy.maxLengthRatioReview +
        "].";
    } else if (reason === "PARAGRAPH_RATIO_OUTLIER") {
      summary =
        "Paragraph ratio " +
        (metrics.paragraphRatio?.toFixed(3) ?? "n/a") +
        " outside [" +
        policy.minParagraphRatioReview +
        ", " +
        policy.maxParagraphRatioReview +
        "].";
    } else if (reason === "REPEATED_PARAGRAPH") {
      summary =
        "Repeated paragraph groups: " +
        metrics.repeatedParagraphs.length +
        "; threshold " +
        policy.repeatedParagraphOccurrencesReview +
        " occurrences.";
    } else if (reason === "FOREIGN_TEXT_POLICY_VIOLATION") {
      const preview = metrics.foreignTextHits
        .slice(0, 5)
        .map(
          hit =>
            hit.label +
            ":U+" +
            hit.codePoint.toString(16).toUpperCase().padStart(4, "0")
        )
        .join(", ");
      summary = "Foreign-script policy hits: " + (preview || "detected") + ".";
    } else if (reason === "MISSING_ENDING_MARKER") {
      summary =
        "Required ending marker not found; accepted markers: " +
        policy.translationEndingMarkers.join(", ");
    }

    return {
      evidenceId: "det-policy-" + String(index + 1).padStart(2, "0"),
      kind: "POLICY",
      boundedSummary: summary.slice(0, 1000),
    };
  });
}
export function runDeterministicQa(input: {
  resolution: NqaChapterResolution;
  source: NqaChapterExtraction | null;
  translation: NqaChapterExtraction | null;
  policy?: Partial<NqaDeterministicPolicy>;
}): NqaDeterministicQaResult {
  const policy = mergeNqaDeterministicPolicy(input.policy);
  const reasons: NqaReasonCode[] = [];
  resolverReasons(input.resolution, reasons);

  const sourceText = normalizedText(input.source);
  const translationText = normalizedText(input.translation);
  const sourceChars =
    sourceText === null ? null : Array.from(sourceText).length;
  const translationChars =
    translationText === null ? null : Array.from(translationText).length;
  const sourceParagraphs = input.source?.paragraphCount ?? null;
  const translationParagraphs = input.translation?.paragraphCount ?? null;

  const metrics: NqaDeterministicMetrics = {
    sourceChars,
    translationChars,
    lengthRatio: ratio(translationChars, sourceChars),
    sourceParagraphs,
    translationParagraphs,
    paragraphRatio: ratio(translationParagraphs, sourceParagraphs),
    exactDuplicate:
      sourceText !== null && translationText !== null
        ? sha256Hex(sourceText) === sha256Hex(translationText)
        : null,
    repeatedParagraphs: repeatedParagraphs(translationText, policy),
    foreignTextHits: scanForeignText(translationText, policy),
    malformedSource: malformed(sourceText),
    malformedTranslation: malformed(translationText),
    hasTranslationEndingMarker: hasEndingMarker(translationText, policy),
  };
  if (
    sourceText !== null &&
    sourceText.split("\n").slice(1).join("\n").trim().length === 0
  ) {
    addReason(reasons, "EMPTY_CHAPTER");
  }
  if (
    translationText !== null &&
    translationText.split("\n").slice(1).join("\n").trim().length === 0
  ) {
    addReason(reasons, "EMPTY_CHAPTER");
  }

  for (const chars of [sourceChars, translationChars]) {
    if (chars === null) continue;
    if (chars < policy.minChapterCharsReview) {
      addReason(reasons, "SUSPICIOUSLY_SHORT_CHAPTER");
    }
    if (chars > policy.maxChapterCharsReview) {
      addReason(reasons, "SUSPICIOUSLY_LONG_CHAPTER");
    }
  }

  if (
    metrics.lengthRatio !== null &&
    (metrics.lengthRatio < policy.minLengthRatioReview ||
      metrics.lengthRatio > policy.maxLengthRatioReview)
  ) {
    addReason(reasons, "LENGTH_RATIO_OUTLIER");
  }

  if (
    metrics.paragraphRatio !== null &&
    (metrics.paragraphRatio < policy.minParagraphRatioReview ||
      metrics.paragraphRatio > policy.maxParagraphRatioReview)
  ) {
    addReason(reasons, "PARAGRAPH_RATIO_OUTLIER");
  }

  if (metrics.exactDuplicate) {
    addReason(reasons, "EXACT_DUPLICATE_CHAPTER");
  }
  if (metrics.repeatedParagraphs.length > 0) {
    addReason(reasons, "REPEATED_PARAGRAPH");
  }
  if (metrics.foreignTextHits.length > 0) {
    addReason(reasons, "FOREIGN_TEXT_POLICY_VIOLATION");
  }
  if (metrics.malformedSource || metrics.malformedTranslation) {
    addReason(reasons, "MALFORMED_CONTENT");
  }
  if (
    policy.requireTranslationEndingMarker &&
    metrics.hasTranslationEndingMarker === false
  ) {
    addReason(reasons, "MISSING_ENDING_MARKER");
  }
  const decision = reasons.some(reason => FAIL_REASONS.has(reason))
    ? "FAIL"
    : reasons.length > 0
      ? "REVIEW"
      : "PASS";

  return {
    decision,
    reasonCodes: reasons,
    metrics,
    evidence: [
      ...baseEvidence({
        source: input.source,
        translation: input.translation,
        metrics,
      }),
      ...policyEvidence(reasons, metrics, policy),
    ],
    policyVersion: policy.version,
    resolverStatus: input.resolution.status,
    resolverReasonCodes: [...input.resolution.reasonCodes],
  };
}
