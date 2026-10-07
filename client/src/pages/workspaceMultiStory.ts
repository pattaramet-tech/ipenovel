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

// ---------------------------------------------------------------------------
// IPE-065R2 — invalidation tombstone fence (pure, testable).
//
// Once an evidence-changing mutation succeeds for workItem X, NO evidence row
// obtained before that mutation may become authoritative again — even when
// X's story is inactive, an old request finishes late, React Query still
// holds fresh cached data under staleTime, or the post-mutation refetch
// fails. The fence is a per-workItemId tombstone set; the generic cache merge
// skips tombstoned ids, scope activation with tombstoned ids forces a network
// reconciliation, and only a SUCCESSFUL post-fence fetch that RETURNS the id
// may merge the fresh row and release the tombstone.
// ---------------------------------------------------------------------------

export interface EvidenceRowLike {
  workItemId?: number | null;
}

function evidenceRowId(row: EvidenceRowLike): number | null {
  const id = Number(row?.workItemId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Generic cache merge behind the fence: rows whose workItemId is tombstoned
 * are NEVER merged (their cached values predate a mutation), while unrelated
 * rows — including other stories' cached evidence — merge normally and are
 * never removed. Returns null when nothing changed so callers can bail out
 * of the state update (no render churn).
 */
export function mergeEvidenceRowsSkippingInvalidated<TRow extends EvidenceRowLike>(
  current: ReadonlyMap<number, TRow>,
  queryRows: readonly TRow[] | null | undefined,
  invalidatedIds: ReadonlySet<number>
): Map<number, TRow> | null {
  if (!queryRows?.length) return null;
  let next: Map<number, TRow> | null = null;
  for (const row of queryRows) {
    const id = evidenceRowId(row);
    if (id == null || invalidatedIds.has(id)) continue;
    if (!next) next = new Map(current);
    next.set(id, row);
  }
  return next;
}

/**
 * Tombstoned ids present in a POST-fence successful fetch result — exactly
 * those may be merged as fresh server authority and released from the fence.
 * An id absent from the result keeps its tombstone (fail closed).
 */
export function reconcilableEvidenceIds(
  invalidatedIds: ReadonlySet<number>,
  queryRows: readonly EvidenceRowLike[] | null | undefined
): number[] {
  if (!invalidatedIds.size || !queryRows?.length) return [];
  const present: number[] = [];
  for (const row of queryRows) {
    const id = evidenceRowId(row);
    if (id != null && invalidatedIds.has(id)) present.push(id);
  }
  return present;
}

/**
 * Whether an activated scope contains tombstoned ids — staleTime must not
 * suppress reconciliation for those.
 */
export function scopeNeedsReconciliation(
  scopeIds: readonly number[],
  invalidatedIds: ReadonlySet<number>
): boolean {
  return scopeIds.some((id) => invalidatedIds.has(id));
}

// ---------------------------------------------------------------------------
// IPE-065R3 — generation-bound reconciliation authority.
//
// A wall-clock "data completed after invalidation" comparison is NOT a
// freshness authority (a pre-mutation request may complete after the
// mutation). Freshness is: EXPLICIT PER-WORKITEM INVALIDATION GENERATION +
// an explicit reconciliation request whose captured generation snapshot still
// matches at completion. Completion timestamps and React Query `.data`
// references are never authority.
// ---------------------------------------------------------------------------

/**
 * Monotonic per-workItem generation bump on every evidence-changing
 * invalidation of that id.
 */
export function bumpEvidenceGenerations(
  generations: ReadonlyMap<number, number>,
  ids: readonly number[]
): Map<number, number> {
  const next = new Map(generations);
  for (const id of ids) {
    next.set(id, (next.get(id) ?? 0) + 1);
  }
  return next;
}

/** Snapshot the captured generations for the reconciliation targets. */
export function captureEvidenceGenerations(
  generations: ReadonlyMap<number, number>,
  ids: readonly number[]
): Map<number, number> {
  const snapshot = new Map<number, number>();
  for (const id of ids) {
    snapshot.set(id, generations.get(id) ?? 0);
  }
  return snapshot;
}

/**
 * Which tombstoned target ids may be reconciled by a successful reconciliation
 * response, under the generation fence:
 * 1. the id was one of the captured targets,
 * 2. its CURRENT generation still equals the captured generation (no newer
 *    mutation happened while the request was in flight),
 * 3. it is still tombstoned,
 * 4. the fresh result actually contains it.
 * Everything else — including a generation-bumped id — is rejected: its row
 * is not applied and its (newer) tombstone is not cleared.
 */
export function acceptedReconciliationIds(
  capturedGenerations: ReadonlyMap<number, number>,
  currentGenerations: ReadonlyMap<number, number>,
  stillInvalidated: ReadonlySet<number>,
  freshRows: readonly EvidenceRowLike[] | null | undefined
): number[] {
  if (!capturedGenerations.size || !freshRows?.length) return [];
  const present = new Set<number>();
  for (const row of freshRows) {
    const id = evidenceRowId(row);
    if (id != null) present.add(id);
  }
  const accepted: number[] = [];
  for (const [id, capturedGeneration] of Array.from(capturedGenerations.entries())) {
    if (currentGenerations.get(id) !== capturedGeneration) continue;
    if (!stillInvalidated.has(id)) continue;
    if (!present.has(id)) continue;
    accepted.push(id);
  }
  return accepted;
}

/** The fresh rows belonging exactly to the accepted reconciliation ids. */
export function acceptedReconciliationRows<TRow extends EvidenceRowLike>(
  freshRows: readonly TRow[] | null | undefined,
  acceptedIds: ReadonlySet<number>
): TRow[] {
  if (!freshRows?.length || !acceptedIds.size) return [];
  return freshRows.filter((row) => {
    const id = evidenceRowId(row);
    return id != null && acceptedIds.has(id);
  });
}

// ---------------------------------------------------------------------------
// IPE-065R4 — workspace ABA lifecycle epoch.
//
// workspaceId + reused generation value do NOT prove the same workspace
// LIFECYCLE (leave A → return A → generation restarts from 1). Every
// workspace identity transition rotates a monotonic EPOCH that never resets;
// a reconciliation captures the epoch at creation and its response is
// accepted only when BOTH the workspace id AND the epoch still match.
// ---------------------------------------------------------------------------

export interface EvidenceWorkspaceIdentity {
  workspaceId: number | null | undefined;
  epoch: number;
}

/**
 * Deterministic epoch rotation: the same workspace keeps its identity object
 * (and epoch); ANY workspace identity change advances the epoch by exactly
 * one, synchronously with the rendered selection — an async acceptance can
 * never observe a returned-to-A workspace carrying A's old epoch.
 */
export function nextEvidenceWorkspaceIdentity(
  current: EvidenceWorkspaceIdentity,
  workspaceId: number | null | undefined
): EvidenceWorkspaceIdentity {
  if (current.workspaceId === workspaceId) return current;
  return { workspaceId, epoch: current.epoch + 1 };
}

/** Lifecycle acceptance: id AND epoch must both match — A(epoch1) != A(epoch3). */
export function sameEvidenceWorkspaceLifecycle(
  identity: EvidenceWorkspaceIdentity,
  workspaceId: number,
  epoch: number
): boolean {
  return identity.workspaceId === workspaceId && identity.epoch === epoch;
}

/**
 * Coalescing identity — the epoch is part of the key, so an old lifecycle can
 * never collide with a new one merely because generation counters restarted:
 * 7@1:101@1 != 7@3:101@1.
 */
export function buildEvidenceReconciliationKey(
  workspaceId: number,
  epoch: number,
  targets: readonly number[],
  generations: ReadonlyMap<number, number>
): string {
  const pairs = targets.map((id) => `${id}@${generations.get(id) ?? 0}`);
  return `${workspaceId}@${epoch}:${pairs.join(",")}`;
}

/**
 * Ownership-safe registry cleanup: a settling promise may remove its registry
 * entry ONLY while the registry still points at THAT exact promise — an old
 * promise settling late must never delete a newer reconciliation's entry.
 * Returns true when the entry was removed.
 */
export function releaseOwnedReconciliationEntry(
  registry: Map<string, Promise<unknown>>,
  key: string,
  promise: Promise<unknown>
): boolean {
  if (registry.get(key) !== promise) return false;
  registry.delete(key);
  return true;
}

// ---------------------------------------------------------------------------
// IPE-065R5 — lifecycle-tagged evidence state.
//
// The workspace-transition cleanup must never erase CURRENT-lifecycle work:
// a delayed passive reset running after a new-lifecycle mutation once wiped
// fresh tombstones/generations and let staleTime-fresh cached PASS become
// authoritative again. All mutable evidence authority now lives in ONE
// container tagged with its workspace epoch; the container is rotated
// SYNCHRONOUSLY with the workspace identity (so old rows are non-
// authoritative from the very first new-lifecycle render), and the delayed
// cleanup is reduced to a lifecycle-selective registry prune that cannot
// touch current-epoch entries.
// ---------------------------------------------------------------------------

export interface EvidenceLifecycleState {
  epoch: number;
  rows: Map<number, any>;
  invalidatedIds: Set<number>;
  generations: Map<number, number>;
}

/**
 * Lifecycle rotation: the state tagged with the CURRENT epoch is returned
 * unchanged (new-lifecycle work survives); anything from an older epoch is
 * replaced by a fresh empty container for the new epoch. This replaces the
 * old unconditional passive reset — it runs synchronously with the identity
 * rotation, leaving no delayed authority that could wipe newer work.
 */
export function rotateEvidenceLifecycleState(
  state: EvidenceLifecycleState,
  epoch: number
): EvidenceLifecycleState {
  if (state.epoch === epoch) return state;
  return { epoch, rows: new Map(), invalidatedIds: new Set(), generations: new Map() };
}

/**
 * Record evidence-invalidating mutations that completed for a workspace the
 * operator has ALREADY left — those stale identities stay fenced when that
 * workspace is re-entered (they seed the new lifecycle's tombstones).
 */
export function recordInvalidEvidenceForWorkspace(
  byWorkspace: Map<number, Set<number>>,
  workspaceId: number,
  ids: readonly number[]
): Map<number, Set<number>> {
  if (!ids.length) return byWorkspace;
  const bucket = new Set(byWorkspace.get(workspaceId) ?? []);
  for (const id of ids) bucket.add(id);
  byWorkspace.set(workspaceId, bucket);
  return byWorkspace;
}

/** Tombstones recorded for a workspace while it was away (empty if none). */
export function invalidatedIdsForWorkspace(
  byWorkspace: Map<number, Set<number>>,
  workspaceId: number
): Set<number> {
  return byWorkspace.get(workspaceId) ?? new Set();
}

/**
 * Lifecycle-selective registry prune: drop coalescing entries whose key does
 * not belong to the CURRENT lifecycle (`workspaceId@epoch:...`). Current-
 * lifecycle entries (registered by a fast mutation racing the transition)
 * SURVIVE; old-epoch and other-workspace entries cannot coalesce with new
 * requests and are removed. Returns the number of removed entries.
 */
export function pruneEvidenceRegistryForLifecycle(
  registry: Map<string, Promise<unknown>>,
  workspaceId: number,
  epoch: number
): number {
  const currentPrefix = `${workspaceId}@${epoch}:`;
  let removed = 0;
  for (const key of Array.from(registry.keys())) {
    if (!key.startsWith(currentPrefix)) {
      registry.delete(key);
      removed += 1;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// IPE-065R8A — progressive background story status hydration.
//
// The active story loads its evidence projection first (Priority 1, the
// existing scoped query); every OTHER story with Episode Packs hydrates its
// own story-scoped projection afterwards, one at a time (bounded, Priority
// 2), so the Story Overview converges to real statuses WITHOUT interaction —
// without ever reintroducing a full-workspace evidence request. Hydration is
// DATA-only: it never changes navigation/selection.
// ---------------------------------------------------------------------------

export type StoryHydrationStatus = "loading" | "loaded" | "failed";

export interface StoryHydrationState {
  epoch: number;
  statuses: Map<string, StoryHydrationStatus>;
}

/** Same rotation contract as the evidence container: new epoch = fresh state. */
export function rotateStoryHydrationState(
  state: StoryHydrationState,
  epoch: number
): StoryHydrationState {
  if (state.epoch === epoch) return state;
  return { epoch, statuses: new Map() };
}

export interface BackgroundHydrationGroup {
  key: string;
  workItemIds: number[];
}

/**
 * Bounded background queue for the CURRENT workspace lifecycle, in
 * deterministic order:
 * - the ACTIVE story is excluded (Priority 1 — it loads through the existing
 *   scoped query and must never wait behind the queue),
 * - stories already in a hydration state (loading/loaded/failed) are excluded
 *   (no duplicate work; a failed story is skipped this lifecycle and may be
 *   retried later through the active-story path),
 * - zero-pack stories cannot have evidence and are skipped.
 * Input order is preserved so the queue is deterministic.
 */
export function buildBackgroundHydrationQueue(input: {
  activeStoryKey: string | null;
  statuses: ReadonlyMap<string, StoryHydrationStatus>;
  groups: ReadonlyArray<BackgroundHydrationGroup>;
}): BackgroundHydrationGroup[] {
  const queue: BackgroundHydrationGroup[] = [];
  for (const group of input.groups) {
    if (input.activeStoryKey != null && group.key === input.activeStoryKey) continue;
    if (input.statuses.has(group.key)) continue;
    if (!group.workItemIds.length) continue;
    queue.push({ key: group.key, workItemIds: [...group.workItemIds] });
  }
  return queue;
}

// ---------------------------------------------------------------------------
// IPE-065R8B — lifecycle-owned background hydration lock + board-removal
// guard. The single-flight marker is bound to the workspace LIFECYCLE
// (id + epoch) and the exact request instance (monotonic requestId): an
// old lifecycle's in-flight request NEVER blocks a new lifecycle's queue,
// and its settlement releases ONLY its own owner record. Background
// responses may merge only rows still present on the CURRENT board, so a
// removed workItem/story can never re-enter lifecycle evidence authority.
// ---------------------------------------------------------------------------

export interface BackgroundHydrationOwner {
  workspaceId: number;
  epoch: number;
  storyKey: string;
  /** Monotonic, non-reused request instance identity. */
  requestId: number;
}

/**
 * Concurrency gate: ONLY a background hydration owned by the CURRENT
 * lifecycle (same workspace id AND same epoch) blocks the runner. An old
 * lifecycle's in-flight request is non-authoritative and does not count
 * against the new lifecycle's concurrency.
 */
export function backgroundHydrationOwnerBlocksCurrentLifecycle(
  owner: BackgroundHydrationOwner | null | undefined,
  workspaceId: number,
  epoch: number
): boolean {
  return (
    owner != null && owner.workspaceId === workspaceId && owner.epoch === epoch
  );
}

/**
 * Ownership-safe release: a settling request clears the owner record ONLY if
 * the current owner is still ITSELF (requestId identity); an old request
 * settling late can never release a newer lifecycle's owner. Returns the
 * owner to store (null when released, unchanged otherwise).
 */
export function releaseOwnedBackgroundHydration(
  current: BackgroundHydrationOwner | null,
  settled: BackgroundHydrationOwner
): BackgroundHydrationOwner | null {
  return current != null && current.requestId === settled.requestId
    ? null
    : current;
}

/**
 * Board-removal guard: a background response may only contribute rows whose
 * workItem is still present on the CURRENT board. Rows for removed
 * workItems/stories are discarded BEFORE the tombstone-fenced merge, so the
 * lifecycle evidence container never regains removed rows. (Tombstones are
 * applied separately by the merge — this filter never bypasses them.)
 */
export function filterEvidenceRowsToCurrentBoard<TRow extends EvidenceRowLike>(
  rows: readonly TRow[] | null | undefined,
  currentBoardWorkItemIds: ReadonlySet<number>
): TRow[] {
  if (!rows?.length) return [];
  return rows.filter((row) => {
    const id = evidenceRowId(row);
    return id != null && currentBoardWorkItemIds.has(id);
  });
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
