export type ChapterEditorFindingRangeInput = {
  startOffset: number;
  endOffset: number;
  token?: string | null;
};

export type ChapterEditorTabStatusInput = {
  sourceTabId: string;
  paragraphs: readonly {
    sourceParagraphIndex: number;
    sourceParagraphFingerprint: string;
    paragraphFingerprint: string;
  }[];
  findings?: readonly {
    sourceTabId: string;
    disposition?: string | null;
  }[];
  anomalies?: readonly {
    sourceTabId?: string | null;
    relatedSourceTabIds?: readonly string[] | null;
  }[];
};

export type ChapterEditorIssueFindingInput = {
  id: number;
  findingKey: string;
  sourceTabId: string;
  paragraphKey: string;
  paragraphOrder: number;
  startOffset: number;
  endOffset: number;
  token: string;
  ruleKey: string;
  disposition?: string | null;
  resolutionVersion?: number | null;
};

export type ChapterEditorIssueAnomalyInput = {
  id: number;
  anomalyKey: string;
  anomalyType: string;
  severity: string;
  sourceTabId?: string | null;
  relatedSourceTabIds?: readonly string[] | null;
  message: string;
};

export function chapterEditorIssues(input: {
  sourceTabId: string;
  findings?: readonly ChapterEditorIssueFindingInput[];
  anomalies?: readonly ChapterEditorIssueAnomalyInput[];
}) {
  const findings = (input.findings ?? [])
    .filter(finding => finding.sourceTabId === input.sourceTabId)
    .sort(
      (left, right) =>
        left.paragraphOrder - right.paragraphOrder ||
        left.startOffset - right.startOffset ||
        left.id - right.id
    )
    .map(finding => ({
      kind: "finding" as const,
      key: `finding:${finding.findingKey}`,
      finding,
    }));
  const anomalies = (input.anomalies ?? [])
    .filter(
      anomaly =>
        anomaly.sourceTabId === input.sourceTabId ||
        (anomaly.relatedSourceTabIds ?? []).includes(input.sourceTabId)
    )
    .sort((left, right) => left.anomalyType.localeCompare(right.anomalyType) || left.id - right.id)
    .map(anomaly => ({
      kind: "structural" as const,
      key: `structural:${anomaly.anomalyKey}`,
      anomaly,
    }));
  return [...findings, ...anomalies];
}

export function chapterEditorTabStatus(input: ChapterEditorTabStatusInput) {
  const edited = input.paragraphs.some(
    paragraph =>
      paragraph.sourceParagraphIndex < 0 ||
      (paragraph.sourceParagraphIndex > 0 &&
        paragraph.paragraphFingerprint !== paragraph.sourceParagraphFingerprint)
  );
  const foreignFindingCount = (input.findings ?? []).filter(
    finding =>
      finding.sourceTabId === input.sourceTabId &&
      (finding.disposition ?? "open") === "open"
  ).length;
  const structuralIssueCount = (input.anomalies ?? []).filter(
    anomaly =>
      anomaly.sourceTabId === input.sourceTabId ||
      (anomaly.relatedSourceTabIds ?? []).includes(input.sourceTabId)
  ).length;
  return { edited, foreignFindingCount, structuralIssueCount };
}

function normalizeNewlines(value: string) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
}

export function serializeChapterEditorParagraphs(paragraphs: readonly string[]) {
  return paragraphs
    .map(paragraph => normalizeNewlines(paragraph).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function parseChapterEditorPasteText(value: string) {
  return normalizeNewlines(value)
    .split(/\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

export function chapterEditorFindingRanges(
  text: string,
  findings: readonly ChapterEditorFindingRangeInput[]
) {
  const candidates = findings
    .map(finding => ({
      start: Number(finding.startOffset),
      end: Number(finding.endOffset),
      token: String(finding.token ?? ""),
    }))
    .filter(range =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end > range.start &&
      range.end <= text.length &&
      (!range.token || text.slice(range.start, range.end) === range.token)
    )
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const ranges: Array<{ start: number; end: number }> = [];
  let coveredUntil = -1;
  for (const range of candidates) {
    if (range.start < coveredUntil) continue;
    ranges.push({ start: range.start, end: range.end });
    coveredUntil = range.end;
  }
  return ranges;
}
