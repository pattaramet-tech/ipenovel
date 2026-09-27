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
    disposition?: string | null;
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
  chapterNumber?: string | null;
  disposition?: string | null;
  confirmationVersion?: number | null;
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

export function chapterEditorStructuralRepairGuidance(anomalyType: string) {
  switch (anomalyType) {
    case "empty_tab":
      return "แท็บนี้ไม่มีเนื้อหา ให้เปิด Editor แล้วเติมเนื้อหาที่ถูกต้อง จากนั้นบันทึก Draft + ตรวจซ้ำ";
    case "heading_only_tab":
      return "แท็บนี้มีเพียงชื่อบท ให้เติมเนื้อเรื่องใต้ชื่อบท แล้วบันทึก Draft + ตรวจซ้ำ";
    case "end_only_tab":
      return "แท็บนี้มีเพียง “จบตอน” ให้ตรวจต้นฉบับและเติมเนื้อเรื่องก่อน marker แล้วตรวจซ้ำ";
    case "source_note_only":
      return "ถ้าแท็บนี้เป็นหมายเหตุจากต้นฉบับจริง ให้ยืนยันอย่างชัดเจน; ถ้าไม่ใช่ ให้แก้เนื้อหาแล้วตรวจซ้ำ";
    case "duplicate_chapter_number":
      return "เปิดแท็บที่มีเลขบทซ้ำทีละแท็บเพื่อตรวจชื่อบทและเนื้อหา ห้ามแก้อัตโนมัติ";
    case "duplicate_content_exact":
      return "เปิดแท็บที่เกี่ยวข้องเพื่อตรวจเนื้อหาซ้ำทั้งบท แล้วแก้เฉพาะแท็บที่ผิด";
    case "duplicate_content_near":
      return "เปิดแท็บที่เกี่ยวข้องเพื่อตรวจความคล้ายสูง อาจเป็นข้อความซ้ำที่ถูกต้องได้";
    case "missing_expected_chapter":
      return "ไม่พบเลขบทที่คาดไว้ ให้ตรวจแท็บใกล้เคียงว่าหัวข้อบทหายหรือเลขบทผิด";
    case "tab_count_mismatch":
      return "จำนวนแท็บไม่ตรงช่วงตอน ให้ตรวจแท็บที่ขาด/เกินและโครงสร้าง Episode Pack";
    default:
      return "ตรวจแท็บที่เกี่ยวข้อง แก้เนื้อหาโดยผู้ใช้ แล้วรัน checker ซ้ำ";
  }
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
      (anomaly.sourceTabId === input.sourceTabId ||
        (anomaly.relatedSourceTabIds ?? []).includes(input.sourceTabId)) &&
      anomaly.disposition !== "confirmed_source_note"
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
