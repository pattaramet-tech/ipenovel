import { createHash } from "node:crypto";

import {
  cleanupChapterParagraphs,
  cleanupEnding,
  detectEnglishSourceBlock,
  editorialDraftSha256,
  normalizeEditorialText,
  paragraphFingerprint,
  reindexEditorialDraftDocument,
  splitAdjacentPairs,
  splitBracketStatusBlocks,
  type EditorialDraftDocument,
  type EditorialDraftParagraph,
} from "./editorialDraft.domain";
import {
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
  EDITORIAL_FOREIGN_CHECKER_RULES,
  editorialAllowListSha256,
  evaluateEditorialForeignDraft,
  type EditorialCheckerParagraphInput,
  type EditorialForeignFinding,
} from "./editorialForeignChecker.domain";
import {
  EDITORIAL_STRUCTURAL_CHECK_VERSION,
  evaluateEditorialStructuralAnomalies,
  isExactAcceptedSourceNote,
  type EditorialStructuralTabInput,
} from "./editorialStructuralAnomaly.domain";
import { classifyEditorialChapterNumber } from "./editorialIdentityContract.domain";
import { applyEditorialBulkCleanupToDocument } from "./editorialBulkFindingCleanup.domain";

export const EDITORIAL_FULL_CHECKER_ENGINE_VERSION =
  "workspace-full-checker-vnext-v1" as const;

export const EDITORIAL_FULL_CHECKER_TRANSFORM_CODES = [
  "chapter_heading_cleanup",
  "quote_bracket_split",
  "blank_line_cleanup",
  "english_source_cleanup",
  "source_junk_cleanup",
  "ending_cleanup",
] as const;

export type EditorialFullCheckerTransformCode =
  (typeof EDITORIAL_FULL_CHECKER_TRANSFORM_CODES)[number];

export type EditorialFullCheckerSafetyClass =
  | "AUTO_SAFE"
  | "PREVIEW_REQUIRED"
  | "REPORT_ONLY";

export type EditorialFullCheckerFinding = {
  findingId: string;
  code: string;
  category: "foreign" | "structural" | "sequence" | "heading";
  severity: "warning" | "error";
  sourceTabId: string | null;
  paragraphKey: string | null;
  offsetEncoding: "utf16" | null;
  startOffset: number | null;
  endOffset: number | null;
  evidence: string;
  repairPolicy: "none" | "manual" | "preview_required" | "report_only";
  autoFixable: boolean;
  sourceIdentity: string;
};

export type EditorialFullCheckerTransformChange = {
  sourceTabId: string;
  paragraphKey: string | null;
  before: string;
  after: string;
};

export type EditorialFullCheckerTransformPreview = {
  transformId: string;
  ruleCode: EditorialFullCheckerTransformCode | "all_safe";
  safetyClass: EditorialFullCheckerSafetyClass;
  beforeDraftSha256: string;
  afterDraftSha256: string;
  changed: boolean;
  changedParagraphCount: number;
  ruleCodes: EditorialFullCheckerTransformCode[];
  changes: EditorialFullCheckerTransformChange[];
  changesTruncated: boolean;
  idempotent: boolean;
};

export const EDITORIAL_FULL_CHECKER_RULE_CATALOG = {
  foreign_script: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  long_english: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  source_junk: {
    outputClass: "QC_FINDING",
    safetyClass: "PREVIEW_REQUIRED",
    autoFixable: true,
  },
  malformed_chapter_heading: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  range_shaped_chapter_identity: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  unexpected_chapter_jump: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  out_of_order_chapter: {
    outputClass: "QC_FINDING",
    safetyClass: "REPORT_ONLY",
    autoFixable: false,
  },
  chapter_heading_cleanup: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "AUTO_SAFE",
    autoFixable: true,
  },
  quote_bracket_split: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "AUTO_SAFE",
    autoFixable: true,
  },
  blank_line_cleanup: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "AUTO_SAFE",
    autoFixable: true,
  },
  english_source_cleanup: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "PREVIEW_REQUIRED",
    autoFixable: true,
  },
  source_junk_cleanup: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "PREVIEW_REQUIRED",
    autoFixable: true,
  },
  ending_cleanup: {
    outputClass: "SAFE_TRANSFORM",
    safetyClass: "PREVIEW_REQUIRED",
    autoFixable: true,
  },
} as const;

const TRANSFORM_SAFETY: Record<
  EditorialFullCheckerTransformCode,
  EditorialFullCheckerSafetyClass
> = {
  chapter_heading_cleanup: "AUTO_SAFE",
  quote_bracket_split: "AUTO_SAFE",
  blank_line_cleanup: "AUTO_SAFE",
  english_source_cleanup: "PREVIEW_REQUIRED",
  source_junk_cleanup: "PREVIEW_REQUIRED",
  ending_cleanup: "PREVIEW_REQUIRED",
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedEvidence(value: string, limit = 180) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, Math.max(0, limit - 1)) + "…";
}

function cloneDocument(document: EditorialDraftDocument): EditorialDraftDocument {
  return JSON.parse(JSON.stringify(document)) as EditorialDraftDocument;
}

function checkerParagraphs(
  document: EditorialDraftDocument
): EditorialCheckerParagraphInput[] {
  return document.tabs
    .slice()
    .sort(
      (a, b) =>
        a.tabOrder - b.tabOrder || a.sourceTabId.localeCompare(b.sourceTabId)
    )
    .flatMap(tab =>
      tab.paragraphs
        .slice()
        .sort((a, b) => a.paragraphOrder - b.paragraphOrder)
        .map(paragraph => ({
          sourceTabId: tab.sourceTabId,
          tabTitle: tab.title,
          paragraphKey: paragraph.paragraphKey,
          paragraphOrder: paragraph.paragraphOrder,
          paragraphFingerprint: paragraph.paragraphFingerprint,
          text: paragraph.text,
        }))
    );
}

function structuralTabs(
  document: EditorialDraftDocument
): EditorialStructuralTabInput[] {
  return document.tabs.map(tab => ({
    sourceTabId: tab.sourceTabId,
    tabOrder: tab.tabOrder,
    tabTitle: tab.title,
    chapterNumber: tab.chapterNumber,
    chapterTitle: tab.chapterTitle,
    paragraphs: tab.paragraphs.map(paragraph => ({
      paragraphKey: paragraph.paragraphKey,
      paragraphOrder: paragraph.paragraphOrder,
      sourceParagraphIndex: paragraph.sourceParagraphIndex,
      text: paragraph.text,
    })),
  }));
}

function foreignFinding(
  finding: EditorialForeignFinding
): EditorialFullCheckerFinding {
  const sourceJunk =
    finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk;
  return {
    findingId: sha256(
      [
        EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
        "foreign",
        finding.findingKey,
      ].join("\0")
    ),
    code: finding.ruleKey,
    category: "foreign",
    severity: finding.severity,
    sourceTabId: finding.sourceTabId,
    paragraphKey: finding.paragraphKey,
    offsetEncoding: "utf16",
    startOffset: finding.startOffset,
    endOffset: finding.endOffset,
    evidence: boundedEvidence(finding.token),
    repairPolicy: sourceJunk ? "preview_required" : "report_only",
    autoFixable: sourceJunk,
    sourceIdentity: finding.findingKey,
  };
}

function structuralFindings(
  document: EditorialDraftDocument,
  episodeNumber?: string | null
) {
  const structural = evaluateEditorialStructuralAnomalies({
    tabs: structuralTabs(document),
    episodeNumber,
  });
  return {
    structural,
    findings: structural.anomalies.map(
      anomaly =>
        ({
          findingId: sha256(
            [
              EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
              "structural",
              anomaly.anomalyKey,
            ].join("\0")
          ),
          code: anomaly.anomalyType,
          category: "structural",
          severity: anomaly.severity,
          sourceTabId: anomaly.sourceTabId,
          paragraphKey: null,
          offsetEncoding: null,
          startOffset: null,
          endOffset: null,
          evidence: boundedEvidence(anomaly.message),
          repairPolicy:
            anomaly.anomalyType === "source_note_only"
              ? "manual"
              : "report_only",
          autoFixable: false,
          sourceIdentity: anomaly.anomalyKey,
        }) satisfies EditorialFullCheckerFinding
    ),
  };
}

function headingAndSequenceFindings(document: EditorialDraftDocument) {
  const findings: EditorialFullCheckerFinding[] = [];
  const ordered = document.tabs
    .slice()
    .sort(
      (a, b) =>
        a.tabOrder - b.tabOrder || a.sourceTabId.localeCompare(b.sourceTabId)
    );
  const singles: Array<{
    sourceTabId: string;
    number: number;
  }> = [];

  for (const tab of ordered) {
    const classification = classifyEditorialChapterNumber(tab.chapterNumber);
    if (classification.rangeShaped) {
      findings.push({
        findingId: sha256(
          [
            EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
            "range-shaped",
            tab.sourceTabId,
            classification.raw ?? "",
          ].join("\0")
        ),
        code: "range_shaped_chapter_identity",
        category: "sequence",
        severity: "error",
        sourceTabId: tab.sourceTabId,
        paragraphKey: null,
        offsetEncoding: null,
        startOffset: null,
        endOffset: null,
        evidence: boundedEvidence(classification.raw ?? ""),
        repairPolicy: "report_only",
        autoFixable: false,
        sourceIdentity: classification.raw ?? "",
      });
      continue;
    }
    if (classification.kind === "single" && classification.singleNumber) {
      const number = Number(classification.singleNumber);
      if (Number.isSafeInteger(number)) {
        singles.push({ sourceTabId: tab.sourceTabId, number });
      }
      continue;
    }

    const candidate = tab.paragraphs
      .slice()
      .sort((a, b) => a.paragraphOrder - b.paragraphOrder)
      .find(paragraph =>
        /^(?:บท(?:ที่)?|ตอน(?:ที่)?|chapter\b)/i.test(
          normalizeEditorialText(paragraph.text)
        )
      );
    if (candidate) {
      findings.push({
        findingId: sha256(
          [
            EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
            "malformed-heading",
            tab.sourceTabId,
            candidate.paragraphKey,
            candidate.paragraphFingerprint,
          ].join("\0")
        ),
        code: "malformed_chapter_heading",
        category: "heading",
        severity: "error",
        sourceTabId: tab.sourceTabId,
        paragraphKey: candidate.paragraphKey,
        offsetEncoding: "utf16",
        startOffset: 0,
        endOffset: candidate.text.length,
        evidence: boundedEvidence(candidate.text),
        repairPolicy: "report_only",
        autoFixable: false,
        sourceIdentity: candidate.paragraphFingerprint,
      });
    }
  }

  for (let index = 1; index < singles.length; index += 1) {
    const previous = singles[index - 1]!;
    const current = singles[index]!;
    if (current.number < previous.number) {
      findings.push({
        findingId: sha256(
          [
            EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
            "out-of-order",
            previous.sourceTabId,
            current.sourceTabId,
            String(previous.number),
            String(current.number),
          ].join("\0")
        ),
        code: "out_of_order_chapter",
        category: "sequence",
        severity: "error",
        sourceTabId: current.sourceTabId,
        paragraphKey: null,
        offsetEncoding: null,
        startOffset: null,
        endOffset: null,
        evidence: `${previous.number} → ${current.number}`,
        repairPolicy: "report_only",
        autoFixable: false,
        sourceIdentity: `${previous.sourceTabId}:${current.sourceTabId}`,
      });
    } else if (current.number > previous.number + 1) {
      findings.push({
        findingId: sha256(
          [
            EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
            "jump",
            previous.sourceTabId,
            current.sourceTabId,
            String(previous.number),
            String(current.number),
          ].join("\0")
        ),
        code: "unexpected_chapter_jump",
        category: "sequence",
        severity: "error",
        sourceTabId: current.sourceTabId,
        paragraphKey: null,
        offsetEncoding: null,
        startOffset: null,
        endOffset: null,
        evidence: `${previous.number} → ${current.number}`,
        repairPolicy: "report_only",
        autoFixable: false,
        sourceIdentity: `${previous.sourceTabId}:${current.sourceTabId}`,
      });
    }
  }

  return findings;
}

export function evaluateEditorialFullChecker(input: {
  document: EditorialDraftDocument;
  episodeNumber?: string | null;
  allowWords?: readonly string[];
}) {
  const allowWords = input.allowWords ?? [];
  const foreign = evaluateEditorialForeignDraft({
    paragraphs: checkerParagraphs(input.document),
    allowWords,
  });
  const structuralResult = structuralFindings(
    input.document,
    input.episodeNumber
  );
  const findings = [
    ...foreign.findings.map(foreignFinding),
    ...structuralResult.findings,
    ...headingAndSequenceFindings(input.document),
  ].sort(
    (a, b) =>
      String(a.sourceTabId ?? "").localeCompare(String(b.sourceTabId ?? "")) ||
      (a.startOffset ?? -1) - (b.startOffset ?? -1) ||
      a.code.localeCompare(b.code) ||
      a.findingId.localeCompare(b.findingId)
  );
  const allowListIdentity = editorialAllowListSha256(allowWords);
  const configIdentity = sha256(
    JSON.stringify({
      engineVersion: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
      foreignEngineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      structuralEngineVersion: EDITORIAL_STRUCTURAL_CHECK_VERSION,
      allowListIdentity,
    })
  );
  return {
    engineVersion: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
    configIdentity,
    allowListIdentity,
    draftSha256: editorialDraftSha256(input.document),
    status: findings.some(finding => finding.severity === "error")
      ? ("failed" as const)
      : ("passed" as const),
    findingCount: findings.length,
    findings,
    structuralSummary: structuralResult.structural.summary,
  };
}

function expandSplitParagraph(
  paragraph: EditorialDraftParagraph
): EditorialDraftParagraph[] {
  const pieces = splitBracketStatusBlocks(splitAdjacentPairs(paragraph.text))
    .split("\n")
    .map(value => normalizeEditorialText(value))
    .filter(Boolean);
  if (pieces.length <= 1) {
    return [{ ...paragraph, text: pieces[0] ?? paragraph.text }];
  }
  return pieces.map((piece, pieceIndex) => ({
    ...paragraph,
    paragraphKey: sha256(
      [
        "workspace-editorial-paragraph-split-v1",
        paragraph.paragraphKey,
        String(pieceIndex + 1),
        piece,
      ].join("\0")
    ),
    text: piece,
  }));
}

function hasNarrativeEvidence(tab: EditorialDraftDocument["tabs"][number]) {
  if (classifyEditorialChapterNumber(tab.chapterNumber).kind !== "single") {
    return false;
  }
  return tab.paragraphs.some(paragraph => {
    const text = normalizeEditorialText(paragraph.text)
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return false;
    if (/^จบตอน[.!…]*$/i.test(text)) return false;
    if (
      /^(?:บท(?:ที่)?|ตอนที่|chapter)\s*\[?\s*[0-9๐-๙]+/i.test(text)
    ) {
      return false;
    }
    if (
      /(?:หมายเหตุ(?:จาก)?ต้นฉบับ|ต้นฉบับ(?:เดิม)?(?:ไม่มี|ขาด|เว้น))/i.test(
        text
      )
    ) {
      return false;
    }
    return !/^[_\-=*#~•·.]{3,}$/.test(text.replace(/\s+/g, ""));
  });
}

export function resolveEditorialFullCheckerFindingTarget(
  document: EditorialDraftDocument,
  finding: Pick<
    EditorialFullCheckerFinding,
    | "sourceTabId"
    | "paragraphKey"
    | "offsetEncoding"
    | "startOffset"
    | "endOffset"
  >
) {
  if (
    !finding.sourceTabId ||
    !finding.paragraphKey ||
    finding.offsetEncoding !== "utf16" ||
    finding.startOffset == null ||
    finding.endOffset == null
  ) {
    return null;
  }
  const matches = document.tabs.flatMap(tab =>
    tab.paragraphs
      .filter(paragraph => paragraph.paragraphKey === finding.paragraphKey)
      .map(paragraph => ({ tab, paragraph }))
  );
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (match.tab.sourceTabId !== finding.sourceTabId) return null;
  const startOffset = Number(finding.startOffset);
  const endOffset = Number(finding.endOffset);
  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > match.paragraph.text.length
  ) {
    return null;
  }
  return {
    sourceTabId: match.tab.sourceTabId,
    paragraphKey: match.paragraph.paragraphKey,
    startOffset,
    endOffset,
    text: match.paragraph.text.slice(startOffset, endOffset),
  };
}

function applySingleTransform(input: {
  document: EditorialDraftDocument;
  transformCode: EditorialFullCheckerTransformCode;
  allowWords?: readonly string[];
}) {
  const next = cloneDocument(input.document);

  if (input.transformCode === "chapter_heading_cleanup") {
    for (const tab of next.tabs) {
      tab.paragraphs = cleanupChapterParagraphs(tab.paragraphs);
    }
    return reindexEditorialDraftDocument(next);
  }

  if (input.transformCode === "quote_bracket_split") {
    for (const tab of next.tabs) {
      tab.paragraphs = tab.paragraphs.flatMap(expandSplitParagraph);
    }
    return reindexEditorialDraftDocument(next);
  }

  if (input.transformCode === "blank_line_cleanup") {
    for (const tab of next.tabs) {
      tab.paragraphs = tab.paragraphs.filter(paragraph =>
        Boolean(normalizeEditorialText(paragraph.text))
      );
    }
    return reindexEditorialDraftDocument(next);
  }

  if (input.transformCode === "english_source_cleanup") {
    for (const tab of next.tabs) {
      const report = detectEnglishSourceBlock(
        tab.paragraphs.map(paragraph => paragraph.text)
      );
      if (report.detected && report.confidence === "HIGH") {
        tab.paragraphs.splice(
          report.startIndex,
          report.endIndex - report.startIndex + 1
        );
      }
    }
    return reindexEditorialDraftDocument(next);
  }

  if (input.transformCode === "source_junk_cleanup") {
    const evaluated = evaluateEditorialForeignDraft({
      paragraphs: checkerParagraphs(next),
      allowWords: input.allowWords ?? [],
    });
    const sourceJunk = evaluated.findings.filter(
      finding =>
        finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    if (!sourceJunk.length) return reindexEditorialDraftDocument(next);
    return applyEditorialBulkCleanupToDocument({
      document: next,
      findings: sourceJunk,
    }).document;
  }

  const beforeSha = editorialDraftSha256(next);
  for (const tab of next.tabs) {
    if (!hasNarrativeEvidence(tab)) continue;
    // IPE-060B: a tab identified by the exact canonical source note is an
    // intentional non-narrative tab — never receive an ending marker.
    if (
      isExactAcceptedSourceNote(tab.title) ||
      isExactAcceptedSourceNote(tab.chapterTitle ?? "")
    ) {
      continue;
    }
    const hadMarker = tab.paragraphs.some(paragraph =>
      /^จบตอน[.!…]*$/i.test(normalizeEditorialText(paragraph.text))
    );
    tab.paragraphs = cleanupEnding(tab.paragraphs, tab.sourceTabId);
    if (!hadMarker) {
      const generated = tab.paragraphs.find(
        paragraph =>
          paragraph.sourceParagraphIndex === 0 &&
          normalizeEditorialText(paragraph.text) === "จบตอน"
      );
      if (generated) {
        generated.paragraphKey = sha256(
          [
            "workspace-full-checker-generated-end-v1",
            beforeSha,
            tab.sourceTabId,
          ].join("\0")
        );
        generated.sourceParagraphFingerprint = paragraphFingerprint("จบตอน");
        generated.paragraphFingerprint = paragraphFingerprint("จบตอน");
      }
    }
  }
  return reindexEditorialDraftDocument(next);
}

export function applyEditorialFullCheckerTransform(input: {
  document: EditorialDraftDocument;
  transformCode: EditorialFullCheckerTransformCode | "all_safe";
  allowWords?: readonly string[];
}) {
  if (input.transformCode !== "all_safe") {
    return applySingleTransform({
      document: input.document,
      transformCode: input.transformCode,
      allowWords: input.allowWords,
    });
  }
  let current = cloneDocument(input.document);
  for (const transformCode of EDITORIAL_FULL_CHECKER_TRANSFORM_CODES) {
    current = applySingleTransform({
      document: current,
      transformCode,
      allowWords: input.allowWords,
    });
  }
  return reindexEditorialDraftDocument(current);
}

function paragraphDiff(
  before: EditorialDraftDocument,
  after: EditorialDraftDocument
) {
  const beforeRows = new Map<
    string,
    { sourceTabId: string; paragraphKey: string; text: string }
  >();
  const afterRows = new Map<
    string,
    { sourceTabId: string; paragraphKey: string; text: string }
  >();
  for (const tab of before.tabs) {
    for (const paragraph of tab.paragraphs) {
      beforeRows.set(`${tab.sourceTabId}\0${paragraph.paragraphKey}`, {
        sourceTabId: tab.sourceTabId,
        paragraphKey: paragraph.paragraphKey,
        text: paragraph.text,
      });
    }
  }
  for (const tab of after.tabs) {
    for (const paragraph of tab.paragraphs) {
      afterRows.set(`${tab.sourceTabId}\0${paragraph.paragraphKey}`, {
        sourceTabId: tab.sourceTabId,
        paragraphKey: paragraph.paragraphKey,
        text: paragraph.text,
      });
    }
  }
  const keys = Array.from(
    new Set([
      ...Array.from(beforeRows.keys()),
      ...Array.from(afterRows.keys()),
    ])
  ).sort();
  const all = keys
    .filter(key => beforeRows.get(key)?.text !== afterRows.get(key)?.text)
    .map(key => {
      const left = beforeRows.get(key);
      const right = afterRows.get(key);
      return {
        sourceTabId: left?.sourceTabId ?? right?.sourceTabId ?? "",
        paragraphKey: left?.paragraphKey ?? right?.paragraphKey ?? null,
        before: boundedEvidence(left?.text ?? "", 240),
        after: boundedEvidence(right?.text ?? "", 240),
      };
    });
  return {
    changedParagraphCount: all.length,
    changes: all.slice(0, 24),
    changesTruncated: all.length > 24,
  };
}

export function previewEditorialFullCheckerTransform(input: {
  document: EditorialDraftDocument;
  transformCode: EditorialFullCheckerTransformCode | "all_safe";
  allowWords?: readonly string[];
}) {
  const beforeDraftSha256 = editorialDraftSha256(input.document);
  const afterDocument = applyEditorialFullCheckerTransform(input);
  const afterDraftSha256 = editorialDraftSha256(afterDocument);
  const secondPass = applyEditorialFullCheckerTransform({
    document: afterDocument,
    transformCode: input.transformCode,
    allowWords: input.allowWords,
  });
  const idempotent = editorialDraftSha256(secondPass) === afterDraftSha256;
  const diff = paragraphDiff(input.document, afterDocument);
  const ruleCodes =
    input.transformCode === "all_safe"
      ? [...EDITORIAL_FULL_CHECKER_TRANSFORM_CODES]
      : [input.transformCode];
  const safetyClass =
    input.transformCode === "all_safe"
      ? "PREVIEW_REQUIRED"
      : TRANSFORM_SAFETY[input.transformCode];
  const transformId = sha256(
    [
      EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
      beforeDraftSha256,
      input.transformCode,
      afterDraftSha256,
      editorialAllowListSha256(input.allowWords ?? []),
    ].join("\0")
  );
  return {
    transformId,
    ruleCode: input.transformCode,
    safetyClass,
    beforeDraftSha256,
    afterDraftSha256,
    changed: beforeDraftSha256 !== afterDraftSha256,
    changedParagraphCount: diff.changedParagraphCount,
    ruleCodes,
    changes: diff.changes,
    changesTruncated: diff.changesTruncated,
    idempotent,
    document: afterDocument,
  };
}

export function previewEditorialFullCheckerTransforms(input: {
  document: EditorialDraftDocument;
  allowWords?: readonly string[];
}) {
  return {
    transforms: EDITORIAL_FULL_CHECKER_TRANSFORM_CODES.map(transformCode => {
      const preview = previewEditorialFullCheckerTransform({
        ...input,
        transformCode,
      });
      const { document: _document, ...publicPreview } = preview;
      return publicPreview;
    }),
    allSafe: (() => {
      const preview = previewEditorialFullCheckerTransform({
        ...input,
        transformCode: "all_safe",
      });
      const { document: _document, ...publicPreview } = preview;
      return publicPreview;
    })(),
  };
}
