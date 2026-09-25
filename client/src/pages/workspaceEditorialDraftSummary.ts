export type EditorialDraftSummaryParagraph = {
  text?: string | null;
  sourceParagraphIndex?: number | null;
};

export type EditorialDraftSummaryTab = {
  title?: string | null;
  tabOrder?: number | null;
  chapterNumber?: string | null;
  warnings?: string[] | null;
  paragraphs?: EditorialDraftSummaryParagraph[] | null;
};

function sourceText(tab: EditorialDraftSummaryTab) {
  return (tab.paragraphs ?? [])
    .filter(paragraph => (paragraph.sourceParagraphIndex ?? 1) > 0)
    .map(paragraph => String(paragraph.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function parseTabNumber(tab: EditorialDraftSummaryTab) {
  const title = String(tab.title ?? "").trim();
  const titleMatch = title.match(/(?:แท็บ|tab|ตอน|บท(?:ที่)?|chapter)?\s*#?\s*(\d{1,6})/i);
  if (titleMatch) return Number(titleMatch[1]);
  const chapter = String(tab.chapterNumber ?? "").trim();
  return /^\d{1,6}$/.test(chapter) ? Number(chapter) : null;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}
export function summarizeEditorialDraftTabs(
  input: readonly EditorialDraftSummaryTab[]
) {
  const tabs = input.slice().sort(
    (a, b) => Number(a.tabOrder ?? 0) - Number(b.tabOrder ?? 0)
  );
  const rows = tabs.map((tab, index) => {
    const text = sourceText(tab);
    return {
      index,
      title: String(tab.title ?? `แท็บ ${index + 1}`),
      number: parseTabNumber(tab),
      characterCount: text.length,
      empty: text.length === 0,
      warningCount: tab.warnings?.length ?? 0,
    };
  });

  const nonEmptyLengths = rows
    .filter(row => !row.empty)
    .map(row => row.characterCount);
  const medianCharacters = median(nonEmptyLengths);
  const shortThreshold =
    medianCharacters >= 400
      ? Math.max(120, Math.floor(medianCharacters * 0.25))
      : 80;

  const emptyTabs = rows.filter(row => row.empty);
  const shortTabs = rows.filter(
    row => !row.empty && row.characterCount < shortThreshold
  );
  const unnumberedTabs = rows.filter(row => row.number === null);
  const sequenceIssues: string[] = [];
  const numbered = rows.filter(
    (row): row is typeof row & { number: number } => row.number !== null
  );
  for (let index = 1; index < numbered.length; index += 1) {
    const previous = numbered[index - 1].number;
    const current = numbered[index].number;
    if (current === previous + 1) continue;
    if (current === previous) {
      sequenceIssues.push(`เลขซ้ำ ${current}`);
    } else if (current < previous) {
      sequenceIssues.push(`ลำดับย้อน ${previous}→${current}`);
    } else {
      const firstMissing = previous + 1;
      const lastMissing = current - 1;
      sequenceIssues.push(
        firstMissing === lastMissing
          ? `ขาดเลข ${firstMissing}`
          : `ขาดเลข ${firstMissing}–${lastMissing}`
      );
    }
  }

  return {
    totalTabs: rows.length,
    numberedTabs: numbered.length,
    medianCharacters,
    shortThreshold,
    emptyTabs,
    shortTabs,
    unnumberedTabs,
    sequenceIssues: Array.from(new Set(sequenceIssues)),
    warningTabs: rows.filter(row => row.warningCount > 0),
  };
}
