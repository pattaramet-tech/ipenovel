// IPE-062 — multi-story workspace state model (pure, client-importable).
//
// The workspace page hosts several novels ("stories") side by side. Each
// story keeps its own UI state (focused pack, open chapter, detail tab,
// issues-only filter) so the operator can park story A, work on story B,
// and come back without losing context. The server queries stay keyed to a
// single selected work item; switching stories swaps that selection, and the
// per-story record restores whatever was previously focused.

export type StoryPackTab = "editor" | "qc" | "stage" | "publish";

export interface StoryUiState {
  /** Pack (work item) focused inside this story, if any. */
  packWorkItemId: number | null;
  /** Chapter (draft tab) that was open in the editor for this story. */
  chapterSourceTabId: string | null;
  /** Detail tab shown for this story's focused pack. */
  activeTab: StoryPackTab;
  /** Whether the chapter list is filtered to problem chapters only. */
  issuesOnly: boolean;
}

export function createStoryUiState(): StoryUiState {
  return {
    packWorkItemId: null,
    chapterSourceTabId: null,
    activeTab: "editor",
    issuesOnly: false,
  };
}

export function resolveStoryUiState(
  states: Record<string, StoryUiState>,
  storyKey: string
): StoryUiState {
  return states[storyKey] ?? createStoryUiState();
}

export function updateStoryUiState(
  states: Record<string, StoryUiState>,
  storyKey: string,
  patch: Partial<StoryUiState>
): Record<string, StoryUiState> {
  const next = {
    ...states,
    [storyKey]: { ...resolveStoryUiState(states, storyKey), ...patch },
  };
  return next;
}

export function storyKeyFor(workspaceNovelId: unknown, novelId: unknown): string {
  if (workspaceNovelId != null && Number.isFinite(Number(workspaceNovelId))) {
    return `wn:${Number(workspaceNovelId)}`;
  }
  if (novelId != null && Number.isFinite(Number(novelId))) {
    return `novel:${Number(novelId)}`;
  }
  return "story:?";
}

// ---------------------------------------------------------------------------
// Pack / story rollup status derived from the durable board evidence (the
// same `editorialEvidenceStatuses` source the pack table uses — no new
// readiness derivation).
// ---------------------------------------------------------------------------

export interface StoryEvidence {
  checkerRan?: boolean;
  checker?: boolean;
  available?: boolean;
  approval?: boolean;
  readyToPublish?: boolean;
  published?: boolean;
  error?: string | null;
}

export type StoryPackStatus = "published" | "passed" | "needs_fix" | "anomalous" | "not_checked";

export function derivePackStatus(evidence: StoryEvidence | null | undefined): StoryPackStatus {
  if (!evidence) return "not_checked";
  if (evidence.available === false) return "anomalous";
  if (evidence.published) return "published";
  if (evidence.checker) return "passed";
  if (evidence.checkerRan) return "needs_fix";
  return "not_checked";
}

export const STORY_PACK_STATUS_LABEL: Record<StoryPackStatus, string> = {
  published: "ลงแล้ว",
  passed: "ผ่าน",
  needs_fix: "ต้องแก้",
  anomalous: "ผิดปกติ",
  not_checked: "ยังไม่ตรวจ",
};

export interface StoryPackSummary {
  total: number;
  published: number;
  passed: number;
  needsFix: number;
  anomalous: number;
  notChecked: number;
}

export function summarizeStoryPacks(
  cards: Array<{ evidence: StoryEvidence | null }>
): StoryPackSummary {
  const summary: StoryPackSummary = {
    total: cards.length,
    published: 0,
    passed: 0,
    needsFix: 0,
    anomalous: 0,
    notChecked: 0,
  };
  for (const card of cards) {
    switch (derivePackStatus(card.evidence)) {
      case "published":
        summary.published += 1;
        break;
      case "passed":
        summary.passed += 1;
        break;
      case "needs_fix":
        summary.needsFix += 1;
        break;
      case "anomalous":
        summary.anomalous += 1;
        break;
      default:
        summary.notChecked += 1;
    }
  }
  return summary;
}

export type StoryOverallStatus = "anomalous" | "needs_fix" | "in_progress" | "passed" | "published";

export const STORY_OVERALL_LABEL: Record<StoryOverallStatus, string> = {
  anomalous: "ผิดปกติ",
  needs_fix: "ต้องแก้",
  in_progress: "กำลังดำเนินการ",
  passed: "ผ่านทั้งหมด",
  published: "ลงแล้วทั้งหมด",
};

/** Worst-severity rollup across a story's packs (anomalous dominates). */
export function storyOverallStatus(summary: StoryPackSummary): StoryOverallStatus {
  if (summary.total === 0) return "in_progress";
  if (summary.anomalous > 0) return "anomalous";
  if (summary.needsFix > 0) return "needs_fix";
  if (summary.notChecked > 0) return "in_progress";
  if (summary.published === summary.total) return "published";
  return "passed";
}

export function filterPacksByQuery<T extends { episodeNumber?: string | null; episodeTitle?: string | null; note?: string | null; workItemType?: string }>(
  cards: T[],
  rawQuery: string
): T[] {
  const query = rawQuery.trim().toLocaleLowerCase("th");
  if (!query) return cards;
  return cards.filter((card) =>
    [card.episodeNumber, card.episodeTitle, card.note]
      .filter((value) => value != null)
      .join(" ")
      .toLocaleLowerCase("th")
      .includes(query)
  );
}

export function sortPacksByEpisode<T extends { episodeNumber?: string | null }>(cards: T[]): T[] {
  return cards
    .slice()
    .sort((left, right) =>
      String(left.episodeNumber ?? "").localeCompare(String(right.episodeNumber ?? ""), "th", {
        numeric: true,
      })
    );
}
