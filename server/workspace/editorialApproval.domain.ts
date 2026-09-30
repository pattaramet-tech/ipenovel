import { createHash } from "node:crypto";

import { classifyEditorialChapterNumber } from "./editorialIdentityContract.domain";

export const EDITORIAL_APPROVAL_CONTRACT =
  "workspace-editorial-approval-v1" as const;
export const EDITORIAL_EPISODE_STAGE_CONTRACT =
  "workspace-editorial-episode-stage-v1" as const;
export const EDITORIAL_EPISODE_STAGE_CONTRACT_V2 =
  "workspace-editorial-episode-stage-v2" as const;
export const EDITORIAL_EPISODE_STAGE_CONTRACT_V3 =
  "workspace-editorial-episode-stage-v3" as const;

export type EditorialEpisodeDraftInput = {
  workItemType: "new_story" | "new_episode";
  episodeNumber: string | null;
  episodeTitle: string | null;
  /** Explicitly confirmed structural source-note tabs that may stage as title-only Episodes. */
  confirmedSourceNoteTabIds?: string[];
  tabs: Array<{
    sourceTabId: string;
    tabOrder: number;
    title: string;
    chapterNumber: string | null;
    chapterTitle: string | null;
    paragraphs: Array<{
      paragraphOrder: number;
      text: string;
    }>;
  }>;
};

export type EditorialEpisodeDraftPlan = {
  episodeNumber: string;
  title: string;
  content: string;
  contentFormat: "plain_text";
  wordCount: number;
  sourceTabId: string;
  sourceTabTitle: string;
  sourceTitleLine: string;
  contentSha256: string;
};

export type EditorialEpisodePackPlan = EditorialEpisodeDraftPlan & {
  saleMode: "package";
  billableTabCount: number;
  excludedTabCount: number;
  price: string;
  isFree: boolean;
  memberEpisodeNumbers: string[];
};

/** Workspace Docs commerce policy: one included content tab = ฿2 of the pack price. */
export const EDITORIAL_EPISODE_PACK_PRICE_PER_TAB_BAHT = 2;

export class EditorialApprovalDomainError extends Error {
  constructor(
    readonly code:
      | "WORK_ITEM_NOT_EPISODE"
      | "EPISODE_NUMBER_REQUIRED"
      | "DRAFT_STRUCTURE_AMBIGUOUS"
      | "TITLE_REQUIRED"
      | "CONTENT_REQUIRED"
      | "EPISODE_NUMBER_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "EditorialApprovalDomainError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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

export function normalizeEditorialEpisodeNumber(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[๐-๙]/g, char => THAI_DIGITS[char] ?? char)
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseEditorialEpisodeHeading(value: string) {
  const text = String(value || "")
    .normalize("NFKC")
    .trim();
  if (!text) return null;
  const normalizedDigits = text.replace(
    /[๐-๙]/g,
    char => THAI_DIGITS[char] ?? char
  );
  const match = normalizedDigits.match(
    /^(?:#\s*|บท(?:ที่)?\s*|ตอน(?:ที่)?\s*|chapters?\s*|ch\.?\s*|episodes?\s*|ep\.?\s*)([0-9]+(?:\s*[-–—]\s*[0-9]+)?)\s*(?:[:：.\-]\s*)?(.*)$/i
  );
  if (!match) return null;
  return {
    episodeNumber: normalizeEditorialEpisodeNumber(match[1]),
    titleRemainder: String(match[2] || "").trim(),
  };
}

function countWords(content: string) {
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
}

function episodeNumbersEquivalent(a: string, b: string) {
  const left = normalizeEditorialEpisodeNumber(a);
  const right = normalizeEditorialEpisodeNumber(b);
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) === Number(right);
  }
  return left === right;
}

export type EditorialEpisodeDraftExcludedTab = {
  sourceTabId: string;
  sourceTabTitle: string;
  tabOrder: number;
  kind: "front_matter";
  label: string;
};

export type EditorialEpisodeDraftBatchAnomaly = {
  code:
    | "COUNT_MISMATCH"
    | "TAB_NUMBER_MISSING"
    | "TAB_NUMBER_CONFLICT"
    | "RANGE_USED_AS_CHAPTER_IDENTITY"
    | "TAB_NUMBER_DUPLICATE"
    | "TAB_NUMBER_OUT_OF_RANGE"
    | "TAB_NUMBER_OUT_OF_ORDER"
    | "EXPECTED_EPISODE_MISSING"
    | "TAB_EMPTY"
    | "TAB_CONTENT_INVALID"
    | "TAB_CONTENT_SHORT";
  severity: "blocker" | "warning";
  message: string;
  sourceTabId?: string;
  sourceTabTitle?: string;
  episodeNumber?: string;
};

/** One chapter-identity claim observed on a tab, with its evidence source. */
export type EditorialTabChapterIdentityCandidate = {
  source: "heading" | "tab_metadata" | "tab_title";
  rawValue: string;
  /** Canonical single episode number, or null when not a pure single integer. */
  canonical: string | null;
  /** True when the raw value is range-shaped (canonical or not) per the contract. */
  rangeShaped: boolean;
};

/**
 * Deterministic chapter-identity resolution for one tab (IPE-058-B).
 *
 * Selection happens ONLY when every OBSERVED identity claim (a source that
 * actually carries a non-empty value) agrees after canonicalization:
 * - any range-shaped claim (canonical or non-canonical form) forbids
 *   selecting a canonical single chapter number — downstream must fail
 *   closed with RANGE_USED_AS_CHAPTER_IDENTITY;
 * - any observed claim that cannot canonicalize (e.g. unreadable metadata)
 *   forbids selection — it is never silently discarded in favour of another
 *   candidate (fail closed via TAB_NUMBER_MISSING with evidence);
 * - two or more distinct canonical claims are a conflict (fail closed via
 *   TAB_NUMBER_CONFLICT);
 * - absent sources (null / empty) are NOT claims and never cause conflict.
 */
export function resolveEditorialTabChapterIdentity(input: {
  headingRawValue: string | null;
  metadataRawValue: string | null;
  titleRawValue: string | null;
  width: number;
}): {
  candidates: EditorialTabChapterIdentityCandidate[];
  canonicalEpisodeNumber: string | null;
  conflict: boolean;
  rangeShaped: boolean;
  /** True when an observed claim cannot canonicalize and is not range-shaped. */
  unresolvable: boolean;
} {
  const rawCandidates: Array<{
    source: EditorialTabChapterIdentityCandidate["source"];
    rawValue: string | null;
  }> = [
    { source: "heading", rawValue: input.headingRawValue },
    { source: "tab_metadata", rawValue: input.metadataRawValue },
    { source: "tab_title", rawValue: input.titleRawValue },
  ];
  const candidates: EditorialTabChapterIdentityCandidate[] = [];
  for (const { source, rawValue } of rawCandidates) {
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    const classified = classifyEditorialChapterNumber(value);
    let canonical: string | null = null;
    if (
      classified.kind === "single" &&
      /^\d+$/.test(classified.singleNumber ?? "")
    ) {
      const padded = String(Number(classified.singleNumber)).padStart(
        input.width,
        "0"
      );
      // Preserve the legacy width guard: overflow beyond the pack width is
      // out of canonical scope and canonicalizes to null (fail closed).
      canonical = padded.length > input.width ? null : padded;
    }
    candidates.push({
      source,
      rawValue: value,
      canonical,
      rangeShaped: classified.rangeShaped,
    });
  }
  const unique = Array.from(
    new Set(candidates.map(candidate => candidate.canonical).filter(Boolean))
  ) as string[];
  const rangeShaped = candidates.some(candidate => candidate.rangeShaped);
  const unresolvable = candidates.some(
    candidate => candidate.canonical === null && !candidate.rangeShaped
  );
  const conflict = unique.length > 1;
  return {
    candidates,
    // Canonical selection requires ALL observed claims to agree as canonical
    // singles: no conflict, no range-shaped claim, no unresolvable claim.
    canonicalEpisodeNumber:
      candidates.length > 0 && !conflict && !rangeShaped && !unresolvable
        ? unique[0]
        : null,
    conflict,
    rangeShaped,
    unresolvable,
  };
}

/**
 * Deterministic Episode-Pack coverage reconciliation (IPE-058-B). Answers
 * "which episodes are missing/duplicated/out-of-range and which tabs are
 * unreadable" instead of a bare tabCount vs expectedCount comparison —
 * equal counts with wrong identities (expected 1,2,3 vs detected 1,1,3)
 * must still block.
 */
export type EditorialEpisodePackReconciliation = {
  expectedCount: number;
  mappedCount: number;
  expectedEpisodeNumbers: string[];
  mappedEpisodeNumbers: string[];
  missingEpisodeNumbers: string[];
  duplicateEpisodeNumbers: string[];
  outOfRangeEpisodeNumbers: string[];
  unreadableTabs: Array<{
    sourceTabId: string;
    sourceTabTitle: string;
    tabOrder: number;
    code: EditorialEpisodeDraftBatchAnomaly["code"];
  }>;
  excludedTabs: EditorialEpisodeDraftExcludedTab[];
  identityConflicts: Array<{
    sourceTabId: string;
    sourceTabTitle: string;
    candidates: EditorialTabChapterIdentityCandidate[];
  }>;
  ready: boolean;
};

function emptyReconciliation(): EditorialEpisodePackReconciliation {
  return {
    expectedCount: 0,
    mappedCount: 0,
    expectedEpisodeNumbers: [],
    mappedEpisodeNumbers: [],
    missingEpisodeNumbers: [],
    duplicateEpisodeNumbers: [],
    outOfRangeEpisodeNumbers: [],
    unreadableTabs: [],
    excludedTabs: [],
    identityConflicts: [],
    ready: false,
  };
}

export type EditorialEpisodeDraftBatchPlan = {
  mode: "single" | "range";
  requestedEpisodeNumber: string;
  expectedEpisodeNumbers: string[];
  nonBillableSourceTabIds: string[];
  items: EditorialEpisodeDraftPlan[];
  excludedTabs: EditorialEpisodeDraftExcludedTab[];
  anomalies: EditorialEpisodeDraftBatchAnomaly[];
  blockers: EditorialEpisodeDraftBatchAnomaly[];
  /** Deterministic coverage reconciliation (see EditorialEpisodePackReconciliation). */
  reconciliation: EditorialEpisodePackReconciliation;
  ready: boolean;
};

export function parseEditorialEpisodeRange(value: string) {
  const normalized = normalizeEditorialEpisodeNumber(value);
  const match = normalized.match(/^(\d+)\s+-\s+(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > 500
  ) {
    return null;
  }
  const width = Math.max(match[1].length, match[2].length);
  const episodeNumbers = Array.from(
    { length: end - start + 1 },
    (_, index) => String(start + index).padStart(width, "0")
  );
  return { start, end, width, episodeNumbers };
}

export function defaultEditorialEpisodePackSale(
  episodeNumber: string,
  billableTabCount: number
) {
  const normalized = normalizeEditorialEpisodeNumber(episodeNumber);
  const range = parseEditorialEpisodeRange(normalized);
  const firstEpisodeNumber = range?.episodeNumbers[0] ?? normalized;
  const count = Math.max(0, Math.floor(billableTabCount));
  const isFree = firstEpisodeNumber === "001" || count === 0;
  return {
    saleMode: "package" as const,
    price: isFree
      ? "0.00"
      : (count * EDITORIAL_EPISODE_PACK_PRICE_PER_TAB_BAHT).toFixed(2),
    isFree,
  };
}

export function defaultEditorialEpisodePackSaleFromRange(episodeNumber: string) {
  const normalized = normalizeEditorialEpisodeNumber(episodeNumber);
  const range = parseEditorialEpisodeRange(normalized);
  const count = range?.episodeNumbers.length ?? (normalized ? 1 : 0);
  return defaultEditorialEpisodePackSale(normalized, count);
}

function tabDetectedEpisodeNumber(
  tab: EditorialEpisodeDraftInput["tabs"][number],
  width: number
) {
  const paragraphs = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder);
  const firstLine = paragraphs.find(row => String(row.text || "").trim());
  const heading = firstLine
    ? parseEditorialEpisodeHeading(String(firstLine.text || "").trim())
    : null;
  const titleHeading = parseEditorialEpisodeHeading(tab.title);
  const resolved = resolveEditorialTabChapterIdentity({
    headingRawValue: heading?.episodeNumber ?? null,
    metadataRawValue: tab.chapterNumber ?? null,
    titleRawValue: titleHeading?.episodeNumber ?? null,
    width,
  });
  return {
    firstLine: firstLine ? String(firstLine.text || "").trim() : "",
    candidates: resolved.candidates
      .map(candidate => candidate.canonical)
      .filter((value): value is string => Boolean(value)),
    episodeNumber: resolved.canonicalEpisodeNumber,
    conflict: resolved.conflict,
    identityCandidates: resolved.candidates,
    rangeShaped: resolved.rangeShaped,
  };
}

const SOURCE_NOTE_LABELS = [
  ["หมายเหตุจากต้นฉบับ", "หมายเหตุจากต้นฉบับ"],
  ["ประกาศจากต้นฉบับ", "ประกาศจากต้นฉบับ"],
] as const;

const FRONT_MATTER_LABELS = [
  ["บทนำ", "บทนำ"],
  ["คำนำ", "คำนำ"],
  ["prologue", "Prologue"],
  ["introduction", "Introduction"],
  ...SOURCE_NOTE_LABELS,
] as const;

function normalizedFrontMatterLabel(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[\s:：.\-–—]+$/g, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

const NORMALIZED_FRONT_MATTER_LABELS = new Map(
  FRONT_MATTER_LABELS.map(([key, label]) => [
    normalizedFrontMatterLabel(key),
    label,
  ])
);

const NORMALIZED_SOURCE_NOTE_LABELS = new Map(
  SOURCE_NOTE_LABELS.map(([key, label]) => [
    normalizedFrontMatterLabel(key),
    label,
  ])
);

function detectedCurrentSourceNoteTab(
  tab: EditorialEpisodeDraftInput["tabs"][number]
): EditorialEpisodeDraftExcludedTab | null {
  const paragraphs = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder);
  const firstLine = paragraphs.find(row => String(row.text || "").trim());
  const normalized = normalizedFrontMatterLabel(
    firstLine ? String(firstLine.text || "") : ""
  );
  const label = NORMALIZED_SOURCE_NOTE_LABELS.get(normalized);
  return label
    ? {
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        kind: "front_matter",
        label,
      }
    : null;
}

function detectedFrontMatterTab(
  tab: EditorialEpisodeDraftInput["tabs"][number]
): EditorialEpisodeDraftExcludedTab | null {
  const paragraphs = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder);
  const firstLine = paragraphs.find(row => String(row.text || "").trim());
  const candidates = [
    tab.chapterTitle ?? "",
    tab.title,
    firstLine ? String(firstLine.text || "") : "",
  ];
  for (const candidate of candidates) {
    const normalized = normalizedFrontMatterLabel(candidate);
    const label = NORMALIZED_FRONT_MATTER_LABELS.get(normalized);
    if (label) {
      return {
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        kind: "front_matter",
        label,
      };
    }
  }
  return null;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}

export function analyzeEditorialEpisodeDraftBatch(
  input: EditorialEpisodeDraftInput
): EditorialEpisodeDraftBatchPlan {
  const requestedEpisodeNumber = normalizeEditorialEpisodeNumber(
    input.episodeNumber ?? ""
  );
  const range = parseEditorialEpisodeRange(requestedEpisodeNumber);
  if (!range) {
    try {
      const plan = buildEditorialEpisodeDraftPlan(input);
      return {
        mode: "single",
        requestedEpisodeNumber,
        expectedEpisodeNumbers: [plan.episodeNumber],
        nonBillableSourceTabIds: (input.confirmedSourceNoteTabIds ?? []).includes(plan.sourceTabId)
          ? [plan.sourceTabId]
          : [],
        items: [plan],
        excludedTabs: [],
        anomalies: [],
        blockers: [],
        reconciliation: {
          expectedCount: 1,
          mappedCount: 1,
          expectedEpisodeNumbers: [plan.episodeNumber],
          mappedEpisodeNumbers: [plan.episodeNumber],
          missingEpisodeNumbers: [],
          duplicateEpisodeNumbers: [],
          outOfRangeEpisodeNumbers: [],
          unreadableTabs: [],
          excludedTabs: [],
          identityConflicts: [],
          ready: true,
        },
        ready: true,
      };
    } catch (error) {
      const message =
        error instanceof EditorialApprovalDomainError
          ? error.message
          : "Episode staging plan could not be derived.";
      const anomaly: EditorialEpisodeDraftBatchAnomaly = {
        code:
          input.tabs.length === 0
            ? "TAB_EMPTY"
            : input.tabs.length !== 1
              ? "COUNT_MISMATCH"
              : "TAB_CONTENT_INVALID",
        severity: "blocker",
        message,
      };
      return {
        mode: "single",
        requestedEpisodeNumber,
        expectedEpisodeNumbers: requestedEpisodeNumber
          ? [requestedEpisodeNumber]
          : [],
        nonBillableSourceTabIds: [],
        items: [],
        excludedTabs: [],
        anomalies: [anomaly],
        blockers: [anomaly],
        reconciliation: {
          ...emptyReconciliation(),
          expectedEpisodeNumbers: requestedEpisodeNumber
            ? [requestedEpisodeNumber]
            : [],
          expectedCount: requestedEpisodeNumber ? 1 : 0,
          ready: false,
        },
        ready: false,
      };
    }
  }

  const expected = range.episodeNumbers;
  const expectedSet = new Set(expected);
  const tabs = input.tabs.slice().sort((a, b) => a.tabOrder - b.tabOrder);
  const confirmedSourceNoteTabIds = new Set(input.confirmedSourceNoteTabIds ?? []);
  const anomalies: EditorialEpisodeDraftBatchAnomaly[] = [];
  const excludedTabs: EditorialEpisodeDraftExcludedTab[] = [];
  const detectedRows: Array<{
    tab: EditorialEpisodeDraftInput["tabs"][number];
    episodeNumber: string;
  }> = [];
  const identityConflicts: EditorialEpisodePackReconciliation["identityConflicts"] = [];
  const unreadableTabs: EditorialEpisodePackReconciliation["unreadableTabs"] = [];

  for (const tab of tabs) {
    const detected = tabDetectedEpisodeNumber(tab, range.width);
    const currentSourceNote = detectedCurrentSourceNoteTab(tab);
    if (currentSourceNote) {
      excludedTabs.push(currentSourceNote);
      continue;
    }
    const frontMatter = detectedFrontMatterTab(tab);
    if (
      frontMatter &&
      !detected.conflict &&
      (!detected.episodeNumber || !expectedSet.has(detected.episodeNumber))
    ) {
      excludedTabs.push(frontMatter);
      continue;
    }
    if (!detected.firstLine) {
      anomalies.push({
        code: "TAB_EMPTY",
        severity: "blocker",
        message: `${tab.title} ไม่มีเนื้อหา`,
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
      });
      unreadableTabs.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        code: "TAB_EMPTY",
      });
      continue;
    }
    if (detected.conflict) {
      anomalies.push({
        code: "TAB_NUMBER_CONFLICT",
        severity: "blocker",
        message: `${tab.title} มีเลขตอนขัดแย้งกัน: ${detected.candidates.join(", ")}`,
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
      });
      identityConflicts.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        candidates: detected.identityCandidates,
      });
      unreadableTabs.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        code: "TAB_NUMBER_CONFLICT",
      });
      continue;
    }
    if (detected.rangeShaped) {
      // Range-shaped metadata in a chapter-identity position: a pack range or
      // non-canonical range display string must never become the canonical
      // single chapter number — even when another source carries a valid
      // single number. Fail closed with actionable evidence.
      const rangeShapedValues = detected.identityCandidates
        .filter(candidate => candidate.rangeShaped)
        .map(candidate => `${candidate.source}="${candidate.rawValue}"`)
        .join(", ");
      anomalies.push({
        code: "RANGE_USED_AS_CHAPTER_IDENTITY",
        severity: "blocker",
        message: `${tab.title} ใช้ช่วงตอน (${rangeShapedValues}) แทนเลขตอนจริงของบท — ต้องแยก identity ระดับแพ็กออกจากเลขตอนรายบท`,
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
      });
      identityConflicts.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        candidates: detected.identityCandidates,
      });
      unreadableTabs.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        code: "RANGE_USED_AS_CHAPTER_IDENTITY",
      });
      continue;
    }
    if (!detected.episodeNumber) {
      anomalies.push({
        code: "TAB_NUMBER_MISSING",
        severity: "blocker",
        message: `${tab.title} อ่านเลขตอนไม่ได้จากหัวบท/chapter metadata`,
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
      });
      identityConflicts.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        candidates: detected.identityCandidates,
      });
      unreadableTabs.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        code: "TAB_NUMBER_MISSING",
      });
      continue;
    }
    if (!expectedSet.has(detected.episodeNumber)) {
      anomalies.push({
        code: "TAB_NUMBER_OUT_OF_RANGE",
        severity: "blocker",
        message: `${tab.title} ระบุตอน ${detected.episodeNumber} ซึ่งอยู่นอกช่วง ${requestedEpisodeNumber}`,
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        episodeNumber: detected.episodeNumber,
      });
      unreadableTabs.push({
        sourceTabId: tab.sourceTabId,
        sourceTabTitle: tab.title,
        tabOrder: tab.tabOrder,
        code: "TAB_NUMBER_OUT_OF_RANGE",
      });
      continue;
    }
    detectedRows.push({ tab, episodeNumber: detected.episodeNumber });
  }

  const episodeTabCount = tabs.length - excludedTabs.length;
  if (episodeTabCount !== expected.length) {
    anomalies.push({
      code: "COUNT_MISMATCH",
      severity: "blocker",
      message:
        excludedTabs.length > 0
          ? `ช่วงตอน ${requestedEpisodeNumber} ต้องมี ${expected.length} แท็บ Episode แต่ Draft มี ${tabs.length} แท็บ โดยไม่นับ front matter ${excludedTabs.length} แท็บ เหลือ ${episodeTabCount} แท็บ Episode`
          : `ช่วงตอน ${requestedEpisodeNumber} ต้องมี ${expected.length} แท็บ แต่ Draft มี ${tabs.length} แท็บ`,
    });
  }

  const seen = new Map<string, number>();
  for (const row of detectedRows) {
    seen.set(row.episodeNumber, (seen.get(row.episodeNumber) ?? 0) + 1);
  }
  for (const [episodeNumber, count] of Array.from(seen.entries())) {
    if (count > 1) {
      anomalies.push({
        code: "TAB_NUMBER_DUPLICATE",
        severity: "blocker",
        message: `พบเลขตอน ${episodeNumber} ซ้ำ ${count} แท็บ`,
        episodeNumber,
      });
    }
  }
  for (const episodeNumber of expected) {
    if (!seen.has(episodeNumber)) {
      anomalies.push({
        code: "EXPECTED_EPISODE_MISSING",
        severity: "blocker",
        message: `ไม่พบแท็บสำหรับตอน ${episodeNumber}`,
        episodeNumber,
      });
    }
  }

  const detectedOrder = detectedRows.map(row => row.episodeNumber);
  if (
    detectedRows.length === expected.length &&
    new Set(detectedOrder).size === expected.length &&
    detectedOrder.some((value, index) => value !== expected[index])
  ) {
    anomalies.push({
      code: "TAB_NUMBER_OUT_OF_ORDER",
      severity: "warning",
      message: "เลขตอนในแท็บไม่เรียงตามลำดับ แต่ระบบจะ map ตามเลขตอนจริง",
    });
  }

  const duplicated = new Set(
    Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([episodeNumber]) => episodeNumber)
  );
  const items: EditorialEpisodeDraftPlan[] = [];
  for (const row of detectedRows) {
    if (duplicated.has(row.episodeNumber)) continue;
    try {
      items.push(
        buildEditorialEpisodeDraftPlan({
          workItemType: "new_episode",
          episodeNumber: row.episodeNumber,
          episodeTitle: null,
          confirmedSourceNoteTabIds: confirmedSourceNoteTabIds.has(row.tab.sourceTabId)
            ? [row.tab.sourceTabId]
            : [],
          tabs: [row.tab],
        })
      );
    } catch (error) {
      anomalies.push({
        code: "TAB_CONTENT_INVALID",
        severity: "blocker",
        message:
          error instanceof EditorialApprovalDomainError
            ? `${row.tab.title}: ${error.message}`
            : `${row.tab.title}: เนื้อหาไม่สามารถ stage ได้`,
        sourceTabId: row.tab.sourceTabId,
        sourceTabTitle: row.tab.title,
        episodeNumber: row.episodeNumber,
      });
    }
  }

  const lengths = items.map(item => item.content.length).filter(length => length > 0);
  const medianCharacters = median(lengths);
  const shortThreshold =
    medianCharacters >= 400
      ? Math.max(120, Math.floor(medianCharacters * 0.25))
      : 80;
  for (const item of items) {
    if (
      !confirmedSourceNoteTabIds.has(item.sourceTabId) &&
      item.content.length < shortThreshold
    ) {
      anomalies.push({
        code: "TAB_CONTENT_SHORT",
        severity: "warning",
        message: `ตอน ${item.episodeNumber} มีเนื้อหา ${item.content.length} ตัวอักษร ซึ่งสั้นผิดปกติเมื่อเทียบกับชุดนี้`,
        sourceTabId: item.sourceTabId,
        sourceTabTitle: item.sourceTabTitle,
        episodeNumber: item.episodeNumber,
      });
    }
  }

  const blockers = anomalies.filter(anomaly => anomaly.severity === "blocker");
  const expectedIndex = new Map(
    expected.map((episodeNumber, index) => [episodeNumber, index] as const)
  );
  items.sort(
    (a, b) =>
      (expectedIndex.get(a.episodeNumber) ?? Number.MAX_SAFE_INTEGER) -
      (expectedIndex.get(b.episodeNumber) ?? Number.MAX_SAFE_INTEGER)
  );
  const ready =
    blockers.length === 0 &&
    items.length === expected.length &&
    items.every((item, index) => item.episodeNumber === expected[index]);

  const mappedEpisodeNumbers = detectedRows.map(row => row.episodeNumber);
  const duplicateEpisodeNumbers = Array.from(seen.entries())
    .filter(([, count]) => count > 1)
    .map(([episodeNumber]) => episodeNumber);
  const missingEpisodeNumbers = expected.filter(
    episodeNumber => !seen.has(episodeNumber)
  );
  const outOfRangeEpisodeNumbers = anomalies
    .filter(anomaly => anomaly.code === "TAB_NUMBER_OUT_OF_RANGE")
    .map(anomaly => anomaly.episodeNumber)
    .filter((episodeNumber): episodeNumber is string => Boolean(episodeNumber));

  return {
    mode: "range",
    requestedEpisodeNumber,
    expectedEpisodeNumbers: expected,
    nonBillableSourceTabIds: items
      .filter(item => confirmedSourceNoteTabIds.has(item.sourceTabId))
      .map(item => item.sourceTabId),
    items,
    excludedTabs,
    anomalies,
    blockers,
    reconciliation: {
      expectedCount: expected.length,
      mappedCount: mappedEpisodeNumbers.length,
      expectedEpisodeNumbers: expected,
      mappedEpisodeNumbers,
      missingEpisodeNumbers,
      duplicateEpisodeNumbers,
      outOfRangeEpisodeNumbers,
      unreadableTabs,
      excludedTabs,
      identityConflicts,
      ready,
    },
    ready,
  };
}

export function buildEditorialEpisodePackPlan(
  batch: EditorialEpisodeDraftBatchPlan
): EditorialEpisodePackPlan {
  if (!batch.ready || batch.items.length === 0) {
    throw new EditorialApprovalDomainError(
      "DRAFT_STRUCTURE_AMBIGUOUS",
      "Episode Pack requires a ready Draft batch with at least one billable content tab."
    );
  }
  const items = batch.items;
  const first = items[0];
  const last = items[items.length - 1];
  const episodeNumber = items.length === 1
    ? first.episodeNumber
    : `${first.episodeNumber} - ${last.episodeNumber}`;
  // Preserve each source heading in the package blob so ReaderPage's existing
  // package TOC parser can expose every chapter after one package purchase.
  const content = items
    .map(item => `${item.sourceTitleLine}\n\n${item.content}`.trim())
    .join("\n\n");
  const nonBillable = new Set(batch.nonBillableSourceTabIds);
  const billableTabCount = items.filter(item => !nonBillable.has(item.sourceTabId)).length;
  const defaultSale = defaultEditorialEpisodePackSale(
    batch.requestedEpisodeNumber,
    billableTabCount
  );
  return {
    episodeNumber,
    title: items.length === 1
      ? first.title
      : `แพ็กตอน ${first.episodeNumber} - ${last.episodeNumber}`,
    content,
    contentFormat: "plain_text",
    wordCount: countWords(content),
    sourceTabId: first.sourceTabId,
    sourceTabTitle: first.sourceTabTitle,
    sourceTitleLine: first.sourceTitleLine,
    contentSha256: sha256(content),
    saleMode: defaultSale.saleMode,
    billableTabCount,
    excludedTabCount: batch.excludedTabs.length,
    price: defaultSale.price,
    isFree: defaultSale.isFree,
    memberEpisodeNumbers: items.map(item => item.episodeNumber),
  };
}

export function buildEditorialEpisodeDraftPlan(
  input: EditorialEpisodeDraftInput
): EditorialEpisodeDraftPlan {
  if (input.workItemType !== "new_episode") {
    throw new EditorialApprovalDomainError(
      "WORK_ITEM_NOT_EPISODE",
      "Episode staging requires a NEW_EPISODE work item."
    );
  }
  const episodeNumber = normalizeEditorialEpisodeNumber(
    input.episodeNumber ?? ""
  );
  if (!episodeNumber) {
    throw new EditorialApprovalDomainError(
      "EPISODE_NUMBER_REQUIRED",
      "Episode staging requires an episode number."
    );
  }

  const tabs = input.tabs.slice().sort((a, b) => a.tabOrder - b.tabOrder);
  if (tabs.length !== 1) {
    throw new EditorialApprovalDomainError(
      "DRAFT_STRUCTURE_AMBIGUOUS",
      "A NEW_EPISODE work item must resolve to exactly one Draft tab before staging."
    );
  }
  const tab = tabs[0];
  const paragraphs = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder);
  const titleIndex = paragraphs.findIndex(row => String(row.text || "").trim());
  if (titleIndex < 0) {
    throw new EditorialApprovalDomainError(
      "TITLE_REQUIRED",
      "Draft has no non-empty title line."
    );
  }
  const sourceTitleLine = String(paragraphs[titleIndex].text || "").trim();
  const parsedHeading = parseEditorialEpisodeHeading(sourceTitleLine);
  const chapterNumber = normalizeEditorialEpisodeNumber(
    tab.chapterNumber ?? ""
  );
  const detectedNumber = parsedHeading?.episodeNumber || chapterNumber || null;
  if (
    detectedNumber &&
    !episodeNumbersEquivalent(detectedNumber, episodeNumber)
  ) {
    throw new EditorialApprovalDomainError(
      "EPISODE_NUMBER_CONFLICT",
      `Draft heading episode number ${detectedNumber} does not match work item episode number ${episodeNumber}.`
    );
  }

  const explicitTitle = String(input.episodeTitle || "").trim();
  const parsedTitle = String(
    parsedHeading?.titleRemainder || tab.chapterTitle || ""
  ).trim();
  // Production package export treats the first non-empty line as the title.
  // Preserve that behavior when intake metadata did not provide an explicit title.
  const title = explicitTitle || sourceTitleLine || parsedTitle;
  if (!title) {
    throw new EditorialApprovalDomainError(
      "TITLE_REQUIRED",
      "Episode title could not be resolved."
    );
  }

  const content = paragraphs
    .slice(titleIndex + 1)
    .map(row => String(row.text || "").trimEnd())
    .join("\n\n")
    .trim();
  const confirmedSourceNote = (input.confirmedSourceNoteTabIds ?? []).includes(
    tab.sourceTabId
  );
  if (!content && !confirmedSourceNote) {
    throw new EditorialApprovalDomainError(
      "CONTENT_REQUIRED",
      "Episode staging requires content after the first non-empty title line."
    );
  }

  return {
    episodeNumber,
    title,
    content,
    contentFormat: "plain_text",
    wordCount: countWords(content),
    sourceTabId: tab.sourceTabId,
    sourceTabTitle: tab.title,
    sourceTitleLine,
    contentSha256: sha256(content),
  };
}

export function editorialQcEvidenceSha256(input: {
  runId: number;
  draftId: number;
  engineVersion: string;
  allowListSha256: string;
  findings: Array<{
    findingKey: string;
    disposition: string;
    resolutionVersion: number;
  }>;
  anomalies?: Array<{
    anomalyKey: string;
    anomalyType: string;
    severity: string;
    disposition?: string;
    resolutionVersion?: number;
  }>;
}) {
  const findings = input.findings
    .map(finding => ({
      findingKey: finding.findingKey,
      disposition: finding.disposition,
      resolutionVersion: finding.resolutionVersion,
    }))
    .sort((a, b) => a.findingKey.localeCompare(b.findingKey));
  const anomalies = (input.anomalies ?? [])
    .map(anomaly => {
      const base = {
        anomalyKey: anomaly.anomalyKey,
        anomalyType: anomaly.anomalyType,
        severity: anomaly.severity,
      };
      const disposition = anomaly.disposition ?? "open";
      const resolutionVersion = anomaly.resolutionVersion ?? 0;
      return disposition === "open" && resolutionVersion === 0
        ? base
        : { ...base, disposition, resolutionVersion };
    })
    .sort((a, b) => a.anomalyKey.localeCompare(b.anomalyKey));
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_APPROVAL_CONTRACT,
      runId: input.runId,
      draftId: input.draftId,
      engineVersion: input.engineVersion,
      allowListSha256: input.allowListSha256.toLowerCase(),
      findings,
      anomalies,
    })
  );
}

export function editorialApprovalPayloadSha256(input: {
  workItemId: number;
  draftId: number;
  draftVersion: number;
  draftSha256: string;
  checkerRunId: number;
  qcEvidenceSha256: string;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_APPROVAL_CONTRACT,
      workItemId: input.workItemId,
      draftId: input.draftId,
      draftVersion: input.draftVersion,
      draftSha256: input.draftSha256.toLowerCase(),
      checkerRunId: input.checkerRunId,
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
    })
  );
}

export function editorialEpisodeStateSha256(input: {
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  contentFormat: string | null;
  wordCount: number | null;
  isPublished: boolean;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT,
      novelId: input.novelId,
      episodeNumber: normalizeEditorialEpisodeNumber(input.episodeNumber),
      title: input.title,
      content: input.content ?? "",
      contentFormat: input.contentFormat ?? "plain_text",
      wordCount: input.wordCount ?? 0,
      isPublished: Boolean(input.isPublished),
    })
  );
}

export function editorialEpisodeStateSha256V2(input: {
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  contentFormat: string | null;
  wordCount: number | null;
  isPublished: boolean;
  saleMode: "chapter" | "package";
  price: string;
  isFree: boolean;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT_V2,
      novelId: input.novelId,
      episodeNumber: normalizeEditorialEpisodeNumber(input.episodeNumber),
      title: input.title,
      content: input.content ?? "",
      contentFormat: input.contentFormat ?? "plain_text",
      wordCount: input.wordCount ?? 0,
      isPublished: Boolean(input.isPublished),
      saleMode: input.saleMode,
      price: input.price,
      isFree: Boolean(input.isFree),
    })
  );
}

export function editorialEpisodeReplacementTargetStateSha256(input: {
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  contentFormat: string | null;
  wordCount: number | null;
  isPublished: boolean;
  saleMode: "chapter" | "package";
  price: string;
  isFree: boolean;
  fileUrl?: string | null;
  fileSize?: number | null;
  fileMimeType?: string | null;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT_V3,
      purpose: "replacement-target-state",
      novelId: input.novelId,
      episodeNumber: normalizeEditorialEpisodeNumber(input.episodeNumber),
      title: input.title,
      content: input.content ?? "",
      contentFormat: input.contentFormat ?? "plain_text",
      wordCount: input.wordCount ?? 0,
      isPublished: Boolean(input.isPublished),
      saleMode: input.saleMode,
      price: input.price,
      isFree: Boolean(input.isFree),
      fileUrl: input.fileUrl ?? null,
      fileSize: input.fileSize ?? null,
      fileMimeType: input.fileMimeType ?? null,
    })
  );
}

export function editorialEpisodeStagePayloadSha256(input: {
  workItemId: number;
  approvalId: number;
  draftId: number;
  draftSha256: string;
  qcEvidenceSha256: string;
  novelId: number;
  plan: EditorialEpisodeDraftPlan;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT,
      workItemId: input.workItemId,
      approvalId: input.approvalId,
      draftId: input.draftId,
      draftSha256: input.draftSha256.toLowerCase(),
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
      novelId: input.novelId,
      episodeNumber: input.plan.episodeNumber,
      title: input.plan.title,
      contentSha256: input.plan.contentSha256,
      contentFormat: input.plan.contentFormat,
      wordCount: input.plan.wordCount,
      sourceTabId: input.plan.sourceTabId,
    })
  );
}

export function editorialEpisodeStagePayloadSha256V3(input: {
  workItemId: number;
  approvalId: number;
  draftId: number;
  draftSha256: string;
  qcEvidenceSha256: string;
  novelId: number;
  plan: EditorialEpisodeDraftPlan;
  saleMode: "chapter" | "package";
  price: string;
  isFree: boolean;
  replacementTargetStateSha256: string;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT_V3,
      workItemId: input.workItemId,
      approvalId: input.approvalId,
      draftId: input.draftId,
      draftSha256: input.draftSha256.toLowerCase(),
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
      novelId: input.novelId,
      episodeNumber: input.plan.episodeNumber,
      title: input.plan.title,
      contentSha256: input.plan.contentSha256,
      contentFormat: input.plan.contentFormat,
      wordCount: input.plan.wordCount,
      sourceTabId: input.plan.sourceTabId,
      saleMode: input.saleMode,
      price: input.price,
      isFree: Boolean(input.isFree),
      replacementTargetStateSha256: input.replacementTargetStateSha256.toLowerCase(),
    })
  );
}

export function editorialEpisodeStagePayloadSha256V2(input: {
  workItemId: number;
  approvalId: number;
  draftId: number;
  draftSha256: string;
  qcEvidenceSha256: string;
  novelId: number;
  plan: EditorialEpisodeDraftPlan;
  saleMode: "chapter" | "package";
  price: string;
  isFree: boolean;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT_V2,
      workItemId: input.workItemId,
      approvalId: input.approvalId,
      draftId: input.draftId,
      draftSha256: input.draftSha256.toLowerCase(),
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
      novelId: input.novelId,
      episodeNumber: input.plan.episodeNumber,
      title: input.plan.title,
      contentSha256: input.plan.contentSha256,
      contentFormat: input.plan.contentFormat,
      wordCount: input.plan.wordCount,
      sourceTabId: input.plan.sourceTabId,
      saleMode: input.saleMode,
      price: input.price,
      isFree: Boolean(input.isFree),
    })
  );
}
