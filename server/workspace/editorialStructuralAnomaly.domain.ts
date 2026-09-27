import { createHash } from "node:crypto";
import { normalizeEditorialText } from "./editorialDraft.domain";

export const EDITORIAL_STRUCTURAL_CHECK_VERSION =
  "workspace-editorial-structural-check-v1" as const;

export type EditorialStructuralAnomalyType =
  | "empty_tab"
  | "end_only_tab"
  | "heading_only_tab"
  | "source_note_only"
  | "missing_expected_chapter"
  | "duplicate_chapter_number"
  | "tab_count_mismatch"
  | "duplicate_content_exact"
  | "duplicate_content_near";

export type EditorialStructuralAnomaly = {
  anomalyKey: string;
  anomalyType: EditorialStructuralAnomalyType;
  severity: "warning" | "error";
  sourceTabId: string | null;
  tabTitle: string | null;
  chapterNumber: string | null;
  relatedSourceTabIds: string[];
  message: string;
  details: Record<string, unknown>;
};

export type EditorialStructuralTabInput = {
  sourceTabId: string;
  tabOrder: number;
  tabTitle: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
  paragraphs: Array<{
    paragraphKey: string;
    paragraphOrder: number;
    text: string;
  }>;
};

export type EditorialStructuralSummary = {
  tabCount: number;
  expectedTabCount: number | null;
  expectedRangeStart: number | null;
  expectedRangeEnd: number | null;
  parsedChapterCount: number;
  missingChapterNumbers: number[];
  anomalyCount: number;
  blockingAnomalyCount: number;
  counts: Record<EditorialStructuralAnomalyType, number>;
};

const SOURCE_NOTE_RE =
  /(?:หมายเหตุ(?:จาก)?ต้นฉบับ|หมายเหตุต้นฉบับ|ต้นฉบับ(?:เดิม)?(?:ไม่มี|ขาด|เว้น)|หมายเหตุ(?:จาก)?ผู้เขียนต้นฉบับ)/i;
const END_ONLY_RE = /^จบตอน[.!…]*$/i;
const SEPARATOR_RE = /^[_\-=*#~•·.]{3,}$/;
const CHAPTER_HEADING_RE =
  /^(?:บท(?:ที่)?|ตอนที่|chapter)\s*\[?\s*[0-9๐-๙]+(?:\.[0-9๐-๙]+)?(?:\s*(?:[-–—]|\.{2,})\s*[0-9๐-๙]+(?:\.[0-9๐-๙]+)?)?\s*\]?\b/i;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeForShape(value: string) {
  return normalizeEditorialText(value).replace(/\s+/g, " ").trim();
}

function isSeparator(value: string) {
  return SEPARATOR_RE.test(
    normalizeForShape(value)
      .replace(/\s+/g, "")
  );
}

function isChapterHeading(value: string) {
  return CHAPTER_HEADING_RE.test(normalizeForShape(value));
}

function isEndMarker(value: string) {
  return END_ONLY_RE.test(normalizeForShape(value));
}

function isSourceNote(value: string) {
  return SOURCE_NOTE_RE.test(normalizeForShape(value));
}

function parseIntegerChapterNumber(value: string | null | undefined) {
  const match = String(value ?? "").match(/^0*(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseEditorialEpisodeRange(value: string | null | undefined) {
  const match = String(value ?? "")
    .trim()
    .match(/^0*(\d+)\s*[-–—]\s*0*(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end < start ||
    end - start + 1 > 1000
  ) {
    return null;
  }
  return { start, end, count: end - start + 1 };
}

function canonicalDuplicateBody(value: string) {
  return normalizeEditorialText(value)
    .normalize("NFC")
    .toLocaleLowerCase("th")
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, "")
    .replace(/[\s“”"'‘’.,!?…:;：；—–\-_=+*#()\[\]{}<>/\\|•·~]+/g, "");
}

function shingleSet(value: string, size = 5) {
  const normalized = canonicalDuplicateBody(value);
  const out = new Set<string>();
  if (normalized.length < size) {
    if (normalized) out.add(normalized);
    return out;
  }
  for (let index = 0; index <= normalized.length - size; index += 1) {
    out.add(normalized.slice(index, index + size));
  }
  return out;
}

export function editorialDuplicateSimilarity(a: string, b: string) {
  const left = shingleSet(a);
  const right = shingleSet(b);
  if (!left.size || !right.size) {
    return { dice: 0, containment: 0 };
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return {
    dice: (2 * intersection) / (left.size + right.size),
    containment: intersection / Math.min(left.size, right.size),
  };
}

function buildAnomaly(input: Omit<EditorialStructuralAnomaly, "anomalyKey">) {
  return {
    ...input,
    anomalyKey: sha256(
      JSON.stringify({
        version: EDITORIAL_STRUCTURAL_CHECK_VERSION,
        anomalyType: input.anomalyType,
        sourceTabId: input.sourceTabId,
        chapterNumber: input.chapterNumber,
        relatedSourceTabIds: [...input.relatedSourceTabIds].sort(),
        details: input.details,
      })
    ),
  } satisfies EditorialStructuralAnomaly;
}

function bodyForDuplicate(tab: EditorialStructuralTabInput) {
  const body = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder)
    .map(paragraph => normalizeForShape(paragraph.text))
    .filter(Boolean)
    .filter(text => !isSeparator(text))
    .filter(text => !isEndMarker(text))
    .filter(text => !isChapterHeading(text))
    .filter(text => !isSourceNote(text));
  return body.join("\n").trim();
}

function classifyTab(tab: EditorialStructuralTabInput) {
  const meaningful = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder)
    .map(paragraph => normalizeForShape(paragraph.text))
    .filter(Boolean)
    .filter(text => !isSeparator(text));

  const withoutEnd = meaningful.filter(text => !isEndMarker(text));
  const headingRows = withoutEnd.filter(text => isChapterHeading(text));
  const nonHeadingRows = withoutEnd.filter(text => !isChapterHeading(text));
  const sourceNoteRows = nonHeadingRows.filter(text => isSourceNote(text));
  const narrativeRows = nonHeadingRows.filter(text => !isSourceNote(text));
  const titleLooksLikeSourceNote =
    isSourceNote(tab.tabTitle) || isSourceNote(tab.chapterTitle ?? "");

  if (meaningful.length === 0) return "empty_tab" as const;
  if (withoutEnd.length === 0) return "end_only_tab" as const;
  if (titleLooksLikeSourceNote && narrativeRows.length === 0) {
    return "source_note_only" as const;
  }
  if (
    sourceNoteRows.length > 0 &&
    narrativeRows.length === 0 &&
    (headingRows.length > 0 || tab.chapterNumber)
  ) {
    return "source_note_only" as const;
  }
  if (
    headingRows.length > 0 &&
    nonHeadingRows.length === 0
  ) {
    return "heading_only_tab" as const;
  }
  return null;
}

export function evaluateEditorialStructuralAnomalies(input: {
  tabs: readonly EditorialStructuralTabInput[];
  episodeNumber?: string | null;
}) {
  const tabs = [...input.tabs].sort(
    (a, b) => a.tabOrder - b.tabOrder || a.sourceTabId.localeCompare(b.sourceTabId)
  );
  const anomalies: EditorialStructuralAnomaly[] = [];

  for (const tab of tabs) {
    const classification = classifyTab(tab);
    if (!classification) continue;
    const labels: Record<
      "empty_tab" | "end_only_tab" | "heading_only_tab" | "source_note_only",
      string
    > = {
      empty_tab: "แท็บไม่มีเนื้อหา",
      end_only_tab: "แท็บมีเพียง “จบตอน” ไม่มีเนื้อเรื่อง",
      heading_only_tab: "แท็บมีเพียงชื่อบท ไม่มีเนื้อเรื่อง",
      source_note_only: "แท็บเป็นหมายเหตุจากต้นฉบับ ไม่ใช่เนื้อเรื่อง",
    };
    anomalies.push(
      buildAnomaly({
        anomalyType: classification,
        severity: "error",
        sourceTabId: tab.sourceTabId,
        tabTitle: tab.tabTitle,
        chapterNumber: tab.chapterNumber,
        relatedSourceTabIds: [],
        message: labels[classification],
        details: {
          tabOrder: tab.tabOrder,
          paragraphCount: tab.paragraphs.length,
        },
      })
    );
  }

  const range = parseEditorialEpisodeRange(input.episodeNumber);
  const parsedChapterRows = tabs
    .map(tab => ({
      tab,
      chapter: parseIntegerChapterNumber(tab.chapterNumber),
    }))
    .filter(
      (row): row is { tab: EditorialStructuralTabInput; chapter: number } =>
        row.chapter !== null
    );

  const chapterToTabs = new Map<number, EditorialStructuralTabInput[]>();
  for (const row of parsedChapterRows) {
    const bucket = chapterToTabs.get(row.chapter) ?? [];
    bucket.push(row.tab);
    chapterToTabs.set(row.chapter, bucket);
  }

  for (const [chapter, duplicates] of chapterToTabs.entries()) {
    if (duplicates.length <= 1) continue;
    anomalies.push(
      buildAnomaly({
        anomalyType: "duplicate_chapter_number",
        severity: "error",
        sourceTabId: duplicates[0]!.sourceTabId,
        tabTitle: duplicates[0]!.tabTitle,
        chapterNumber: String(chapter),
        relatedSourceTabIds: duplicates.slice(1).map(tab => tab.sourceTabId),
        message: `เลขบท ${chapter} ซ้ำใน ${duplicates.length} แท็บ`,
        details: {
          chapter,
          tabOrders: duplicates.map(tab => tab.tabOrder),
        },
      })
    );
  }

  const missingChapterNumbers: number[] = [];
  if (range) {
    for (let chapter = range.start; chapter <= range.end; chapter += 1) {
      if (!chapterToTabs.has(chapter)) missingChapterNumbers.push(chapter);
    }
    if (tabs.length !== range.count) {
      anomalies.push(
        buildAnomaly({
          anomalyType: "tab_count_mismatch",
          severity: "error",
          sourceTabId: null,
          tabTitle: null,
          chapterNumber: null,
          relatedSourceTabIds: [],
          message: `จำนวนแท็บ ${tabs.length} ไม่ตรงช่วงตอน ${input.episodeNumber} ที่ควรมี ${range.count} แท็บ`,
          details: {
            actualTabCount: tabs.length,
            expectedTabCount: range.count,
            rangeStart: range.start,
            rangeEnd: range.end,
          },
        })
      );
    }
    for (const chapter of missingChapterNumbers) {
      anomalies.push(
        buildAnomaly({
          anomalyType: "missing_expected_chapter",
          severity: "error",
          sourceTabId: null,
          tabTitle: null,
          chapterNumber: String(chapter),
          relatedSourceTabIds: [],
          message: `ไม่พบหัวข้อบทที่ ${chapter} ใน Episode Pack`,
          details: { chapter },
        })
      );
    }
  }

  const candidates = tabs
    .map(tab => ({ tab, body: bodyForDuplicate(tab) }))
    .map(row => ({
      ...row,
      canonical: canonicalDuplicateBody(row.body),
    }))
    .filter(row => row.canonical.length >= 500);

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const right = candidates[rightIndex]!;
      const leftChapter = parseIntegerChapterNumber(left.tab.chapterNumber);
      const rightChapter = parseIntegerChapterNumber(right.tab.chapterNumber);
      if (
        leftChapter !== null &&
        rightChapter !== null &&
        leftChapter === rightChapter
      ) {
        continue;
      }

      if (left.canonical === right.canonical) {
        anomalies.push(
          buildAnomaly({
            anomalyType: "duplicate_content_exact",
            severity: "error",
            sourceTabId: left.tab.sourceTabId,
            tabTitle: left.tab.tabTitle,
            chapterNumber: left.tab.chapterNumber,
            relatedSourceTabIds: [right.tab.sourceTabId],
            message: `เนื้อหาซ้ำกันทั้งบท: ${left.tab.chapterNumber ?? left.tab.tabTitle} ↔ ${right.tab.chapterNumber ?? right.tab.tabTitle}`,
            details: {
              leftTabOrder: left.tab.tabOrder,
              rightTabOrder: right.tab.tabOrder,
              leftChapterNumber: left.tab.chapterNumber,
              rightChapterNumber: right.tab.chapterNumber,
              contentSha256: sha256(left.canonical),
              dice: 1,
              containment: 1,
            },
          })
        );
        continue;
      }

      const similarity = editorialDuplicateSimilarity(left.body, right.body);
      if (similarity.dice >= 0.92 || similarity.containment >= 0.95) {
        anomalies.push(
          buildAnomaly({
            anomalyType: "duplicate_content_near",
            severity: "warning",
            sourceTabId: left.tab.sourceTabId,
            tabTitle: left.tab.tabTitle,
            chapterNumber: left.tab.chapterNumber,
            relatedSourceTabIds: [right.tab.sourceTabId],
            message: `เนื้อหาคล้ายซ้ำสูง: ${left.tab.chapterNumber ?? left.tab.tabTitle} ↔ ${right.tab.chapterNumber ?? right.tab.tabTitle}`,
            details: {
              leftTabOrder: left.tab.tabOrder,
              rightTabOrder: right.tab.tabOrder,
              leftChapterNumber: left.tab.chapterNumber,
              rightChapterNumber: right.tab.chapterNumber,
              dice: Number(similarity.dice.toFixed(4)),
              containment: Number(similarity.containment.toFixed(4)),
            },
          })
        );
      }
    }
  }

  const counts = {
    empty_tab: 0,
    end_only_tab: 0,
    heading_only_tab: 0,
    source_note_only: 0,
    missing_expected_chapter: 0,
    duplicate_chapter_number: 0,
    tab_count_mismatch: 0,
    duplicate_content_exact: 0,
    duplicate_content_near: 0,
  } satisfies Record<EditorialStructuralAnomalyType, number>;
  for (const anomaly of anomalies) counts[anomaly.anomalyType] += 1;

  const summary: EditorialStructuralSummary = {
    tabCount: tabs.length,
    expectedTabCount: range?.count ?? null,
    expectedRangeStart: range?.start ?? null,
    expectedRangeEnd: range?.end ?? null,
    parsedChapterCount: chapterToTabs.size,
    missingChapterNumbers,
    anomalyCount: anomalies.length,
    blockingAnomalyCount: anomalies.filter(
      anomaly => anomaly.severity === "error"
    ).length,
    counts,
  };

  return { summary, anomalies };
}
