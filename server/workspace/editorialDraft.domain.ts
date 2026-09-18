import { createHash } from "node:crypto";

export const EDITORIAL_DRAFT_NORMALIZATION_VERSION = 1 as const;
export const EDITORIAL_DRAFT_PRESENTATION = {
  fontFamily: "Sarabun",
  fontSizePt: 18,
  firstLineIndentPt: 36,
  spacingAfterPt: 10,
} as const;

const INVISIBLE_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g;
const THAI_DIGITS: Record<string, string> = {
  "๐": "0",
  "๑": "1",
  "๒": "2",
  "๓": "3",
  "๔": "4",
  "๕": "5",
  "๖": "6",
  "๗": "7",
  "๘": "8",
  "๙": "9",
};
const SOURCE_NO_CHAPTER_PATTERNS = [
  /ต้นฉบับไม่มีบทที่/,
  /ต้นฉบับไม่มีเลขบท/,
  /ต้นฉบับไม่ได้ระบุบทที่/,
  /ต้นฉบับไม่ได้ระบุเลขบท/,
  /ไม่มีเลขบทในต้นฉบับ/,
];
const ENDING_PROMO_PATTERNS = [
  /^โปรดติดตามตอนต่อไป(?:นะ|ครับ|ค่ะ)?[!.…]*$/,
  /^ฝากติดตามเพจ\s*ipe\s*นิยายแปล(?:\s*(?:ด้วยนะ|นะ|ครับ|ค่ะ))?[!.…]*$/i,
];

export type EditorialSourceKind = "google_doc" | "uploaded_file";
export type EditorialDraftOrigin =
  "source_import" | "source_refresh" | "manual";

export type EditorialSourceTabInput = {
  sourceTabId: string;
  tabOrder: number;
  title: string;
  paragraphs: string[];
};

export type EditorialSourcePayload = {
  sourceKind: EditorialSourceKind;
  sourceKey: string;
  providerDocumentId?: string | null;
  mimeType: string;
  title: string;
  revisionKey?: string | null;
  tabs: EditorialSourceTabInput[];
};

export type EditorialDraftParagraph = {
  paragraphKey: string;
  sourceParagraphIndex: number;
  paragraphOrder: number;
  text: string;
  sourceParagraphFingerprint: string;
  sourceOccurrenceCount: number;
  sourceOccurrenceOrdinal: number;
  paragraphFingerprint: string;
  occurrenceCount: number;
  occurrenceOrdinal: number;
};

export type EditorialDraftTab = {
  sourceTabId: string;
  tabOrder: number;
  title: string;
  paragraphs: EditorialDraftParagraph[];
  fingerprintSequence: string[];
  structuralSha256: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
  warnings: string[];
};

export type EditorialDraftDocument = {
  tabs: EditorialDraftTab[];
  warnings: string[];
};

export type EditorialDraftPipelineVersion = {
  transformCode: string;
  document: EditorialDraftDocument;
  beforeSha256: string | null;
  afterSha256: string;
  details: Record<string, unknown>;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function thaiDigitsToArabic(value: string) {
  return String(value || "").replace(/[๐-๙]/g, ch => THAI_DIGITS[ch] ?? ch);
}

export function normalizeEditorialText(value: string) {
  return thaiDigitsToArabic(
    String(value || "")
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .replace(INVISIBLE_RE, "")
      .replace(/　/g, " ")
  )
    .replace(/[\t ]+$/gm, "")
    .trim();
}

export function paragraphFingerprint(text: string) {
  return sha256(
    "workspace-editorial-paragraph-v1\0" + normalizeEditorialText(text)
  );
}

export function sourcePayloadSha256(payload: EditorialSourcePayload) {
  const canonical = {
    sourceKind: payload.sourceKind,
    sourceKey: payload.sourceKey.trim(),
    providerDocumentId: payload.providerDocumentId?.trim() || null,
    mimeType: payload.mimeType.trim(),
    tabs: payload.tabs
      .slice()
      .sort((a, b) => a.tabOrder - b.tabOrder)
      .map(tab => ({
        sourceTabId: tab.sourceTabId.trim(),
        tabOrder: tab.tabOrder,
        title: tab.title,
        paragraphs: tab.paragraphs.map(value => String(value ?? "")),
      })),
  };
  return sha256(JSON.stringify(canonical));
}

function chapterInfo(text: string) {
  const cleaned = normalizeEditorialText(text)
    .replace(/^[\s\u2013\u2014\-–—]+/, "")
    .trim();
  const m = cleaned.match(
    /^(?:บท(?:ที่)?|ตอนที่|chapter)\s*\[?\s*([0-9]+(?:\.[0-9]+)?(?:\s*(?:[-–—]|\.{2,})\s*[0-9]+(?:\.[0-9]+)?)?)\s*\]?\s*(?:[:：﹕꞉∶։]\s*)?(.*)$/i
  );
  if (!m) return null;
  const number = m[1]
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/\s+/g, "");
  let title = String(m[2] || "").trim();
  title = title
    .replace(/^\[?0([0-9]{2})\]?\s+/, "")
    .replace(/^(?:ตอนที่|ep\.?)\s*[0-9]+\s*[.:：-]?\s*/i, "")
    .trim();
  return { number, title };
}

export function normalizeChapterHeading(text: string) {
  const info = chapterInfo(text);
  if (!info) return normalizeEditorialText(text);
  return `บทที่ ${info.number}${info.title ? " " + info.title : ""}`;
}

function parseEnglishHeading(text: string) {
  const normalized = normalizeEditorialText(text);
  const match = normalized.match(/^chapter\s*([0-9]+(?:\.[0-9]+)?)\b/i);
  return match ? { text: normalized, chapterNumber: match[1] } : null;
}

function calculateLatinRatio(text: string) {
  const value = String(text || "");
  const letters =
    value.match(
      /[A-Za-z\u00C0-\u024F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF]/g
    ) || [];
  if (!letters.length) return 0;
  const latin = value.match(/[A-Za-z]/g) || [];
  return latin.length / letters.length;
}

function isThaiHeading(text: string) {
  return /^(?:บทที่|บท|ตอนที่)\s*\[?\s*[0-9๐-๙]+/.test(
    normalizeEditorialText(text)
  );
}

function detectEnglishSourceBlock(paragraphs: string[]) {
  const max = Math.min(paragraphs.length, 300);
  let first = -1;
  for (let i = 0; i < max; i += 1) {
    if (normalizeEditorialText(paragraphs[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return { detected: false as const };
  if (!parseEnglishHeading(paragraphs[first]))
    return { detected: false as const };

  let thaiHeadingIndex = -1;
  for (let i = first + 1; i < max; i += 1) {
    const text = normalizeEditorialText(paragraphs[i]);
    if (!text) continue;
    if (isThaiHeading(text)) {
      thaiHeadingIndex = i;
      break;
    }
    if (parseEnglishHeading(text)) break;
  }
  if (thaiHeadingIndex < 0) return { detected: false as const };

  const englishBody = paragraphs
    .slice(first + 1, thaiHeadingIndex)
    .map(normalizeEditorialText)
    .filter(Boolean);
  const latinRatio = calculateLatinRatio(englishBody.join(" "));
  let thaiAfterCount = 0;
  for (let i = thaiHeadingIndex + 1; i < max && thaiAfterCount < 5; i += 1) {
    const text = normalizeEditorialText(paragraphs[i]);
    if (!text) continue;
    if (isThaiHeading(text)) break;
    if (calculateLatinRatio(text) < 0.65) thaiAfterCount += 1;
  }
  const high =
    englishBody.length >= 2 && latinRatio >= 0.65 && thaiAfterCount >= 2;
  return {
    detected: true as const,
    confidence: high ? ("HIGH" as const) : ("LOW" as const),
    startIndex: first,
    endIndex: thaiHeadingIndex - 1,
    englishParagraphCount: englishBody.length,
    latinRatio,
    thaiAfterCount,
  };
}

function splitAdjacentPairs(text: string) {
  const gap = "[\\s\\u00A0\\u200B\\u200C\\u200D\\u200E\\u200F\\uFEFF\\u2060]*";
  return String(text || "")
    .replace(new RegExp('"' + gap + '"', "g"), '"\n"')
    .replace(new RegExp("”" + gap + "“", "g"), "”\n“")
    .replace(new RegExp("’" + gap + "‘", "g"), "’\n‘")
    .replace(new RegExp("\\]" + gap + "\\[", "g"), "]\n[");
}

function splitBracketStatusBlocks(text: string) {
  const raw = String(text || "");
  const matches = raw.match(/【[^】]{1,380}】/g);
  if (!matches || matches.length <= 1 || raw.length > 1600) return raw;
  if (!matches.some(item => /[:：]/.test(item))) return raw;
  return raw.replace(
    /】[\s\u00A0\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060]*【/g,
    "】\n【"
  );
}

function cleanupChapterParagraphs(paragraphs: EditorialDraftParagraph[]) {
  const out: EditorialDraftParagraph[] = [];
  let previousChapterOnly: string | null = null;
  for (const paragraph of paragraphs) {
    let text = normalizeChapterHeading(paragraph.text);
    text = text.replace(/^(บทที่\s+([0-9]+))\s+(?:บทที่|ตอนที่)\s+\2$/i, "$1");
    const info = chapterInfo(text);
    const chapterOnly = info && !info.title ? `บทที่ ${info.number}` : null;
    if (chapterOnly && chapterOnly === previousChapterOnly) continue;
    out.push({ ...paragraph, text });
    previousChapterOnly = chapterOnly;
  }
  return out;
}

function cleanupEnding(
  paragraphs: EditorialDraftParagraph[],
  sourceTabId: string
): EditorialDraftParagraph[] {
  const start = Math.max(0, paragraphs.length - 15);
  const kept = paragraphs.filter((paragraph, index) => {
    const normalized = normalizeEditorialText(paragraph.text).replace(
      /\s+/g,
      " "
    );
    return !(
      index >= start &&
      ENDING_PROMO_PATTERNS.some(pattern => pattern.test(normalized))
    );
  });

  const withoutDuplicateMarkers: EditorialDraftParagraph[] = [];
  let markerSeen = false;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const normalized = normalizeEditorialText(kept[i].text)
      .replace(/\s+/g, " ")
      .replace(/[!.…]+$/, "")
      .trim();
    if (normalized === "จบตอน") {
      if (markerSeen) continue;
      markerSeen = true;
      withoutDuplicateMarkers.unshift({ ...kept[i], text: "จบตอน" });
    } else {
      withoutDuplicateMarkers.unshift(kept[i]);
    }
  }
  if (!markerSeen) {
    const generatedFingerprint = paragraphFingerprint("จบตอน");
    withoutDuplicateMarkers.push({
      paragraphKey: sha256(
        "workspace-editorial-generated-end-v1\0" + sourceTabId
      ),
      sourceParagraphIndex: 0,
      paragraphOrder: withoutDuplicateMarkers.length + 1,
      text: "จบตอน",
      sourceParagraphFingerprint: generatedFingerprint,
      sourceOccurrenceCount: 1,
      sourceOccurrenceOrdinal: 1,
      paragraphFingerprint: generatedFingerprint,
      occurrenceCount: 1,
      occurrenceOrdinal: 1,
    });
  }
  return withoutDuplicateMarkers;
}

function sourceNoChapterWarning(paragraphs: string[]) {
  let meaningful = 0;
  for (let i = 0; i < paragraphs.length && meaningful < 10; i += 1) {
    const text = normalizeEditorialText(paragraphs[i]);
    if (!text) continue;
    meaningful += 1;
    if (SOURCE_NO_CHAPTER_PATTERNS.some(pattern => pattern.test(text))) {
      return "SOURCE_NO_CHAPTER_NOTE";
    }
  }
  return null;
}

function plainDocument(
  payload: EditorialSourcePayload
): EditorialDraftDocument {
  return {
    warnings: [],
    tabs: payload.tabs
      .slice()
      .sort((a, b) => a.tabOrder - b.tabOrder)
      .map(tab => {
        const sourceFingerprints = tab.paragraphs.map(text =>
          paragraphFingerprint(String(text ?? ""))
        );
        const counts = new Map<string, number>();
        sourceFingerprints.forEach(value =>
          counts.set(value, (counts.get(value) ?? 0) + 1)
        );
        const seen = new Map<string, number>();
        return {
          sourceTabId: tab.sourceTabId.trim(),
          tabOrder: tab.tabOrder,
          title: tab.title,
          paragraphs: tab.paragraphs.map((text, index) => {
            const sourceParagraphFingerprint = sourceFingerprints[index];
            const occurrenceOrdinal =
              (seen.get(sourceParagraphFingerprint) ?? 0) + 1;
            seen.set(sourceParagraphFingerprint, occurrenceOrdinal);
            const sourceOccurrenceCount =
              counts.get(sourceParagraphFingerprint) ?? 1;
            const paragraphKey = sha256(
              [
                "workspace-editorial-paragraph-key-v1",
                tab.sourceTabId.trim(),
                String(index + 1),
                sourceParagraphFingerprint,
                String(occurrenceOrdinal),
              ].join("\0")
            );
            return {
              paragraphKey,
              sourceParagraphIndex: index + 1,
              paragraphOrder: index + 1,
              text: String(text ?? ""),
              sourceParagraphFingerprint,
              sourceOccurrenceCount,
              sourceOccurrenceOrdinal: occurrenceOrdinal,
              paragraphFingerprint: sourceParagraphFingerprint,
              occurrenceCount: sourceOccurrenceCount,
              occurrenceOrdinal,
            };
          }),
          fingerprintSequence: [],
          structuralSha256: "",
          chapterNumber: null,
          chapterTitle: null,
          warnings: [],
        };
      }),
  };
}

function reindexDocument(document: EditorialDraftDocument) {
  const tabs = document.tabs.map(tab => {
    const withFingerprints = tab.paragraphs.map((paragraph, index) => {
      const text = String(paragraph.text ?? "");
      return {
        ...paragraph,
        paragraphOrder: index + 1,
        paragraphFingerprint: paragraphFingerprint(text),
      };
    });
    const counts = new Map<string, number>();
    for (const paragraph of withFingerprints) {
      counts.set(
        paragraph.paragraphFingerprint,
        (counts.get(paragraph.paragraphFingerprint) ?? 0) + 1
      );
    }
    const seen = new Map<string, number>();
    const paragraphs = withFingerprints.map(paragraph => {
      const occurrenceOrdinal =
        (seen.get(paragraph.paragraphFingerprint) ?? 0) + 1;
      seen.set(paragraph.paragraphFingerprint, occurrenceOrdinal);
      return {
        ...paragraph,
        occurrenceCount: counts.get(paragraph.paragraphFingerprint) ?? 1,
        occurrenceOrdinal,
      };
    });
    const fingerprintSequence = paragraphs.map(
      item => item.paragraphFingerprint
    );
    const structuralSha256 = sha256(fingerprintSequence.join("\u0000"));
    const heading = paragraphs
      .map(item => chapterInfo(item.text))
      .find((item): item is NonNullable<typeof item> => Boolean(item));
    const warnings = tab.warnings.slice();
    const noChapter = sourceNoChapterWarning(paragraphs.map(p => p.text));
    if (noChapter && !warnings.includes(noChapter)) warnings.push(noChapter);
    return {
      ...tab,
      paragraphs,
      fingerprintSequence,
      structuralSha256,
      chapterNumber: heading?.number ?? null,
      chapterTitle: heading?.title || null,
      warnings,
    };
  });
  const warnings = Array.from(
    new Set([...document.warnings, ...tabs.flatMap(tab => tab.warnings)])
  );
  return { ...document, tabs, warnings };
}

export function editorialDraftSha256(document: EditorialDraftDocument) {
  const canonical = document.tabs.map(tab => ({
    sourceTabId: tab.sourceTabId,
    tabOrder: tab.tabOrder,
    title: tab.title,
    paragraphs: tab.paragraphs.map(p => p.text),
  }));
  return sha256(
    `workspace-editorial-draft-v${EDITORIAL_DRAFT_NORMALIZATION_VERSION}\0` +
      JSON.stringify(canonical)
  );
}

function cloneDocument(
  document: EditorialDraftDocument
): EditorialDraftDocument {
  return JSON.parse(JSON.stringify(document)) as EditorialDraftDocument;
}

function addPipelineVersion(
  versions: EditorialDraftPipelineVersion[],
  transformCode: string,
  before: EditorialDraftDocument | null,
  after: EditorialDraftDocument,
  details: Record<string, unknown>
) {
  const reindexed = reindexDocument(after);
  const beforeSha256 = before
    ? editorialDraftSha256(reindexDocument(before))
    : null;
  const afterSha256 = editorialDraftSha256(reindexed);
  if (beforeSha256 === afterSha256 && transformCode !== "source_base") return;
  versions.push({
    transformCode,
    document: reindexed,
    beforeSha256,
    afterSha256,
    details,
  });
}

export function runEditorialPreparationPipeline(
  payload: EditorialSourcePayload
): EditorialDraftPipelineVersion[] {
  if (!payload.tabs.length) throw new Error("EDITORIAL_SOURCE_TABS_REQUIRED");
  const seenTabIds = new Set<string>();
  const seenTabOrders = new Set<number>();
  for (const tab of payload.tabs) {
    const id = tab.sourceTabId.trim();
    if (!id || seenTabIds.has(id))
      throw new Error("EDITORIAL_SOURCE_TAB_ID_INVALID");
    if (
      !Number.isInteger(tab.tabOrder) ||
      tab.tabOrder < 0 ||
      seenTabOrders.has(tab.tabOrder)
    ) {
      throw new Error("EDITORIAL_SOURCE_TAB_ORDER_INVALID");
    }
    seenTabIds.add(id);
    seenTabOrders.add(tab.tabOrder);
  }

  const versions: EditorialDraftPipelineVersion[] = [];
  let current = reindexDocument(plainDocument(payload));
  addPipelineVersion(versions, "source_base", null, current, {
    normalizationVersion: EDITORIAL_DRAFT_NORMALIZATION_VERSION,
    presentation: EDITORIAL_DRAFT_PRESENTATION,
  });

  let next = cloneDocument(current);
  for (const tab of next.tabs) {
    for (const paragraph of tab.paragraphs) {
      paragraph.text = normalizeEditorialText(paragraph.text);
    }
  }
  addPipelineVersion(versions, "unicode_thai_digit_cleanup", current, next, {});
  current = reindexDocument(next);

  next = cloneDocument(current);
  const englishReports: Record<string, unknown>[] = [];
  for (const tab of next.tabs) {
    const texts = tab.paragraphs.map(p => p.text);
    const report = detectEnglishSourceBlock(texts);
    if (!report.detected) continue;
    englishReports.push({ sourceTabId: tab.sourceTabId, ...report });
    if (report.confidence === "HIGH") {
      tab.paragraphs.splice(
        report.startIndex,
        report.endIndex - report.startIndex + 1
      );
    } else if (!tab.warnings.includes("ENGLISH_SOURCE_UNCERTAIN")) {
      tab.warnings.push("ENGLISH_SOURCE_UNCERTAIN");
    }
  }
  addPipelineVersion(versions, "english_source_cleanup", current, next, {
    reports: englishReports,
  });
  current = reindexDocument(next);

  next = cloneDocument(current);
  for (const tab of next.tabs) {
    tab.paragraphs = cleanupChapterParagraphs(tab.paragraphs);
  }
  addPipelineVersion(versions, "chapter_heading_cleanup", current, next, {});
  current = reindexDocument(next);

  next = cloneDocument(current);
  for (const tab of next.tabs) {
    const expanded: EditorialDraftParagraph[] = [];
    for (const paragraph of tab.paragraphs) {
      if (!normalizeEditorialText(paragraph.text)) {
        expanded.push(paragraph);
        continue;
      }
      const pieces = splitBracketStatusBlocks(
        splitAdjacentPairs(paragraph.text)
      )
        .split("\n")
        .map(value => normalizeEditorialText(value))
        .filter(Boolean);
      pieces.forEach((piece, pieceIndex) =>
        expanded.push({
          ...paragraph,
          paragraphKey:
            pieces.length === 1
              ? paragraph.paragraphKey
              : sha256(
                  [
                    "workspace-editorial-paragraph-split-v1",
                    paragraph.paragraphKey,
                    String(pieceIndex + 1),
                    piece,
                  ].join("\0")
                ),
          text: piece,
        })
      );
    }
    tab.paragraphs = expanded;
  }
  addPipelineVersion(versions, "quote_bracket_split", current, next, {});
  current = reindexDocument(next);

  next = cloneDocument(current);
  for (const tab of next.tabs) {
    tab.paragraphs = tab.paragraphs.filter(p => normalizeEditorialText(p.text));
  }
  addPipelineVersion(versions, "blank_line_cleanup", current, next, {});
  current = reindexDocument(next);

  next = cloneDocument(current);
  for (const tab of next.tabs) {
    tab.paragraphs = cleanupEnding(tab.paragraphs, tab.sourceTabId);
  }
  addPipelineVersion(versions, "ending_cleanup", current, next, {});
  return versions;
}
