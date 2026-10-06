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

/**
 * IPE-065: distinguishes "the evidence row is loaded from a successful
 * server projection" from "the projection has not produced a row (yet)".
 * A card WITHOUT a row is never treated as a genuine not_checked — it is
 * either still loading (query in flight for its scope) or unknown
 * (unavailable: query error / scope never fetched), both fail-closed.
 */
export type StoryEvidenceState = "loaded" | "loading" | "unavailable";

export type StoryPackStatus =
  | "published"
  | "passed"
  | "needs_fix"
  | "anomalous"
  | "not_checked"
  | "loading"
  | "unknown";

/**
 * IPE-065: success-path status mapping — UNCHANGED. Only a loaded evidence
 * row may map to published/passed/needs_fix/anomalous/not_checked; a query
 * error inside the row itself keeps the anomalous (fail-closed) branch.
 */
export function derivePackStatus(evidence: StoryEvidence | null | undefined): StoryPackStatus {
  if (!evidence) return "not_checked";
  if (evidence.available === false) return "anomalous";
  if (evidence.published) return "published";
  if (evidence.checker) return "passed";
  if (evidence.checkerRan) return "needs_fix";
  return "not_checked";
}

/**
 * IPE-065: card-level status — wraps the success-path mapper with the
 * progressive-loading contract. Without a loaded evidence row the status is
 * neutral (loading/unknown) and NEVER a positive/checked state; an absent
 * evidenceState signal is treated as unavailable (fail closed), never PASS.
 */
export function derivePackCardStatus(card: {
  evidence?: StoryEvidence | null;
  evidenceState?: StoryEvidenceState;
}): StoryPackStatus {
  if (card.evidence) return derivePackStatus(card.evidence);
  if (card.evidenceState === "loading") return "loading";
  return "unknown";
}

export const STORY_PACK_STATUS_LABEL: Record<StoryPackStatus, string> = {
  published: "ลงแล้ว",
  passed: "ผ่าน",
  needs_fix: "ต้องแก้",
  anomalous: "ผิดปกติ",
  not_checked: "ยังไม่ตรวจ",
  loading: "กำลังโหลด",
  unknown: "ไม่ทราบสถานะ",
};

export interface StoryPackSummary {
  total: number;
  published: number;
  passed: number;
  needsFix: number;
  anomalous: number;
  /** Success-path only: the row loaded and the checker genuinely never ran. */
  notChecked: number;
  /** IPE-065: neutral bucket — no loaded row (loading or unavailable). */
  unknown: number;
}

export function summarizeStoryPacks(
  cards: Array<{ evidence?: StoryEvidence | null; evidenceState?: StoryEvidenceState }>
): StoryPackSummary {
  const summary: StoryPackSummary = {
    total: cards.length,
    published: 0,
    passed: 0,
    needsFix: 0,
    anomalous: 0,
    notChecked: 0,
    unknown: 0,
  };
  for (const card of cards) {
    switch (derivePackCardStatus(card)) {
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
      case "not_checked":
        summary.notChecked += 1;
        break;
      default:
        // loading/unknown — neutral, never counted toward any checked state.
        summary.unknown += 1;
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
  // IPE-065: unknown/loading packs keep the story neutral in-progress — an
  // unloaded or unavailable projection can never roll up to passed/published.
  if (summary.unknown > 0) return "in_progress";
  if (summary.notChecked > 0) return "in_progress";
  if (summary.published === summary.total) return "published";
  return "passed";
}

/**
 * IPE-065R1 (P2): the story-card footer must never say "ผ่าน" while any pack's
 * status projection is still loading/unavailable — a genuine PASS/PUBLISHED
 * line requires the rollup to BE passed/published with zero neutral packs.
 */
export function storyOverviewFooterLine(input: {
  focused: boolean;
  summary: StoryPackSummary;
  overall: StoryOverallStatus;
}): string {
  if (input.focused) return "กำลังทำงานอยู่ — state ของเรื่องนี้ถูกจำไว้";
  if (input.summary.needsFix + input.summary.anomalous > 0) {
    return `มีงานรอแก้ ${input.summary.needsFix + input.summary.anomalous} แพ็ก`;
  }
  if (input.summary.unknown > 0) return `รอสถานะ ${input.summary.unknown} แพ็ก`;
  if (input.summary.notChecked > 0) return `ยังไม่ตรวจ ${input.summary.notChecked} แพ็ก`;
  if (input.overall === "published") return STORY_PACK_STATUS_LABEL.published;
  if (input.overall === "passed") return STORY_PACK_STATUS_LABEL.passed;
  return "กำลังดำเนินการ";
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

// ---------------------------------------------------------------------------
// IPE-062R3 (P2-A): the daily story model must cover EVERY story in the
// workspace — stories that only have packs, NEW_STORY stories, and bound
// novels that have no Episode Pack yet. Groups are keyed by storyKeyFor and
// seeded from the workspace's bound novels so zero-pack stories stay visible
// and focusable. Cards whose workspaceNovelId is missing still merge into
// their novel's seeded group via a novel-id alias.
// ---------------------------------------------------------------------------

export interface StoryGroupInputCard {
  workspaceNovelId?: number | null;
  novel?: { id?: number | null; title?: string | null } | null;
}

export interface StoryGroup<T extends StoryGroupInputCard = StoryGroupInputCard> {
  workspaceNovelId: number | null;
  novel: { id?: number | null; title?: string | null } | null;
  cards: T[];
}

export function groupStoriesByNovel<T extends StoryGroupInputCard>(
  cards: T[],
  boundNovels: Array<{ workspaceNovel?: { id?: number | null } | null; novel?: { id?: number | null; title?: string | null } | null }> = []
): Array<StoryGroup<T>> {
  const groups = new Map<string, StoryGroup<T>>();
  const aliasByNovelId = new Map<number, string>();
  const registerAlias = (novelId: unknown, key: string) => {
    const id = Number(novelId);
    if (Number.isFinite(id) && !aliasByNovelId.has(id)) aliasByNovelId.set(id, key);
  };

  for (const { workspaceNovel, novel } of boundNovels) {
    const key = storyKeyFor(workspaceNovel?.id, novel?.id);
    if (!groups.has(key)) {
      groups.set(key, {
        workspaceNovelId: workspaceNovel?.id ?? null,
        novel: novel ?? null,
        cards: [],
      });
    }
    registerAlias(novel?.id, key);
  }

  for (const card of cards) {
    const key = storyKeyFor(card.workspaceNovelId, card.novel?.id);
    let group = groups.get(key);
    if (!group) {
      const novelId = Number(card.novel?.id);
      const aliasKey = Number.isFinite(novelId) ? aliasByNovelId.get(novelId) : undefined;
      if (aliasKey && groups.has(aliasKey)) {
        group = groups.get(aliasKey)!;
        groups.set(key, group);
      } else {
        group = {
          workspaceNovelId: card.workspaceNovelId ?? null,
          novel: card.novel ?? null,
          cards: [],
        };
        groups.set(key, group);
        registerAlias(card.novel?.id, key);
      }
    }
    group.cards.push(card);
  }

  return Array.from(new Set(groups.values())).sort((left, right) =>
    String(left.novel?.title ?? "").localeCompare(String(right.novel?.title ?? ""), "th")
  );
}

// ---------------------------------------------------------------------------
// IPE-062R3 (P2-B): runtime save-identity invariant. The editor target's
// draft must BE the currently selected pack's latest draft before any save
// mutation fires. The selected pack's draft id comes from the selection-keyed
// source-draft query, so a pack switch makes every older editor target
// mismatch — mismatch means DO NOT SAVE (fail closed), independent of the
// UI guard.
// ---------------------------------------------------------------------------

export function editorDraftBelongsToSelectedPack(
  targetDraftId: unknown,
  selectedLatestDraftId: unknown
): boolean {
  if (targetDraftId == null || selectedLatestDraftId == null) return false;
  const target = Number(targetDraftId);
  const selected = Number(selectedLatestDraftId);
  return (
    Number.isFinite(target) &&
    Number.isFinite(selected) &&
    target > 0 &&
    selected > 0 &&
    target === selected
  );
}
