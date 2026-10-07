import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAdminGuard } from "@/hooks/useAdminGuard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { summarizeEditorialDraftTabs } from "./workspaceEditorialDraftSummary";
import { WorkspaceEditorialToolbar } from "./WorkspaceEditorialToolbar";
import { WorkspaceNovelExportDialog } from "./WorkspaceNovelExportDialog";
import { WorkspaceStoryOverview } from "./WorkspaceStoryOverview";
import { WorkspacePackListPanel } from "./WorkspacePackListPanel";
import { WorkspaceReviewSummaryPanel } from "./WorkspaceReviewSummaryPanel";
import { WorkspaceActionBar } from "./WorkspaceActionBar";
import { WorkspaceFindingActions } from "./WorkspaceFindingActions";
import {
  acceptedReconciliationIds,
  acceptedReconciliationRows,
  backgroundHydrationOwnerBlocksCurrentLifecycle,
  buildBackgroundHydrationQueue,
  buildEvidenceReconciliationKey,
  bumpEvidenceGenerations,
  captureEvidenceGenerations,
  derivePackStatus,
  editorDraftBelongsToSelectedPack,
  filterEvidenceRowsToCurrentBoard,
  groupStoriesByNovel,
  mergeEvidenceRowsSkippingInvalidated,
  invalidatedIdsForWorkspace,
  nextEvidenceWorkspaceIdentity,
  pruneEvidenceRegistryForLifecycle,
  recordInvalidEvidenceForWorkspace,
  releaseOwnedBackgroundHydration,
  releaseOwnedReconciliationEntry,
  resolveStoryUiState,
  rotateEvidenceLifecycleState,
  rotateStoryHydrationState,
  sameEvidenceWorkspaceLifecycle,
  scopeNeedsReconciliation,
  sortPacksByEpisode,
  storyKeyFor,
  storyOverallStatus,
  summarizeStoryPacks,
  updateStoryUiState,
  type BackgroundHydrationOwner,
  type EvidenceLifecycleState,
  type EvidenceWorkspaceIdentity,
  type StoryHydrationState,
  type StoryPackTab,
  type StoryUiState,
} from "./workspaceMultiStory";
import {
  chapterEditorFindingRanges,
  chapterEditorIssues,
  chapterEditorMatchesFilter,
  chapterEditorStructuralRepairGuidance,
  chapterEditorTabStatus,
  parseChapterEditorPasteText,
} from "./workspaceChapterEditor";
import {
  applyChapterCanvasChange,
  chapterCanvasFindingRange,
  createChapterCanvasHistory,
  pushChapterCanvasHistory,
  redoChapterCanvas,
  serializeChapterCanvasForSave,
  serializeChapterCanvasText,
  undoChapterCanvas,
  type ChapterCanvasHistory,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

function formatDate(value: unknown) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("th-TH");
}

function shortHash(value: unknown) {
  if (!value) return "—";
  const text = String(value);
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function compactTabTitles(rows: Array<{ title: string }>, limit = 6) {
  const shown = rows.slice(0, limit).map(row => row.title);
  const remainder = rows.length - shown.length;
  return remainder > 0
    ? `${shown.join(", ")} และอีก ${remainder}`
    : shown.join(", ");
}

function StatusPill({ value }: { value: unknown }) {
  return (
    <span className="inline-flex rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
      {String(value ?? "unknown")}
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{children}</p>;
}

function editorialTabText(tab: any) {
  return (tab?.paragraphs ?? []).map((paragraph: any) => String(paragraph.text ?? "")).join("\n\n");
}

// IPE-058-C: the editor state IS the canvas paragraph model now.
type ChapterEditorParagraphState = ChapterCanvasParagraph;

function chapterEditorClipboardParagraphs(data: DataTransfer) {
  const html = data.getData("text/html");
  if (html && typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    const selector = "p,li,h1,h2,h3,h4,h5,h6,blockquote,div";
    const blocks = Array.from(document.body.querySelectorAll(selector)).filter(
      element => !Array.from(element.children).some(child => child.matches(selector))
    );
    const texts = blocks
      .flatMap(element => parseChapterEditorPasteText(element.textContent ?? ""))
      .filter(Boolean);
    if (texts.length) return texts;
  }
  return parseChapterEditorPasteText(data.getData("text/plain"));
}

/**
 * IPE-058-C: single continuous editing surface. ONE textarea over the flat
 * canvas text with an overlay <pre> for finding highlights — no per-paragraph
 * textareas. The paragraph-aware model lives in workspaceChapterCanvas.ts and
 * is applied on every change; the save boundary stays the replace_tab Draft
 * command with explicit paragraph identity.
 */
function ChapterEditorCanvas({
  value,
  flatFindings,
  highlight,
  disabled,
  placeholder,
  textareaRef,
  onChange,
  onKeyDown,
  onPaste,
}: {
  value: string;
  flatFindings: Array<{ startOffset: number; endOffset: number; token: string }>;
  highlight: boolean;
  disabled: boolean;
  placeholder?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string, caret: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  // IPE-062R4E: the canvas must grow with its content. The scrollable
  // ancestor (chapterEditorScrollRef) is the single scroller, and the
  // highlight overlay (absolute inset-0) then stays aligned with the text
  // at every scroll position — a fixed-height textarea would clip the
  // overlay and desync it while its internal scroll moves.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value, textareaRef]);
  const ranges = useMemo(
    () => (highlight ? chapterEditorFindingRanges(value, flatFindings) : []),
    [highlight, value, flatFindings]
  );
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(value.slice(cursor, range.start));
    }
    parts.push(
      <mark
        key={`${range.start}:${range.end}:${index}`}
        className="rounded-sm bg-yellow-300/70 text-transparent"
      >
        {value.slice(range.start, range.end)}
      </mark>
    );
    cursor = range.end;
  });
  parts.push(value.slice(cursor));

  return (
    <div className="relative min-h-[28rem]">
      <pre
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 font-sans text-base leading-8 text-transparent"
      >
        {parts}
        {"\n"}
      </pre>
      <textarea
        ref={textareaRef}
        id="workspace-chapter-editor-canvas"
        aria-label="Chapter editor — พื้นที่แก้ไขบทต่อเนื่อง หนึ่งย่อหน้าต่อหนึ่งย่อหน้าข้อความ"
        rows={14}
        spellCheck={false}
        className="relative z-10 block min-h-[28rem] w-full resize-none bg-transparent px-3 py-3 font-sans text-base leading-8 outline-none focus:bg-muted/20"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value, event.target.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    </div>
  );
}


export default function WorkspacePage() {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number>();
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // IPE-064: story gate — the 4-pane daily work area opens only after a
  // story is focused; "ย้อนกลับ เลือกเรื่อง" returns to the story picker.
  const [storyEntered, setStoryEntered] = useState(false);
  // IPE-060: master-detail — which pane of the Episode Pack Detail is shown.
  const [packDetailTab, setPackDetailTab] = useState<"editor" | "qc" | "stage" | "publish">("editor");
  // IPE-062: multi-story state — each story (novel) keeps its own focused
  // pack, open chapter, detail tab and issues-only filter, so the operator
  // can park one story, work on another, and come back without losing
  // context. Server queries stay keyed to the single selected work item.
  const [selectedStoryKey, setSelectedStoryKey] = useState<string | null>(null);
  const [storyUiStates, setStoryUiStates] = useState<Record<string, StoryUiState>>({});
  const [selectedSourceWorkItemId, setSelectedSourceWorkItemId] = useState<number>();
  const [selectedEditorialWorkItemIds, setSelectedEditorialWorkItemIds] = useState<number[]>([]);
  const [chapterEditorTarget, setChapterEditorTarget] = useState<{
    sourceTabId: string;
    title: string;
    expectedTabStructuralSha256: string;
    expectedText: string;
    draftId: number;
    draftVersion: number;
    draftSha256: string;
  }>();
  const [chapterEditorParagraphs, setChapterEditorParagraphs] = useState<ChapterEditorParagraphState[]>([]);
  const chapterEditorParagraphSequence = useRef(0);
  const chapterEditorScrollRef = useRef<HTMLDivElement>(null);
  const chapterEditorCanvasRef = useRef<HTMLTextAreaElement | null>(null);
  const chapterEditorHistoryRef = useRef<ChapterCanvasHistory>(
    createChapterCanvasHistory()
  );
  const [chapterEditorIssueIndex, setChapterEditorIssueIndex] = useState(0);
  const [chapterEditorTabFilter, setChapterEditorTabFilter] = useState<
    "all" | "issue" | "unedited" | "edited"
  >("all");
  const chapterEditorScrollByTab = useRef(new Map<string, number>());
  // Canvas display text: raw join so typing whitespace is never snapped back.
  const chapterEditorText = useMemo(
    () => serializeChapterCanvasText(chapterEditorParagraphs),
    [chapterEditorParagraphs]
  );
  // Save projection: trimmed paragraphs + aligned explicit identity list
  // (IPE-058-C replace_tab identity contract).
  const chapterEditorSaveProjection = useMemo(
    () => serializeChapterCanvasForSave(chapterEditorParagraphs),
    [chapterEditorParagraphs]
  );
  const chapterEditorDirty = Boolean(
    chapterEditorTarget &&
      chapterEditorSaveProjection.text !== chapterEditorTarget.expectedText
  );
  const [chapterEditorHighlight, setChapterEditorHighlight] = useState(true);
  const ensuredEditorialWorkspaces = useRef(new Set<number>());
  const { isAdmin, loading: adminLoading } = useAdminGuard();
  // IPE-064R4B round 31 (P1): programmatic intake navigation after the
  // dirty-editor boundary (Wouter's existing navigation API).
  const [, navigateIntake] = useLocation();

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAdmin });
  const detail = trpc.workspace.detail.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  // IPE-064R3: export covers the ENTIRE novel catalog (same list as the
  // intake selector / /novels) — the exporter reads published episodes by
  // novelId behind an admin gate, so no workspace binding is required.
  const exportNovelCatalog = trpc.workspace.bindings.availablePublicationNovels.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const exportNovelOptions = ((exportNovelCatalog.data as any[] | undefined) ?? [])
    .map((novel: any) => ({ novelId: novel.id as number, novelTitle: String(novel.title ?? "") }));
  const editorialBoard = trpc.workspace.editorial.board.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId),
      // IPE-065 (D): event-driven refresh — the unconditional 30s heavy
      // polling and the forced refetch on every mount/focus are gone. With a
      // 30s staleTime, remounts and window focus reuse recent data and
      // refetch only when the cached board is older; every board/evidence
      // mutation already refetches through its own onSuccess, so an idle
      // workspace issues no background heavy refresh at all.
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
    }
  );
  const editorialEvidenceWorkItemIds = (((editorialBoard.data as any)?.columns ?? []) as any[])
    .flatMap((column: any) => column.cards ?? [])
    .map((card: any) => card.workItemId)
    .filter((id: any): id is number => Number.isInteger(id) && id > 0);
  // IPE-065R8B (§9): CURRENT board membership source for the background
  // hydration result guard — refreshed every render, never a stale captured
  // pre-request snapshot.
  const editorialEvidenceWorkItemIdsRef = useRef(editorialEvidenceWorkItemIds);
  editorialEvidenceWorkItemIdsRef.current = editorialEvidenceWorkItemIds;
  // IPE-065 (C): the heavyweight evidence projection is SCOPED to the active
  // story's packs instead of every work item on the board. The scope is held
  // in state (stable reference while the story's pack set is unchanged) so
  // the query key only changes when the story actually changes — switching
  // stories fetches that story's projection, and React Query's cache keeps
  // previously loaded stories (staleTime below avoids needless refires).
  const [activeEvidenceScopeIds, setActiveEvidenceScopeIds] = useState<number[]>([]);
  const activeEvidenceScopeIdsKey = activeEvidenceScopeIds.join(",");
  const activeEvidenceScopeSet = useMemo(
    () => new Set(activeEvidenceScopeIds),
    [activeEvidenceScopeIdsKey]
  );
  const editorialEvidenceStatuses = trpc.workspace.editorial.evidenceStatuses.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, workItemIds: activeEvidenceScopeIds },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId) && activeEvidenceScopeIds.length > 0,
      retry: false,
      staleTime: 30_000,
      refetchIntervalInBackground: false,
    }
  );
  // IPE-065R5: ALL mutable evidence authority lives in ONE lifecycle-tagged
  // container (epoch + rows + tombstones + generations). It is rotated
  // SYNCHRONOUSLY with the workspace identity below — the old unconditional
  // passive reset effect is GONE, because a delayed reset running after a
  // new-lifecycle mutation erased fresh tombstones/generations and let
  // staleTime-fresh cached PASS become authoritative again. React state only
  // mirrors a revision counter that triggers re-renders when the container
  // mutates.
  const evidenceLifecycleRef = useRef<EvidenceLifecycleState>({
    epoch: 0,
    rows: new Map(),
    invalidatedIds: new Set(),
    generations: new Map(),
  });
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const bumpEvidenceRevision = () => setEvidenceRevision((revision) => revision + 1);
  // IPE-065R5 (§12): stale identities from mutations that completed for a
  // workspace the operator already left — seeded as tombstones when that
  // workspace is re-entered, so its cached evidence cannot resurrect.
  const invalidEvidenceByWorkspaceRef = useRef(new Map<number, Set<number>>());
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  selectedWorkspaceIdRef.current = selectedWorkspaceId;
  // IPE-065R4: workspace LIFECYCLE identity — a monotonic epoch rotated
  // SYNCHRONOUSLY during render whenever the selected workspace changes, so
  // the epoch can never lag behind the workspace identity visible to async
  // acceptance (no render/effect gap: A→B→A makes A(epoch1) != A(epoch3)
  // even though generation counters restart). The epoch itself never resets.
  const evidenceWorkspaceIdentityRef = useRef<EvidenceWorkspaceIdentity>({
    workspaceId: selectedWorkspaceId,
    epoch: 0,
  });
  evidenceWorkspaceIdentityRef.current = nextEvidenceWorkspaceIdentity(
    evidenceWorkspaceIdentityRef.current,
    selectedWorkspaceId
  );
  // IPE-065R5 (§4/§8): rotate the lifecycle container in the same
  // synchronous pass — from the FIRST new-lifecycle render, old-epoch rows
  // are non-authoritative (the container is fresh/empty) and old
  // tombstones/generations cannot contaminate the new lifecycle. Tombstones
  // recorded for THIS workspace by mutations that completed while it was
  // away are re-seeded so their stale evidence stays fenced.
  evidenceLifecycleRef.current = rotateEvidenceLifecycleState(
    evidenceLifecycleRef.current,
    evidenceWorkspaceIdentityRef.current.epoch
  );
  // IPE-065R8A: background story-status hydration state — epoch-tagged and
  // rotated with the same synchronous identity pass (a new workspace
  // lifecycle starts with an empty hydration ledger).
  const storyHydrationRef = useRef<StoryHydrationState>({
    epoch: evidenceWorkspaceIdentityRef.current.epoch,
    statuses: new Map(),
  });
  if (storyHydrationRef.current.epoch !== evidenceWorkspaceIdentityRef.current.epoch) {
    storyHydrationRef.current = rotateStoryHydrationState(
      storyHydrationRef.current,
      evidenceWorkspaceIdentityRef.current.epoch
    );
  }
  // IPE-065R8A/R8B: the story currently hydrating in the background. The
  // single-flight marker is LIFECYCLE-OWNED: { workspaceId, epoch, storyKey,
  // requestId } — an old lifecycle's in-flight request never blocks a new
  // lifecycle's queue, and its settlement releases ONLY its own record.
  // The state mirrors the ref for rendering; the ref is the immediate
  // authority for the runner and the async settle path.
  const [backgroundHydrationOwner, setBackgroundHydrationOwner] = useState<BackgroundHydrationOwner | null>(
    () => null
  );
  const backgroundHydrationOwnerRef = useRef<BackgroundHydrationOwner | null>(null);
  backgroundHydrationOwnerRef.current = backgroundHydrationOwner;
  const backgroundHydrationRequestIdRef = useRef(0);
  // IPE-065R8B (§5): the displayed "loading" story derives from the CURRENT
  // lifecycle owner only — a stale old-lifecycle owner never renders as
  // loading after switching workspaces.
  const backgroundHydratingStoryKey =
    backgroundHydrationOwner != null &&
    backgroundHydrationOwner.workspaceId === selectedWorkspaceId &&
    backgroundHydrationOwner.epoch === evidenceWorkspaceIdentityRef.current.epoch
      ? backgroundHydrationOwner.storyKey
      : null;
  if (selectedWorkspaceId != null) {
    const returnedInvalidations = invalidatedIdsForWorkspace(
      invalidEvidenceByWorkspaceRef.current,
      selectedWorkspaceId
    );
    if (returnedInvalidations.size) {
      for (const id of Array.from(returnedInvalidations)) {
        evidenceLifecycleRef.current.invalidatedIds.add(id);
      }
      invalidEvidenceByWorkspaceRef.current.delete(selectedWorkspaceId);
    }
  }
  // IPE-065R3/R4: coalescing registry — at most one in-flight reconciliation
  // per workspace LIFECYCLE (id@epoch) + scope + generation-snapshot identity.
  const evidenceReconciliationInFlightRef = useRef(new Map<string, Promise<void>>());
  // IPE-065R5 (§10/§11): lifecycle-selective registry prune instead of a
  // blind delayed .clear() — entries of the CURRENT lifecycle (a fast
  // mutation racing the transition) survive; old-epoch and other-workspace
  // entries are dropped synchronously at rotation.
  pruneEvidenceRegistryForLifecycle(
    evidenceReconciliationInFlightRef.current,
    selectedWorkspaceId ?? -1,
    evidenceWorkspaceIdentityRef.current.epoch
  );
  // IPE-065R3/R4 (§5): THE centralized reconciliation authority. It captures
  // the workspace lifecycle (id + epoch) and the generation snapshot BEFORE
  // the request, starts the explicit network fetch after that capture
  // (cancelRefetch supersedes any in-flight request for the scoped query),
  // and consumes the refetch RESULT DIRECTLY — never dataUpdatedAt, never a
  // React effect noticing `.data`, never a structural reference change
  // (structural sharing cannot block a tombstone release).
  const reconcileInvalidatedEvidence = (scopeIds: readonly number[]) => {
    const capturedWorkspaceId = selectedWorkspaceId;
    if (!capturedWorkspaceId) return Promise.resolve();
    // IPE-065R4 (§4): capture BOTH the workspace id and its lifecycle epoch —
    // a response is authoritative only while the page still lives in that
    // exact lifecycle (A(epoch1) != A(epoch3)).
    const capturedIdentity = evidenceWorkspaceIdentityRef.current;
    const targets = scopeIds.filter((id) =>
      evidenceLifecycleRef.current.invalidatedIds.has(id)
    );
    if (!targets.length) return Promise.resolve();
    const captured = captureEvidenceGenerations(
      evidenceLifecycleRef.current.generations,
      targets
    );
    const key = buildEvidenceReconciliationKey(
      capturedWorkspaceId,
      capturedIdentity.epoch,
      targets,
      captured
    );
    const inFlight = evidenceReconciliationInFlightRef.current.get(key);
    if (inFlight) return inFlight;
    // IPE-065R4 (§7): the cleanup closure references `promise` — declare it
    // before assignment so the ownership check reads the settled instance.
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const result = await editorialEvidenceStatuses.refetch({ cancelRefetch: true });
        // Lifecycle fence: the response is authoritative only while the page
        // still lives in the captured workspace AND the captured epoch — a
        // returned-to-A workspace with a restarted lifecycle is a DIFFERENT
        // lifecycle and rejects the old response outright.
        if (
          !sameEvidenceWorkspaceLifecycle(
            evidenceWorkspaceIdentityRef.current,
            capturedWorkspaceId,
            capturedIdentity.epoch
          )
        ) {
          return;
        }
        const freshRows = result.data;
        // Unsuccessful/empty result → keep every tombstone (fail closed).
        if (!Array.isArray(freshRows) || !freshRows.length) return;
        // Re-read the CURRENT lifecycle container — an epoch rotation during
        // the request re-homes all authority, and the lifecycle fence above
        // already rejected cross-epoch responses.
        const lifecycle = evidenceLifecycleRef.current;
        const accepted = acceptedReconciliationIds(
          captured,
          lifecycle.generations,
          lifecycle.invalidatedIds,
          freshRows
        );
        if (!accepted.length) return;
        const acceptedSet = new Set(accepted);
        const rows = acceptedReconciliationRows(freshRows, acceptedSet);
        // Merge the fresh rows and release their tombstones against the
        // container (atomically, before the revision bump re-renders).
        for (const row of rows) {
          const rowWorkItemId = Number(row.workItemId);
          if (Number.isInteger(rowWorkItemId) && rowWorkItemId > 0) {
            lifecycle.rows.set(rowWorkItemId, row);
          }
        }
        for (const id of accepted) {
          lifecycle.invalidatedIds.delete(id);
        }
        bumpEvidenceRevision();
      } catch {
        // Failed reconciliation keeps every tombstone — the UI stays
        // fail-closed (loading/unknown); the next legitimate scope activation
        // retries. The pre-mutation PASS is never a fallback.
      } finally {
        // IPE-065R4 (§6): ownership-safe cleanup — remove the registry entry
        // only while it still points at THIS promise; an old lifecycle's
        // promise settling late must never delete a newer reconciliation's
        // coalescing entry.
        releaseOwnedReconciliationEntry(
          evidenceReconciliationInFlightRef.current,
          key,
          promise
        );
      }
    })();
    evidenceReconciliationInFlightRef.current.set(key, promise);
    return promise;
  };
  // IPE-065R1/R3 (P1): ONE centralized invalidation authority for every
  // evidence-changing mutation — deterministic work only: (1) normalize the
  // affected ids, (2) bump each id's invalidation generation, (3) tombstone
  // them, (4) prune their accumulated rows, (5) start the explicit
  // generation-bound reconciliation when an affected id belongs to the
  // current active scope. No timestamps, no timers.
  const invalidateEvidenceRows = (
    workItemIds: ReadonlyArray<number | null | undefined>,
    options?: { refetch?: boolean; workspaceId?: number | null }
  ) => {
    const ids = Array.from(
      new Set(
        workItemIds.filter(
          (id): id is number => Number.isInteger(id) && Number(id) > 0
        )
      )
    );
    if (!ids.length) return;
    // IPE-065R5 (§12): a mutation belonging to a workspace the operator has
    // ALREADY left must fence its stale identity THERE — never touch the
    // current lifecycle's container. The recorded ids are re-seeded as
    // tombstones when that workspace is re-entered.
    const targetWorkspaceId = options?.workspaceId;
    if (
      targetWorkspaceId != null &&
      targetWorkspaceId !== selectedWorkspaceIdRef.current
    ) {
      recordInvalidEvidenceForWorkspace(
        invalidEvidenceByWorkspaceRef.current,
        targetWorkspaceId,
        ids
      );
      return;
    }
    const lifecycle = evidenceLifecycleRef.current;
    lifecycle.generations = bumpEvidenceGenerations(lifecycle.generations, ids);
    for (const id of ids) {
      lifecycle.invalidatedIds.add(id);
    }
    for (const id of ids) {
      lifecycle.rows.delete(id);
    }
    bumpEvidenceRevision();
    if (options?.refetch !== false && ids.some((id) => activeEvidenceScopeSet.has(id))) {
      void reconcileInvalidatedEvidence(activeEvidenceScopeIds).catch(() => undefined);
    }
  };
  // IPE-065R3 (§4): generic query/cache observation is NEVER a freshness
  // authority — no completion-timestamp comparison exists. The merge is
  // ALWAYS fenced: non-tombstoned ids merge normally (progressive cache
  // behavior for untouched evidence), tombstoned ids NEVER merge here, and
  // tombstones are NEVER cleared by this path — only the explicit
  // generation-bound reconciliation above may release them.
  useEffect(() => {
    const data = editorialEvidenceStatuses.data;
    if (!Array.isArray(data) || !data.length) return;
    const lifecycle = evidenceLifecycleRef.current;
    const merged = mergeEvidenceRowsSkippingInvalidated(
      lifecycle.rows,
      data,
      lifecycle.invalidatedIds
    );
    if (merged) {
      lifecycle.rows = merged;
      bumpEvidenceRevision();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorialEvidenceStatuses.data]);
  // IPE-065R3 (§12): the board is server truth — once a successful board
  // fetch proves a workItem no longer exists (e.g. the pack was removed),
  // its tombstone/generation identity can be dropped deterministically (the
  // evidence row was already pruned and no card references it). Prevents
  // unbounded fence growth during the page's lifetime while keeping any
  // still-present pack's fence fully intact.
  useEffect(() => {
    if (!editorialBoard.isSuccess) return;
    const present = new Set<number>(editorialEvidenceWorkItemIds);
    const lifecycle = evidenceLifecycleRef.current;
    let changed = false;
    for (const id of Array.from(lifecycle.invalidatedIds)) {
      if (!present.has(id)) {
        lifecycle.invalidatedIds.delete(id);
        changed = true;
      }
    }
    for (const id of Array.from(lifecycle.generations.keys())) {
      if (!present.has(id)) lifecycle.generations.delete(id);
    }
    if (changed) bumpEvidenceRevision();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorialBoard.data]);
  const editorialSourceDraft = trpc.workspace.editorial.sourceDraft.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemId: selectedSourceWorkItemId ?? 0,
    },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId && selectedSourceWorkItemId),
      retry: false,
    }
  );
  // IPE-064R3 perf: light per-tab outline (no paragraph text) — the
  // pack/chapter tree and review summary render from this instead of
  // waiting on the full sourceDraft payload.
  const editorialSourceDraftOutline = trpc.workspace.editorial.sourceDraftOutline.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemId: selectedSourceWorkItemId ?? 0,
    },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId && selectedSourceWorkItemId),
      retry: false,
    }
  );
  const editorialForeignChecker = trpc.workspace.editorial.foreignChecker.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemId: selectedSourceWorkItemId ?? 0,
    },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId && selectedSourceWorkItemId),
      retry: false,
    }
  );
  const editorialEditor = trpc.workspace.editorial.editor.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemId: selectedSourceWorkItemId ?? 0,
    },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId && selectedSourceWorkItemId),
      retry: false,
    }
  );
  const editorialApproval = trpc.workspace.editorial.approval.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemId: selectedSourceWorkItemId ?? 0,
    },
    {
      enabled: isAdmin && Boolean(selectedWorkspaceId && selectedSourceWorkItemId),
      retry: false,
    }
  );

  const selected = detail.data;
  // IPE-065R8A: direct request ownership for background story hydration.
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!selectedWorkspaceId && workspaces.data?.length) {
      // IPE-064R4B (P2): the intake page's return link carries the workspace
      // it was managing — honor it before the first-workspace fallback.
      const requested = Number(new URLSearchParams(window.location.search).get("workspace"));
      const rows = workspaces.data as any[];
      const requestedValid =
        Number.isInteger(requested) && rows.some(({ workspace }: any) => workspace.id === requested);
      setSelectedWorkspaceId(requestedValid ? requested : rows[0].workspace.id);
    }
  }, [selectedWorkspaceId, workspaces.data]);

  useEffect(() => {
    setSelectedSourceWorkItemId(undefined);
    setSelectedEditorialWorkItemIds([]);
    setStoryEntered(false);
    setChapterEditorTarget(undefined);
    setChapterEditorParagraphs([]);
  }, [selectedWorkspaceId]);

  const ensureEditorialBoard = trpc.workspace.editorial.ensureBoard.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
    },
    onError: (error, variables) => {
      ensuredEditorialWorkspaces.current.delete(variables.workspaceId);
      toast.error(error.message);
    },
  });

  useEffect(() => {
    const workspaceId = selectedWorkspaceId;
    if (
      !isAdmin ||
      !workspaceId ||
      editorialBoard.isLoading ||
      ensuredEditorialWorkspaces.current.has(workspaceId)
    ) {
      return;
    }
    ensuredEditorialWorkspaces.current.add(workspaceId);
    ensureEditorialBoard.mutate({ workspaceId });
  }, [editorialBoard.data, editorialBoard.isLoading, isAdmin, selectedWorkspaceId]);

  // IPE-065R3 (§11): board/approval refresh only — the evidence projection is
  // reconciled EXCLUSIVELY through the generation-bound authority, never by an
  // ordinary unbound refetch (which could supersede an in-flight
  // reconciliation request).
  const refreshBulkEditorial = async () => {
    await Promise.all([editorialBoard.refetch(), editorialApproval.refetch()]);
  };
  const bulkApproveEditorialDrafts = trpc.workspace.editorial.bulkApproveDrafts.useMutation({
    onSuccess: async (results, variables) => {
      // IPE-065R1 (P1): prune the affected rows first — refreshBulkEditorial
      // then refetches the scoped projection (cancelling any pre-mutation
      // in-flight request) so only fresh server evidence is re-merged.
      invalidateEvidenceRows(
        results.map((result: any) => result.workItemId),
        { refetch: false, workspaceId: variables.workspaceId }
      );
      await refreshBulkEditorial();
      // IPE-065R3 (§11): the affected active-scope ids reconcile EXCLUSIVELY
      // through the generation-bound authority — never an unbound refetch.
      void reconcileInvalidatedEvidence(activeEvidenceScopeIds).catch(() => undefined);
      const failed = results.filter((result) => !result.ok);
      const firstError = failed.find((result: any) => result.error)?.error;
      toast[failed.length ? "error" : "success"](
        `ยืนยัน ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่ผ่าน ${failed.length}${firstError ? ` · ${firstError}` : ""}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkStageEditorialDrafts = trpc.workspace.editorial.bulkStageDrafts.useMutation({
    onSuccess: async (results, variables) => {
      invalidateEvidenceRows(
        results.map((result: any) => result.workItemId),
        { refetch: false, workspaceId: variables.workspaceId }
      );
      await refreshBulkEditorial();
      // IPE-065R3 (§11): the affected active-scope ids reconcile EXCLUSIVELY
      // through the generation-bound authority — never an unbound refetch.
      void reconcileInvalidatedEvidence(activeEvidenceScopeIds).catch(() => undefined);
      const failed = results.filter((result) => !result.ok);
      toast[failed.length ? "error" : "success"](`Stage ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่ผ่าน ${failed.length}` : ""}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkRunEditorialChecker = trpc.workspace.editorial.bulkRunChecker.useMutation({
    onSuccess: async (results, variables) => {
      invalidateEvidenceRows(
        results.map((result: any) => result.workItemId),
        { refetch: false, workspaceId: variables.workspaceId }
      );
      await refreshBulkEditorial();
      // IPE-065R3 (§11): the affected active-scope ids reconcile EXCLUSIVELY
      // through the generation-bound authority — never an unbound refetch.
      void reconcileInvalidatedEvidence(activeEvidenceScopeIds).catch(() => undefined);
      // IPE-064R4B (P2): the open pack's finding card / chapter issue counts /
      // stale indicator derive from this query — refresh it after bulk Check
      // or they keep showing the previous run.
      await editorialForeignChecker.refetch();
      const technicalFailed = results.filter((result) => !result.ok);
      const needsFix = results.filter((result: any) => result.ok && result.effectiveStatus === "failed");
      toast[technicalFailed.length || needsFix.length ? "error" : "success"](
        `ตรวจ ${results.length} ตอน · ผ่าน ${results.length - technicalFailed.length - needsFix.length} · ต้องแก้ ${needsFix.length}${technicalFailed.length ? ` · ผิดพลาด ${technicalFailed.length}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkRequestEditorialPublish = trpc.workspace.editorial.bulkRequestPublish.useMutation({
    onSuccess: async (results, variables) => {
      invalidateEvidenceRows(
        results.map((result: any) => result.workItemId),
        { refetch: false, workspaceId: variables.workspaceId }
      );
      await refreshBulkEditorial();
      // IPE-065R3 (§11): the affected active-scope ids reconcile EXCLUSIVELY
      // through the generation-bound authority — never an unbound refetch.
      void reconcileInvalidatedEvidence(activeEvidenceScopeIds).catch(() => undefined);
      const failed = results.filter((result) => !result.ok);
      const firstError = failed.find((result: any) => result.error)?.error;
      toast[failed.length ? "error" : "success"](
        `ส่งเผยแพร่ ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่พร้อม ${failed.length}${firstError ? ` · ${firstError}` : ""}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const updateEditorialEpisode = trpc.workspace.editorial.updateEpisode.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): a range/episodeNumber change can flip the published
      // fallback mapping — the old evidence row must not stay current.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await editorialBoard.refetch();
      toast.success("แก้ไข Episode Pack แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const updateEditorialEpisodeSale = trpc.workspace.editorial.updateEpisodeSale.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): sale validity feeds publish readiness — fail closed.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await editorialBoard.refetch();
      toast.success("อัปเดตการขายของ Episode Pack แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const removeEditorialEpisode = trpc.workspace.editorial.removeEpisode.useMutation({
    onSuccess: async (_result, variables) => {
      if (selectedSourceWorkItemId === variables.workItemId) setSelectedSourceWorkItemId(undefined);
      // IPE-065R1 (§5): the removed pack must not linger in the accumulated
      // evidence cache — prune its row without a needless scoped refetch.
      invalidateEvidenceRows([variables.workItemId], { refetch: false, workspaceId: variables.workspaceId });
      await editorialBoard.refetch();
      toast.success("นำ Episode Pack ออกจาก Workspace แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const assignEditorialWorkItem = trpc.workspace.editorial.assignWorkItem.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateEditorialWorkItemNote = trpc.workspace.editorial.updateWorkItemNote.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
      toast.success("บันทึกหมายเหตุแล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const runEditorialForeignChecker = trpc.workspace.editorial.foreignCheckerRun.useMutation({
    onSuccess: async (result, variables) => {
      // IPE-065R1 (P1): the run changed checkerRan/checker — the previous row
      // (possibly a PASS from the earlier draft) must stop being current now.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await Promise.all([
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success(
        result.unresolvedCount
          ? `พบ ${result.unresolvedCount} จุดที่ต้องตรวจ`
          : "ไม่พบคำต่างประเทศที่ค้างตรวจ"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  // IPE-058-E: exactly-once automatic recheck. Identity =
  // workItemId + draftId + allow-list hash; coalesces concurrent calls,
  // reuses completed runs for the same identity (server replay dedupes
  // storage), and never double-runs on refetch.
  const editorialAutoRecheckInFlight = useRef(new Map<string, Promise<unknown>>());
  const editorialAutoRecheckDone = useRef(new Set<string>());
  const runEditorialForeignCheckerOnceForDraft = (draftId: number, identityNonce?: string) => {
    if (!selectedWorkspaceId || !selectedSourceWorkItemId) {
      return Promise.resolve();
    }
    const currentAllowListSha256 = editorialCheckerData?.currentAllowListSha256 as string | undefined;
    // IPE-064R4B (P2): identityNonce lets allow/unallow bypass the STALE
    // closure hash — the post-mutation allow-list hash is not visible to
    // this render closure until a later refetch render, so a nonce keeps
    // the follow-up run from coalescing into the pre-mutation in-flight run.
    const identity = `${selectedSourceWorkItemId}:${draftId}:${currentAllowListSha256 ?? ""}${identityNonce ? `:${identityNonce}` : ""}`;
    const inFlight = editorialAutoRecheckInFlight.current.get(identity);
    if (inFlight) return inFlight;
    if (editorialAutoRecheckDone.current.has(identity)) return Promise.resolve();
    const promise = runEditorialForeignChecker
      .mutateAsync({
        workspaceId: selectedWorkspaceId,
        workItemId: selectedSourceWorkItemId,
        expectedDraftId: draftId,
      })
      .then((result) => {
        editorialAutoRecheckDone.current.add(identity);
        return result;
      })
      .finally(() => {
        editorialAutoRecheckInFlight.current.delete(identity);
      });
    editorialAutoRecheckInFlight.current.set(identity, promise);
    return promise;
  };

  const editEditorialDraft = trpc.workspace.editorial.editorEdit.useMutation({
    onSuccess: async (result, variables) => {
      // IPE-065R1 (P1): the save created a NEW draft revision — every QC/
      // approval/stage fact in the previous evidence row belongs to the OLD
      // revision and must stop being presented immediately (the background
      // recheck lands later with fresh evidence).
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      const savedChapterTarget =
        variables.command.kind === "replace_tab" ? chapterEditorTarget : undefined;
      // Controlled canvas history never crosses a server save revision.
      chapterEditorHistoryRef.current = createChapterCanvasHistory();
      if (!savedChapterTarget) {
        setChapterEditorTarget(undefined);
        setChapterEditorParagraphs([]);
      }
      // IPE-064R2 perceived-latency fix: the server save copies the whole
      // pack into a new immutable revision, and the automatic recheck re-runs
      // the full deterministic checker (O(tabs²) near-duplicate scan) before
      // the QC evidence turns CURRENT. Only the source-draft refetch is
      // needed to rebind the open editor — everything else is refreshed by
      // the background recheck when it lands, so the operator gets the save
      // confirmation immediately and keeps working.
      const [sourceDraftResult] = await Promise.all([
        editorialSourceDraft.refetch(),
        editorialEditor.refetch(),
        // IPE-064R4B (P2): the revision changed the tab set/edited flags —
        // the outline read model must follow or the tree shows stale rows.
        editorialSourceDraftOutline.refetch(),
        // IPE-064R4B review round 12 (P2): refresh the checker read model
        // IMMEDIATELY so editorialCheckerRunStale flips true while the
        // background rerun is in flight — otherwise the finding actions
        // target the previous draft's evidence until the recheck lands.
        editorialForeignChecker.refetch(),
      ]);
      if (savedChapterTarget) {
        const freshDraftData = sourceDraftResult.data as any;
        const freshDraft = freshDraftData?.latestDraft;
        const freshTab = (freshDraftData?.tabs ?? []).find(
          (tab: any) => tab.sourceTabId === savedChapterTarget.sourceTabId
        );
        if (freshDraft && freshTab) {
          const freshParagraphs: ChapterEditorParagraphState[] = (
            freshTab.paragraphs ?? []
          ).map((paragraph: any, index: number) => ({
            id: String(
              paragraph.paragraphKey ??
                `source-${freshTab.sourceTabId}-${index}`
            ),
            paragraphKey: paragraph.paragraphKey
              ? String(paragraph.paragraphKey)
              : undefined,
            text: String(paragraph.text ?? ""),
          }));
          setChapterEditorTarget({
            sourceTabId: freshTab.sourceTabId,
            title: freshTab.title,
            expectedTabStructuralSha256: freshTab.structuralSha256,
            expectedText: editorialTabText(freshTab),
            draftId: freshDraft.id,
            draftVersion: freshDraft.version,
            draftSha256: freshDraft.draftSha256,
          });
          setChapterEditorParagraphs(
            freshParagraphs.length
              ? freshParagraphs
              : [{ id: `source-${freshTab.sourceTabId}-0`, text: "" }]
          );
        } else {
          setChapterEditorTarget(undefined);
          setChapterEditorParagraphs([]);
        }
      }
      toast.success(
        result.replayed
          ? "ใช้ผลบันทึกเดิมอย่างปลอดภัย"
          : "บันทึก Draft ใหม่แล้ว · กำลังตรวจซ้ำอัตโนมัติ"
      );
      // Background recheck: the exactly-once guard coalesces repeats, its
      // own onSuccess refreshes checker/approval/board, and mutation onError
      // already toasts — swallow the chained rejection to avoid an
      // unhandled-rejection warning on top of that toast.
      if (
        selectedWorkspaceId &&
        selectedSourceWorkItemId &&
        result.draft?.id &&
        result.isCurrent !== false
      ) {
        void runEditorialForeignCheckerOnceForDraft(result.draft.id).catch(() => {
        // IPE-064R4B (P2): on recheck FAILURE the caches must not keep
        // presenting the pre-save draft as current — refresh the evidence
        // surfaces so the UI flips to stale/error instead of silently
        // targeting obsolete findings.
        void editorialForeignChecker.refetch();
        void editorialApproval.refetch();
        void editorialBoard.refetch();
      });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const refreshAfterTabRevision = async () => {
    await Promise.all([
      editorialSourceDraft.refetch(), editorialEditor.refetch(), editorialForeignChecker.refetch(),
      editorialApproval.refetch(), editorialBoard.refetch(),
      editorialSourceDraftOutline.refetch(),
    ]);
  };
  const excludeEditorialTab = trpc.workspace.editorial.editorExcludeTab.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): a tab revision invalidates the pack's QC evidence.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await refreshAfterTabRevision();
      toast.success("นำแท็บออกจาก Draft แล้ว — กรุณารัน Checker และ Confirm ใหม่");
    },
    onError: (error) => toast.error(error.message),
  });
  const restoreEditorialTab = trpc.workspace.editorial.editorRestoreTab.useMutation({
    onSuccess: async (_result, variables) => {
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await refreshAfterTabRevision();
      toast.success("คืนแท็บเข้า Draft แล้ว — กรุณารัน Checker และ Confirm ใหม่");
    },
    onError: (error) => toast.error(error.message),
  });
  const undoEditorialEdit = trpc.workspace.editorial.editorUndo.useMutation({
    onSuccess: async (result, variables) => {
      // IPE-065R1 (P1): undo creates a new draft revision — same stale rule.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      setChapterEditorTarget(undefined);
      setChapterEditorParagraphs([]);
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialEditor.refetch(),
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
        editorialBoard.refetch(),
        editorialSourceDraftOutline.refetch(),
      ]);
      if (
        selectedWorkspaceId &&
        selectedSourceWorkItemId &&
        result.draft?.id &&
        result.isCurrent !== false
      ) {
        await runEditorialForeignCheckerOnceForDraft(result.draft.id);
      }
      toast.success("Undo สร้าง Draft เวอร์ชันใหม่และตรวจซ้ำแล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const approveEditorialDraft = trpc.workspace.editorial.approveDraft.useMutation({
    onSuccess: async (result, variables) => {
      // IPE-065R1 (P1): approval validity changed — refresh the row.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await editorialApproval.refetch();
      toast.success(
        result.replayed
          ? "Draft นี้ได้รับการยืนยันไว้แล้ว"
          : "ยืนยัน Draft hash และ QC evidence แล้ว"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const stageEditorialEpisode = trpc.workspace.editorial.stageEpisodeDraft.useMutation({
    onSuccess: async (result, variables) => {
      // IPE-065R1 (P1): staging changes stage/readyToPublish evidence.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await Promise.all([
        editorialApproval.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success(
        result.replayed
          ? "Episode draft นี้ถูก stage ไว้แล้ว"
          : "สร้าง/อัปเดต Episode draft แบบ unpublished แล้ว"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveEditorialFinding = trpc.workspace.editorial.foreignCheckerResolve.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): resolve/reopen changes the unresolved count that the
      // checker flag derives from — refresh the row.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await Promise.all([
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const allowEditorialFinding = trpc.workspace.editorial.foreignCheckerAllow.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): the allow-list changed and a recheck is about to run —
      // the pre-allow evidence row must stop being current immediately.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      // IPE-064R4B (P2): refetch the cached checker read model FIRST so the
      // exactly-once identity picks up the NEW allow-list hash — otherwise a
      // second quick allow coalesces into the still-running pre-mutation
      // recheck (old identity) and its allow never gets re-checked.
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        await editorialForeignChecker.refetch();
      }
      // IPE-064R4B: the recheck is a FULL deterministic run — fire it in the
      // background and let its own onSuccess refresh checker/approval/board
      // (and toast the fresh finding count). The button spinner covers the
      // mutation itself.
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        const latestDraft = (editorialSourceDraft.data as any)?.latestDraft;
        if (latestDraft?.id) {
          // IPE-064R4B (P2): nonce — the post-allow allow-list hash is not
          // visible to this closure yet; force a fresh run identity.
          void runEditorialForeignCheckerOnceForDraft(latestDraft.id, String(Date.now())).catch(() => {
        // IPE-064R4B (P2): on recheck FAILURE the caches must not keep
        // presenting the pre-save draft as current — refresh the evidence
        // surfaces so the UI flips to stale/error instead of silently
        // targeting obsolete findings.
        void editorialForeignChecker.refetch();
        void editorialApproval.refetch();
        void editorialBoard.refetch();
      });
        }
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const setStructuralConfirmation = trpc.workspace.editorial.structuralConfirmation.useMutation({
    onSuccess: async (_result, variables) => {
      // IPE-065R1 (P1): a structural confirmation can clear a blocking issue
      // from the QC chain — refresh the row.
      invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });
      await Promise.all([
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success("อัปเดตการยืนยัน structural issue แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const unallowEditorialWord = trpc.workspace.editorial.foreignCheckerUnallow.useMutation({
    onSuccess: async () => {
      // IPE-065R1 (P1): the unallow has no workItemId in its input — the
      // recheck runs for the currently selected pack, so its row is the one
      // that must stop being current.
      invalidateEvidenceRows([selectedSourceWorkItemId], { workspaceId: selectedWorkspaceId });
      // IPE-064R4B (P2): refetch before the recheck — same allow-list-hash
      // identity rationale as foreignCheckerAllow.
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        await editorialForeignChecker.refetch();
      }
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        const latestDraft = (editorialSourceDraft.data as any)?.latestDraft;
        if (latestDraft?.id) {
          // IPE-064R4B (P2): nonce forces a fresh identity for the
          // post-unallow allow-list state.
          void runEditorialForeignCheckerOnceForDraft(latestDraft.id, String(Date.now())).catch(() => {
        // IPE-064R4B (P2): on recheck FAILURE the caches must not keep
        // presenting the pre-save draft as current — refresh the evidence
        // surfaces so the UI flips to stale/error instead of silently
        // targeting obsolete findings.
        void editorialForeignChecker.refetch();
        void editorialApproval.refetch();
        void editorialBoard.refetch();
      });
        }
      }
    },
    onError: (error) => toast.error(error.message),
  });
  // IPE-058-F: progression handlers shared by the sticky toolbar and the
  // approval panel buttons — same mutations, same guards, no new authority.
  const submitApprovalConfirm = () => {
    const draft = editorialApprovalData?.latestDraft;
    const qc = editorialApprovalData?.qc;
    if (!selectedWorkspaceId || !selectedSourceWorkItemId || !draft || !qc?.checkerRunId || !qc?.qcEvidenceSha256) return;
    approveEditorialDraft.mutate({
      workspaceId: selectedWorkspaceId,
      workItemId: selectedSourceWorkItemId,
      expectedDraftId: draft.id,
      expectedDraftVersion: draft.version,
      expectedDraftSha256: draft.draftSha256,
      expectedCheckerRunId: qc.checkerRunId,
      expectedQcEvidenceSha256: qc.qcEvidenceSha256,
      idempotencyKey: `editorial-approve:${draft.id}:${qc.qcEvidenceSha256}`,
    });
  };
  const submitStageDraft = () => {
    const draft = editorialApprovalData?.latestDraft;
    const approval = editorialApprovalData?.approval;
    if (!selectedWorkspaceId || !selectedSourceWorkItemId || !draft || !approval?.id) return;
    stageEditorialEpisode.mutate({
      workspaceId: selectedWorkspaceId,
      workItemId: selectedSourceWorkItemId,
      approvalId: approval.id,
      expectedDraftId: draft.id,
      expectedDraftVersion: draft.version,
      expectedDraftSha256: draft.draftSha256,
      idempotencyKey: `editorial-stage:${approval.id}:${draft.id}:${draft.draftSha256.slice(0, 16)}`,
    });
  };
  const runCheckerForCurrentDraft = () => {
    if (!selectedWorkspaceId || !selectedSourceWorkItemId || !latestEditorialDraft?.id) return;
    runEditorialForeignCheckerOnceForDraft(latestEditorialDraft.id);
  };

  const submitChapterEditorEdit = () => {
    if (
      !selectedWorkspaceId ||
      !selectedSourceWorkItemId ||
      !chapterEditorTarget ||
      editEditorialDraft.isPending ||
      chapterEditorSaveProjection.text === chapterEditorTarget.expectedText
    ) {
      return;
    }
    // IPE-062R3 (P2-B) save-identity invariant: the canvas editor's draft
    // must still BE the selected pack's latest draft. If the operator moved
    // to another pack, the stale target must NEVER be submitted under the
    // new pack's work item — fail closed, no mutation.
    if (
      !editorDraftBelongsToSelectedPack(
        chapterEditorTarget.draftId,
        (editorialSourceDraft.data as any)?.latestDraft?.id
      )
    ) {
      toast.error("Editor นี้เปิดจากแพ็กอื่น — ปิดแล้วเปิดใหม่ก่อนบันทึก");
      return;
    }
    editEditorialDraft.mutate({
      workspaceId: selectedWorkspaceId,
      workItemId: selectedSourceWorkItemId,
      expectedDraftId: chapterEditorTarget.draftId,
      expectedDraftVersion: chapterEditorTarget.draftVersion,
      expectedDraftSha256: chapterEditorTarget.draftSha256,
      command: {
        kind: "replace_tab",
        sourceTabId: chapterEditorTarget.sourceTabId,
        expectedTabStructuralSha256:
          chapterEditorTarget.expectedTabStructuralSha256,
        expectedText: chapterEditorTarget.expectedText,
        replacementText: chapterEditorSaveProjection.text,
        // IPE-058-C: explicit logical paragraph identity — "" = new paragraph.
        replacementParagraphKeys:
          chapterEditorSaveProjection.replacementParagraphKeys,
      },
      idempotencyKey: `editor-tab:${chapterEditorTarget.draftId}:${chapterEditorTarget.sourceTabId}:${Date.now()}`,
    });
  };

  useEffect(() => {
    if (!chapterEditorDirty) return;
    const warning = "มีการแก้ไข Chapter Editor ที่ยังไม่ได้บันทึก ต้องการออกจากหน้านี้หรือไม่?";
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const clickGuard = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      // IPE-064R4B round 31 (P1): intake links guard themselves via
      // navigateToWorkspaceIntake (the canonical dirty-editor boundary, with
      // its own confirmation + discard cleanup) — a capture-phase double
      // confirm would be two prompts for the same decision.
      if (anchor.closest("[data-intake-guarded-link]")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.href === window.location.href ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search &&
          destination.hash !== window.location.hash)
      ) {
        return;
      }
      if (!window.confirm(warning)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", clickGuard, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", clickGuard, true);
    };
  }, [chapterEditorDirty]);

  useEffect(() => {
    if (!chapterEditorTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        if (chapterEditorDirty && !editEditorialDraft.isPending) {
          submitChapterEditorEdit();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    chapterEditorTarget,
    chapterEditorDirty,
    chapterEditorText,
    editEditorialDraft.isPending,
    selectedWorkspaceId,
    selectedSourceWorkItemId,
  ]);

  const editorialColumns = (((editorialBoard.data as any)?.columns as any[] | undefined) ?? []);
  // IPE-065R5 (§8): rows are read from the LIFECYCLE- tagged container —
  // rotation replaces it synchronously with the workspace identity, so old
  // rows can never be authoritative during a render/effect transition gap.
  const evidenceRowsForRender = evidenceLifecycleRef.current.rows;
  const editorialCards = editorialColumns.flatMap((column: any) =>
    (column.cards ?? [])
      .filter((card: any) => card.workItemType !== "NEW_STORY")
      .map((card: any) => {
        // IPE-065 (B): a card WITHOUT a loaded evidence row is neutral —
        // "loading" only while the scoped projection is in flight for its
        // pack (active story) or while its story is hydrating in the
        // background (IPE-065R8A), otherwise "unavailable" (other story /
        // query error). The pack badge derives loading/unknown from this
        // signal and never presents an unloaded row as
        // not_checked/passed/published.
        const row = evidenceRowsForRender.get(card.workItemId);
        const cardStoryKey = storyKeyFor(card.workspaceNovelId, card.novel?.id);
        const evidenceState: "loaded" | "loading" | "unavailable" = row
          ? "loaded"
          : activeEvidenceScopeSet.has(card.workItemId) && editorialEvidenceStatuses.isFetching
            ? "loading"
            : cardStoryKey === backgroundHydratingStoryKey
              ? "loading"
              : "unavailable";
        return {
          ...card,
          columnKey: column.key,
          columnName: column.name,
          evidence: row ?? null,
          evidenceState,
        };
      })
  );
  const selectedSourceCard = editorialCards.find(
    (card: any) => card.workItemId === selectedSourceWorkItemId
  );
  const selectableEditorialWorkItemIds = editorialCards.map((card: any) => card.workItemId).filter((id: any): id is number => Number.isInteger(id));
  const editorialBoardWorkItemIdKey = editorialEvidenceWorkItemIds.join(",");
  useEffect(() => {
    if (!editorialBoard.isSuccess) return;
    const activeWorkItemIds = new Set(editorialEvidenceWorkItemIds);
    setSelectedEditorialWorkItemIds((current) => {
      const next = current.filter((workItemId) => activeWorkItemIds.has(workItemId));
      return next.length === current.length ? current : next;
    });
    if (selectedSourceWorkItemId && !activeWorkItemIds.has(selectedSourceWorkItemId)) {
      setSelectedSourceWorkItemId(undefined);
    }
  }, [
    editorialBoard.isSuccess,
    editorialBoardWorkItemIdKey,
    selectedSourceWorkItemId,
    selectedWorkspaceId,
  ]);
  const selectedEditorialSet = new Set(selectedEditorialWorkItemIds);
  const toggleEditorialSelection = (workItemId: number) => setSelectedEditorialWorkItemIds((current) => current.includes(workItemId) ? current.filter((id) => id !== workItemId) : [...current, workItemId]);
  const editorialDraftData = editorialSourceDraft.data as any;
  const latestEditorialDraft = editorialDraftData?.latestDraft;
  // IPE-058-F: row → editor direct navigation. The table row sets this id;
  // the effect below opens the editor as soon as the pack tabs arrive.
  const [pendingEditorOpenWorkItemId, setPendingEditorOpenWorkItemId] = useState<number | null>(null);
  const editorialEditorData = editorialEditor.data as any;
  const editorialApprovalData = editorialApproval.data as any;
  const editorialCheckerData = editorialForeignChecker.data as any;
  const editorialCheckerStaleReason = editorialCheckerData?.staleReason as
    | "DRAFT_CHANGED"
    | "ENGINE_CHANGED"
    | "ALLOW_LIST_CHANGED"
    | null
    | undefined;
  // IPE-058-E: derive chips from the durable read-model state (server
  // authority) — no open===0 shortcuts, no local timestamp guesses.
  const editorialCheckerState = editorialCheckerData?.state as
    | "NOT_RUN"
    | "RUNNING"
    | "STALE"
    | "ERROR"
    | "CURRENT_HAS_FINDINGS"
    | "CURRENT_READY"
    | undefined;
  const editorialCheckerRunStale = Boolean(
    editorialCheckerState
      ? editorialCheckerState === "STALE"
      : editorialCheckerData?.run &&
        (
          editorialCheckerData?.isCurrent === false ||
          !editorialCheckerData?.latestDraft ||
          editorialCheckerData.run.draftId !== editorialCheckerData.latestDraft.id ||
          editorialCheckerData.run.engineVersion !== editorialCheckerData.engineVersion ||
          (editorialCheckerData.currentAllowListSha256 &&
            editorialCheckerData.run.allowListSha256 !== editorialCheckerData.currentAllowListSha256)
        )
  );
  const chapterEditorTabs = (editorialDraftData?.tabs ?? []) as any[];
  const editorialCheckerCurrent = Boolean(
    editorialCheckerData?.run &&
      !editorialCheckerRunStale &&
      editorialCheckerData?.isCurrent !== false
  );
  // IPE-064R3: memoized — these inputs feed every per-tab status derivation;
  // without memo the whole pack was re-scanned on every keystroke.
  const currentCheckerFindings = useMemo(
    () =>
      editorialCheckerCurrent
        ? ((editorialCheckerData?.findings ?? []) as any[])
        : ([] as any[]),
    [editorialCheckerCurrent, editorialCheckerData]
  );
  const currentCheckerAnomalies = useMemo(
    () =>
      editorialCheckerCurrent
        ? ((editorialCheckerData?.anomalies ?? []) as any[])
        : ([] as any[]),
    [editorialCheckerCurrent, editorialCheckerData]
  );
  const chapterEditorStatusByTab = useMemo(
    () =>
      new Map(
        chapterEditorTabs.map((tab: any) => [
          tab.sourceTabId,
          chapterEditorTabStatus({
            sourceTabId: tab.sourceTabId,
            paragraphs: tab.paragraphs ?? [],
            checkerCurrent: editorialCheckerCurrent,
            findings: currentCheckerFindings,
            anomalies: currentCheckerAnomalies,
          }),
        ])
      ),
    [
      chapterEditorTabs,
      editorialCheckerCurrent,
      currentCheckerFindings,
      currentCheckerAnomalies,
    ]
  );
  const chapterEditorProgress = chapterEditorTabs.reduce(
    (summary, tab: any) => {
      const state = chapterEditorStatusByTab.get(tab.sourceTabId)?.progressState;
      if (state === "passed") summary.passed += 1;
      else if (state === "pending") summary.pending += 1;
      else if (state === "confirmed") summary.confirmed += 1;
      else summary.unchecked += 1;
      return summary;
    },
    { passed: 0, pending: 0, confirmed: 0, unchecked: 0 }
  );
  const filteredChapterEditorTabs = useMemo(
    () =>
      chapterEditorTabs.filter((tab: any) => {
        const status = chapterEditorStatusByTab.get(tab.sourceTabId);
        return status
          ? chapterEditorMatchesFilter(chapterEditorTabFilter, status)
          : chapterEditorTabFilter === "all";
      }),
    [chapterEditorTabs, chapterEditorStatusByTab, chapterEditorTabFilter]
  );
  // IPE-064R3: the pack/chapter tree and review summary render from the
  // light outline (titles + server-computed edited flags) — they no longer
  // wait for the full sourceDraft paragraph payload.
  const editorialDraftOutlineData = editorialSourceDraftOutline.data as any;
  const packOutlineRows = useMemo(
    () =>
      ((editorialDraftOutlineData?.tabs ?? []) as any[]).map((tab: any) => {
        const status = chapterEditorTabStatus({
          sourceTabId: tab.sourceTabId,
          paragraphs: [],
          edited: Boolean(tab.edited),
          checkerCurrent: editorialCheckerCurrent,
          findings: currentCheckerFindings,
          anomalies: currentCheckerAnomalies,
        });
        return {
          status,
          row: {
            sourceTabId: tab.sourceTabId as string,
            title: String(tab.title ?? ""),
            issueCount: status.issueCount,
            foreignFindingCount: status.foreignFindingCount,
            structuralIssueCount: status.structuralIssueCount,
            progressState: status.progressState as
              | "passed"
              | "pending"
              | "confirmed"
              | "unchecked",
            empty: Number(tab.paragraphCount ?? 0) === 0,
          },
        };
      }),
    [
      editorialDraftOutlineData,
      editorialCheckerCurrent,
      currentCheckerFindings,
      currentCheckerAnomalies,
    ]
  );
  const packTreeChapters = useMemo(
    () =>
      packOutlineRows
        .filter(entry => chapterEditorMatchesFilter(chapterEditorTabFilter, entry.status))
        .map(entry => entry.row),
    [packOutlineRows, chapterEditorTabFilter]
  );
  const chapterEditorCurrentIndex = chapterEditorTarget
    ? chapterEditorTabs.findIndex(
        (tab: any) => tab.sourceTabId === chapterEditorTarget.sourceTabId
      )
    : -1;
  const previousChapterTab =
    chapterEditorCurrentIndex > 0
      ? chapterEditorTabs[chapterEditorCurrentIndex - 1]
      : undefined;
  const nextChapterTab =
    chapterEditorCurrentIndex >= 0 &&
    chapterEditorCurrentIndex < chapterEditorTabs.length - 1
      ? chapterEditorTabs[chapterEditorCurrentIndex + 1]
      : undefined;
  const nextIssueChapterTab = (() => {
    if (!chapterEditorTabs.length) return undefined;
    const startIndex = chapterEditorCurrentIndex >= 0 ? chapterEditorCurrentIndex : -1;
    for (let offset = 1; offset <= chapterEditorTabs.length; offset += 1) {
      const index = (startIndex + offset) % chapterEditorTabs.length;
      const tab = chapterEditorTabs[index];
      if (
        tab &&
        tab.sourceTabId !== chapterEditorTarget?.sourceTabId &&
        (chapterEditorStatusByTab.get(tab.sourceTabId)?.issueCount ?? 0) > 0
      ) {
        return tab;
      }
    }
    return undefined;
  })();
  // IPE-058-F: issue-first tab picker for a freshly opened pack (used by the
  // row → editor navigation effect before the editor target exists).
  const nextIssueChapterTabForTabs = (tabs: any[]) => {
    const withIssue = tabs.find(
      tab => (chapterEditorStatusByTab.get(tab.sourceTabId)?.issueCount ?? 0) > 0
    );
    return withIssue ?? undefined;
  };
  const currentChapterStatus = chapterEditorTarget
    ? chapterEditorStatusByTab.get(chapterEditorTarget.sourceTabId)
    : undefined;
  const chapterEditorScrollStorageKey = (sourceTabId: string) =>
    `workspace:chapter-editor-scroll:${selectedWorkspaceId ?? "none"}:${selectedSourceWorkItemId ?? "none"}:${sourceTabId}`;
  const rememberChapterEditorScroll = () => {
    if (!chapterEditorTarget || !chapterEditorScrollRef.current) return;
    const scrollTop = chapterEditorScrollRef.current.scrollTop;
    chapterEditorScrollByTab.current.set(chapterEditorTarget.sourceTabId, scrollTop);
    window.sessionStorage.setItem(
      chapterEditorScrollStorageKey(chapterEditorTarget.sourceTabId),
      String(scrollTop)
    );
  };
  const restoreChapterEditorScroll = (sourceTabId: string) => {
    const memory = chapterEditorScrollByTab.current.get(sourceTabId);
    const stored = Number(
      window.sessionStorage.getItem(chapterEditorScrollStorageKey(sourceTabId)) ?? "0"
    );
    const scrollTop =
      typeof memory === "number" && Number.isFinite(memory)
        ? memory
        : Number.isFinite(stored)
          ? stored
          : 0;
    window.requestAnimationFrame(() => {
      if (chapterEditorScrollRef.current) {
        chapterEditorScrollRef.current.scrollTop = scrollTop;
      }
    });
  };
  const nextChapterEditorParagraphId = () => {
    chapterEditorParagraphSequence.current += 1;
    return `manual-${chapterEditorParagraphSequence.current}`;
  };
  // IPE-058-C: single-canvas caret helpers (UTF-16 offsets on the flat text).
  // IPE-062R4E: the canvas textarea is full-height (auto-grown), so it never
  // scrolls itself and browsers do not scroll ancestor containers for caret
  // focus. Measure the caret's Y with a style-matched mirror and scroll the
  // editor container explicitly — this powers ไปยังจุด (findings/structural).
  const scrollChapterCanvasCaretIntoView = (offset: number, smooth: boolean) => {
    const textarea = chapterEditorCanvasRef.current;
    const container = chapterEditorScrollRef.current;
    if (!textarea || !container) return;
    const caret = Math.max(0, Math.min(offset, textarea.value.length));
    const mirror = document.createElement("div");
    const style = window.getComputedStyle(textarea);
    for (const prop of [
      "fontSize",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "whiteSpace",
      "wordBreak",
      "overflowWrap",
      "paddingTop",
      "paddingBottom",
      "boxSizing",
      "borderTopWidth",
      "borderBottomWidth",
      "borderTopStyle",
      "borderBottomStyle",
    ] as const) {
      (mirror.style as any)[prop] = (style as any)[prop];
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.left = "-9999px";
    const innerWidth =
      textarea.clientWidth -
      (parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0"));
    mirror.style.width = `${Math.max(0, innerWidth)}px`;
    mirror.textContent = textarea.value.slice(0, caret);
    container.appendChild(mirror);
    const caretY = mirror.getBoundingClientRect().height;
    container.removeChild(mirror);
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    // Scroll only when the caret line sits outside the visible band — a
    // typing-restore caret that is already visible must not jump.
    if (caretY < viewTop + 8 || caretY > viewBottom - 48) {
      const target = Math.max(0, caretY - container.clientHeight / 2);
      container.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
    }
  };
  const focusChapterCanvasOffset = (offset: number) => {
    window.requestAnimationFrame(() => {
      const textarea = chapterEditorCanvasRef.current;
      if (!textarea) return;
      const clamped = Math.max(0, Math.min(offset, textarea.value.length));
      // Selection first, then focus; the container scroll below brings the
      // caret line into view (focus alone does not scroll ancestors).
      textarea.setSelectionRange(clamped, clamped);
      textarea.focus();
      scrollChapterCanvasCaretIntoView(clamped, false);
    });
  };
  const pushChapterEditorHistory = (caret: number) => {
    chapterEditorHistoryRef.current = pushChapterCanvasHistory(
      chapterEditorHistoryRef.current,
      { paragraphs: chapterEditorParagraphs, caret }
    );
  };
  const applyChapterEditorCanvasChange = (newText: string, restoreCaret: boolean) => {
    if (!chapterEditorTarget) return;
    pushChapterEditorHistory(chapterEditorCanvasRef.current?.selectionStart ?? 0);
    const result = applyChapterCanvasChange({
      previous: chapterEditorParagraphs,
      oldText: chapterEditorText,
      newText,
      nextId: nextChapterEditorParagraphId,
    });
    setChapterEditorParagraphs(result.paragraphs);
    if (restoreCaret) focusChapterCanvasOffset(result.caret);
  };
  const insertChapterEditorCanvasText = (inserted: string) => {
    const textarea = chapterEditorCanvasRef.current;
    if (!textarea || !chapterEditorTarget) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const newText = `${textarea.value.slice(0, start)}${inserted}${textarea.value.slice(end)}`;
    applyChapterEditorCanvasChange(newText, true);
  };
  const chapterEditorCanvasKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        const redone = redoChapterCanvas(chapterEditorHistoryRef.current, {
          paragraphs: chapterEditorParagraphs,
          caret: chapterEditorCanvasRef.current?.selectionStart ?? 0,
        });
        if (redone.entry) {
          chapterEditorHistoryRef.current = redone.history;
          setChapterEditorParagraphs(redone.entry.paragraphs);
          focusChapterCanvasOffset(redone.entry.caret);
        }
      } else {
        const undone = undoChapterCanvas(chapterEditorHistoryRef.current, {
          paragraphs: chapterEditorParagraphs,
          caret: chapterEditorCanvasRef.current?.selectionStart ?? 0,
        });
        if (undone.entry) {
          chapterEditorHistoryRef.current = undone.history;
          setChapterEditorParagraphs(undone.entry.paragraphs);
          focusChapterCanvasOffset(undone.entry.caret);
        }
      }
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      const redone = redoChapterCanvas(chapterEditorHistoryRef.current, {
        paragraphs: chapterEditorParagraphs,
        caret: chapterEditorCanvasRef.current?.selectionStart ?? 0,
      });
      if (redone.entry) {
        chapterEditorHistoryRef.current = redone.history;
        setChapterEditorParagraphs(redone.entry.paragraphs);
        focusChapterCanvasOffset(redone.entry.caret);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !meta && !event.altKey) {
      // Paragraph boundary: a blank line in the canonical model.
      event.preventDefault();
      insertChapterEditorCanvasText("\n\n");
    }
    // Shift+Enter falls through: the native "\n" stays INSIDE the paragraph
    // (soft break) and the canvas model keeps it in the same node.
  };
  const chapterEditorCanvasPaste = (
    event: React.ClipboardEvent<HTMLTextAreaElement>
  ) => {
    const paragraphs = chapterEditorClipboardParagraphs(event.clipboardData);
    if (!paragraphs.length) return;
    event.preventDefault();
    insertChapterEditorCanvasText(paragraphs.join("\n\n"));
  };

  const openChapterEditor = (tab: any) => {
    if (!latestEditorialDraft) return;
    if (
      chapterEditorTarget &&
      chapterEditorText !== chapterEditorTarget.expectedText &&
      !window.confirm("มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วเปิดแท็บอื่นหรือไม่?")
    ) {
      return;
    }
    rememberChapterEditorScroll();
    const text = editorialTabText(tab);
    const paragraphs: ChapterEditorParagraphState[] = (tab.paragraphs ?? []).map(
      (paragraph: any, index: number) => ({
        id: String(
          paragraph.paragraphKey ?? `source-${tab.sourceTabId}-${index}`
        ),
        paragraphKey: paragraph.paragraphKey ? String(paragraph.paragraphKey) : undefined,
        text: String(paragraph.text ?? ""),
      })
    );
    if (!paragraphs.length) {
      paragraphs.push({ id: nextChapterEditorParagraphId(), text: "" });
    }
    setChapterEditorIssueIndex(0);
    // Controlled canvas history never crosses chapter boundaries.
    chapterEditorHistoryRef.current = createChapterCanvasHistory();
    setChapterEditorTarget({
      sourceTabId: tab.sourceTabId,
      title: tab.title,
      expectedTabStructuralSha256: tab.structuralSha256,
      expectedText: text,
      draftId: latestEditorialDraft.id,
      draftVersion: latestEditorialDraft.version,
      draftSha256: latestEditorialDraft.draftSha256,
    });
    setChapterEditorParagraphs(paragraphs);
    setPackDetailTab("editor");
    window.requestAnimationFrame(() => {
      document.getElementById("workspace-chapter-editor")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      restoreChapterEditorScroll(tab.sourceTabId);
    });
  };
  const closeChapterEditor = () => {
    if (
      chapterEditorTarget &&
      chapterEditorText !== chapterEditorTarget.expectedText &&
      !window.confirm("ทิ้งการแก้ไขที่ยังไม่ได้บันทึกหรือไม่?")
    ) {
      return;
    }
    rememberChapterEditorScroll();
    setChapterEditorIssueIndex(0);
    chapterEditorHistoryRef.current = createChapterCanvasHistory();
    setChapterEditorTarget(undefined);
    setChapterEditorParagraphs([]);
  };

  // IPE-058-F: complete the row → editor click chain. The table row selects
  // the work item; once the pack tabs load, open the first issue tab
  // (next-issue behaviour) or the first tab directly.
  useEffect(() => {
    if (pendingEditorOpenWorkItemId === null || !latestEditorialDraft) return;
    const draftTabs = (editorialDraftData?.tabs ?? []) as any[];
    if (!draftTabs.length) return;
    const targetTab =
      nextIssueChapterTabForTabs(draftTabs) ?? draftTabs[0];
    if (targetTab) {
      openChapterEditor(targetTab);
    }
    setPendingEditorOpenWorkItemId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditorOpenWorkItemId, latestEditorialDraft?.id, editorialDraftData?.tabs?.length]);

  // IPE-062: finish a story switch — once the remembered pack's draft tabs
  // arrive, re-open the chapter that was being edited in that story.
  useEffect(() => {
    const restoreTabId = pendingChapterRestoreRef.current;
    if (!restoreTabId || !latestEditorialDraft) return;
    const draftTabs = (editorialDraftData?.tabs ?? []) as any[];
    if (!draftTabs.length) return;
    pendingChapterRestoreRef.current = null;
    const targetTab = draftTabs.find((tab: any) => tab.sourceTabId === restoreTabId);
    if (targetTab) {
      openChapterEditor(targetTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEditorialDraft?.id, editorialDraftData?.tabs?.length]);

  const chapterEditorIssueItems = chapterEditorTarget
    ? chapterEditorIssues({
        sourceTabId: chapterEditorTarget.sourceTabId,
        findings: currentCheckerFindings,
        anomalies: currentCheckerAnomalies,
      })
    : [];
  const chapterEditorIssueSignature = chapterEditorIssueItems
    .map(issue => issue.key)
    .join("|");
  const selectedChapterEditorIssue =
    chapterEditorIssueItems[chapterEditorIssueIndex];
  const chapterEditorIssueCounts = chapterEditorIssueItems.reduce(
    (counts, issue) => {
      if (issue.kind === "finding") counts.findings += 1;
      else counts.structural += 1;
      return counts;
    },
    { findings: 0, structural: 0 }
  );
  const chapterEditorFindings = chapterEditorTarget
    ? currentCheckerFindings.filter(
        (finding: any) =>
          finding.sourceTabId === chapterEditorTarget.sourceTabId &&
          finding.disposition === "open"
      )
    : [];
  // IPE-058-C: project per-paragraph QC findings onto flat canvas ranges.
  // Stale paragraphKeys produce null and are dropped (fail-safe: no wrong
  // highlight) instead of being clamped onto another paragraph.
  const chapterEditorCanvasFindings = useMemo(
    () =>
      chapterEditorFindings
        .map(finding => ({
          finding,
          range: chapterCanvasFindingRange(chapterEditorParagraphs, finding),
        }))
        .filter(
          (
            entry
          ): entry is {
            finding: any;
            range: { start: number; end: number };
          } => entry.range !== null
        )
        .map(({ finding, range }) => ({
          startOffset: range.start,
          endOffset: range.end,
          token: String(finding.token ?? ""),
        })),
    [chapterEditorFindings, chapterEditorParagraphs]
  );
  useEffect(() => {
    setChapterEditorIssueIndex(current =>
      chapterEditorIssueItems.length
        ? Math.min(current, chapterEditorIssueItems.length - 1)
        : 0
    );
  }, [chapterEditorTarget?.sourceTabId, chapterEditorIssueSignature]);

  const structuralNavigationTabs = (anomaly: any) => {
    const ids = Array.from(
      new Set(
        [
          anomaly.sourceTabId,
          ...(anomaly.relatedSourceTabIds ?? []),
        ].filter(Boolean)
      )
    ) as string[];
    const direct = ids
      .map(id => chapterEditorTabs.find((tab: any) => tab.sourceTabId === id))
      .filter(Boolean);
    if (direct.length || anomaly.anomalyType !== "missing_expected_chapter") {
      return direct;
    }
    const missing = Number(anomaly.chapterNumber);
    if (!Number.isFinite(missing)) return [];
    return chapterEditorTabs
      .filter((tab: any) => Number.isFinite(Number(tab.chapterNumber)))
      .slice()
      .sort(
        (left: any, right: any) =>
          Math.abs(Number(left.chapterNumber) - missing) -
            Math.abs(Number(right.chapterNumber) - missing) ||
          Number(left.chapterNumber) - Number(right.chapterNumber)
      )
      .slice(0, 2);
  };

  const navigateChapterEditorIssue = (issue: any, index: number) => {
    if (!chapterEditorTarget) return;
    setChapterEditorIssueIndex(index);
    if (issue.kind === "finding") {
      const finding = issue.finding;
      // IPE-058-C: map paragraphKey + UTF-16 offsets onto the flat canvas.
      // A stale key (paragraph no longer exists) fails safely: no highlight,
      // no focus jump to a wrong paragraph.
      const range = chapterCanvasFindingRange(
        chapterEditorParagraphs,
        finding
      );
      if (!range) {
        toast.error("หา paragraph ของ finding นี้ใน Draft ปัจจุบันไม่พบ");
        return;
      }
      window.requestAnimationFrame(() => {
        const textarea = chapterEditorCanvasRef.current;
        if (!textarea) return;
        const start = Math.max(
          0,
          Math.min(range.start, textarea.value.length)
        );
        const end = Math.max(
          start,
          Math.min(range.end, textarea.value.length)
        );
        // Selection first, then focus; the explicit container scroll below
        // brings the highlighted finding into view (focus alone does not
        // scroll ancestor containers).
        textarea.setSelectionRange(start, end);
        textarea.focus();
        scrollChapterCanvasCaretIntoView(start, true);
      });
      return;
    }
    const anomaly = issue.anomaly;
    const targetTabs = structuralNavigationTabs(anomaly);
    const primaryTab =
      targetTabs.find(
        (tab: any) => tab.sourceTabId === String(anomaly.sourceTabId ?? "")
      ) ?? targetTabs[0];
    if (
      primaryTab &&
      primaryTab.sourceTabId !== chapterEditorTarget.sourceTabId
    ) {
      openChapterEditor(primaryTab);
      return;
    }
    if (
      anomaly.anomalyType === "empty_tab" ||
      anomaly.anomalyType === "heading_only_tab" ||
      anomaly.anomalyType === "end_only_tab" ||
      anomaly.anomalyType === "source_note_only"
    ) {
      focusChapterCanvasOffset(
        anomaly.anomalyType === "end_only_tab"
          ? chapterEditorText.length
          : 0
      );
      return;
    }
    chapterEditorScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateRelativeChapterEditorIssue = (delta: number) => {
    if (!chapterEditorIssueItems.length) return;
    const nextIndex = Math.max(
      0,
      Math.min(
        chapterEditorIssueItems.length - 1,
        chapterEditorIssueIndex + delta
      )
    );
    const issue = chapterEditorIssueItems[nextIndex];
    if (issue) navigateChapterEditorIssue(issue, nextIndex);
  };

  const draftStructureSummary = useMemo(
    () => summarizeEditorialDraftTabs(editorialDraftData?.tabs ?? []),
    [editorialDraftData?.tabs]
  );
  const workspaceNovelOptions = (((selected as any)?.novels as any[] | undefined) ?? []);
  // IPE-062R3 (P2-A): seed the daily multi-story workspace from every bound
  // novel so stories with zero Episode Packs stay visible and focusable, and
  // cards whose workspaceNovelId is missing still merge into their novel's
  // group. Story totals come from the unfiltered board.
  const editorialNovelGroups = groupStoriesByNovel(editorialCards, workspaceNovelOptions as any[]);

  // ---------------------------------------------------------------------------
  // IPE-062: multi-story focus. The active story is the one whose pack list /
  // detail / summary panes render below; its remembered UI state restores on
  // switch, and the live selections persist back into the same record.
  // ---------------------------------------------------------------------------
  const storyUiStatesRef = useRef(storyUiStates);
  storyUiStatesRef.current = storyUiStates;
  const activeStoryKey = (() => {
    if (
      selectedStoryKey &&
      editorialNovelGroups.some(
        (group: any) => storyKeyFor(group.workspaceNovelId, group.novel?.id) === selectedStoryKey
      )
    ) {
      return selectedStoryKey;
    }
    const groupWithSelection = selectedSourceWorkItemId
      ? editorialNovelGroups.find((group: any) =>
          group.cards.some((card: any) => card.workItemId === selectedSourceWorkItemId)
        )
      : undefined;
    const fallback = groupWithSelection ?? editorialNovelGroups[0];
    return fallback ? storyKeyFor(fallback.workspaceNovelId, fallback.novel?.id) : null;
  })();
  const discardChapterEditorForContextSwitch = (message: string) => {
    if (!chapterEditorTarget) return true;
    const dirty = chapterEditorText !== chapterEditorTarget.expectedText;
    if (dirty && !window.confirm(message)) return false;
    rememberChapterEditorScroll();
    chapterEditorHistoryRef.current = createChapterCanvasHistory();
    setChapterEditorTarget(undefined);
    setChapterEditorParagraphs([]);
    return true;
  };
  const selectStory = (storyKey: string) => {
    if (storyKey === activeStoryKey) return true;
    // Never silently strand a chapter editor when the operator changes story.
    if (!discardChapterEditorForContextSwitch("มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วเปลี่ยนเรื่องหรือไม่?")) {
      return false;
    }
    setSelectedStoryKey(storyKey);
    return true;
  };
  const selectPackForActiveStory = (workItemId: number) => {
    if (!Number.isInteger(workItemId)) return false;
    if (workItemId === selectedSourceWorkItemId) return true;
    // A same-story pack switch is also a context switch: clear the current
    // chapter only after the same dirty-editor confirmation boundary passes.
    if (!discardChapterEditorForContextSwitch("มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วเปลี่ยนแพ็กหรือไม่?")) {
      return false;
    }
    setSelectedSourceWorkItemId(workItemId);
    return true;
  };
  // IPE-064R4B review round 31 (P1): /workspace/intake is in-app Wouter
  // navigation — the global dirty click-guard alone lets the confirmed
  // navigation unmount the page WITHOUT running the canonical
  // discardChapterEditorForContextSwitch cleanup. Both intake entry points
  // (header link + empty-pack guidance link) route through this single
  // handler: Cancel (or an unexpectedly still-dirty state) prevents the
  // navigation and leaves the editor fully intact; Confirm runs the same
  // discard authority used by story/pack switches, then navigates to the
  // unchanged intake URL contract.
  const navigateToWorkspaceIntake = (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (
      !discardChapterEditorForContextSwitch(
        "มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วไปหน้าตั้งค่า / นำเข้าหรือไม่?"
      )
    ) {
      return;
    }
    navigateIntake(
      `/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : ""}`
    );
  };
  const storyOverviewStories = editorialNovelGroups.map((group: any) => {
    const key = storyKeyFor(group.workspaceNovelId, group.novel?.id);
    const summary = summarizeStoryPacks(group.cards);
    return {
      key,
      title: group.novel?.title ?? "Untitled novel",
      novelId: group.novel?.id ?? null,
      summary,
      overall: storyOverallStatus(summary),
      focused: key === activeStoryKey,
    };
  });
  const activeStoryGroup =
    editorialNovelGroups.find(
      (group: any) => storyKeyFor(group.workspaceNovelId, group.novel?.id) === activeStoryKey
    ) ?? null;

  // IPE-065 (C): keep the evidence query scoped to the ACTIVE story's packs.
  // The scope state only changes when the pack-id set actually changes, so
  // the query key (and its cache entry per story) is stable across unrelated
  // re-renders.
  useEffect(() => {
    const ids = (activeStoryGroup?.cards ?? [])
      .map((card: any) => card.workItemId)
      .filter((id: any): id is number => Number.isInteger(id) && id > 0)
      .sort((left: number, right: number) => left - right);
    setActiveEvidenceScopeIds((current) =>
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : ids
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoryKey, activeStoryGroup?.cards.length, editorialBoard.data]);

  // IPE-065R2/R3: scope activation reconciles tombstoned ids even when React
  // Query still considers cached data fresh — staleTime never overrides the
  // fence. Activation routes through the centralized generation-bound
  // reconciliation (no render loop: a successful reconciliation releases the
  // tombstones, so the next run finds nothing to reconcile; a FAILED one
  // leaves them and may retry on the next legitimate activation).
  useEffect(() => {
    if (!scopeNeedsReconciliation(activeEvidenceScopeIds, evidenceLifecycleRef.current.invalidatedIds)) return;
    void reconcileInvalidatedEvidence(activeEvidenceScopeIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEvidenceScopeIds, evidenceRevision]);

  // IPE-065R8A: bounded progressive background hydration. The queue covers
  // every non-active story with Episode Packs that has not hydrated in this
  // lifecycle, in deterministic order; ONE story hydrates at a time
  // (concurrency 1 — no thundering herd, active story always first via its
  // own scoped query). DATA-only: no navigation/selection side effects; the
  // merge goes through the tombstone-fenced lifecycle container; the whole
  // request is fenced by workspace id + epoch.
  const backgroundHydrationQueue = useMemo(
    () =>
      buildBackgroundHydrationQueue({
        activeStoryKey,
        statuses: storyHydrationRef.current.statuses,
        groups: editorialNovelGroups.map((group: any) => ({
          key: storyKeyFor(group.workspaceNovelId, group.novel?.id),
          workItemIds: (group.cards ?? [])
            .map((card: any) => card.workItemId)
            .filter((id: any): id is number => Number.isInteger(id) && id > 0)
            .sort((left: number, right: number) => left - right),
        })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeStoryKey, editorialNovelGroups, evidenceRevision]
  );
  const backgroundHydrationQueueKey = backgroundHydrationQueue
    .map((entry) => entry.key)
    .join(",");
  useEffect(() => {
    if (!isAdmin || !selectedWorkspaceId) return;
    // IPE-065R8B (§3): concurrency 1 PER CURRENT LIFECYCLE — only a
    // same-lifecycle owner blocks the runner. An old lifecycle's in-flight
    // request is non-authoritative and does not count against this queue,
    // so B starts immediately without waiting for A's settlement.
    if (
      backgroundHydrationOwnerBlocksCurrentLifecycle(
        backgroundHydrationOwnerRef.current,
        selectedWorkspaceId,
        evidenceWorkspaceIdentityRef.current.epoch
      )
    ) {
      return;
    }
    const next = backgroundHydrationQueue[0];
    if (!next) return;
    const capturedWorkspaceId = selectedWorkspaceId;
    if (!capturedWorkspaceId) return;
    const capturedEpoch = evidenceWorkspaceIdentityRef.current.epoch;
    const capturedLifecycleEpoch = evidenceLifecycleRef.current.epoch;
    // IPE-065R8B (§2): claim a lifecycle-owned request identity —
    // workspaceId + epoch + storyKey + monotonic requestId.
    const capturedRequestId = ++backgroundHydrationRequestIdRef.current;
    const capturedOwner: BackgroundHydrationOwner = {
      workspaceId: capturedWorkspaceId,
      epoch: capturedEpoch,
      storyKey: next.key,
      requestId: capturedRequestId,
    };
    storyHydrationRef.current.statuses.set(next.key, "loading");
    backgroundHydrationOwnerRef.current = capturedOwner;
    setBackgroundHydrationOwner(capturedOwner);
    bumpEvidenceRevision();
    void (async () => {
      try {
        // Story-scoped request: ONLY this story's pack ids — never a
        // workspace-wide projection. fetch owns this request independently
        // of the active-story query instance (fresh cache reuse, else fetch).
        const resultRows = await utils.workspace.editorial.evidenceStatuses.fetch(
          { workspaceId: capturedWorkspaceId, workItemIds: next.workItemIds },
          { staleTime: 30_000 }
        );
        // Lifecycle fence: workspace id AND epoch must still match — an old
        // lifecycle's response (switch, or ABA return) is rejected whole.
        if (
          !sameEvidenceWorkspaceLifecycle(
            evidenceWorkspaceIdentityRef.current,
            capturedWorkspaceId,
            capturedEpoch
          ) ||
          evidenceLifecycleRef.current.epoch !== capturedLifecycleEpoch
        ) {
          return;
        }
        const lifecycle = evidenceLifecycleRef.current;
        // IPE-065R8B (§8/§9): board-removal guard FIRST — rows for
        // workItems the current board no longer contains (removed pack or
        // whole removed story) are discarded before the merge, so the
        // lifecycle evidence container never regains removed rows.
        const boardRows = filterEvidenceRowsToCurrentBoard(
          Array.isArray(resultRows) ? resultRows : [],
          new Set(editorialEvidenceWorkItemIdsRef.current)
        );
        // Tombstone-fenced merge: tombstoned packs in the response are
        // skipped — only the explicit generation-bound reconciliation may
        // restore them. Unrelated rows are preserved. The two fences
        // compose (board filter never bypasses tombstones).
        const merged = mergeEvidenceRowsSkippingInvalidated(
          lifecycle.rows,
          boardRows,
          lifecycle.invalidatedIds
        );
        if (merged) lifecycle.rows = merged;
        if (storyHydrationRef.current.epoch === capturedEpoch) {
          storyHydrationRef.current.statuses.set(next.key, "loaded");
        }
      } catch {
        // Failed story: fail-closed, do not block the rest of the queue —
        // the next queued story becomes eligible on this settle.
        if (storyHydrationRef.current.epoch === capturedEpoch) {
          storyHydrationRef.current.statuses.set(next.key, "failed");
        }
      } finally {
        // IPE-065R8B (§4/§6): ownership-safe release — this settlement
        // clears the marker ONLY if it is still the current owner; an old
        // lifecycle's request settling late can never release a newer
        // lifecycle's in-flight hydration.
        const released = releaseOwnedBackgroundHydration(
          backgroundHydrationOwnerRef.current,
          capturedOwner
        );
        if (released !== backgroundHydrationOwnerRef.current) {
          backgroundHydrationOwnerRef.current = released;
          setBackgroundHydrationOwner(released);
        }
        bumpEvidenceRevision();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAdmin,
    selectedWorkspaceId,
    backgroundHydrationOwner,
    backgroundHydrationQueueKey,
    evidenceRevision,
    activeStoryKey,
  ]);

  // Persist the live pack/chapter/tab/filter into the active story's record.
  useEffect(() => {
    if (!activeStoryKey) return;
    const remembered = resolveStoryUiState(storyUiStatesRef.current, activeStoryKey);
    const pack = selectedSourceWorkItemId ?? null;
    const chapter = chapterEditorTarget?.sourceTabId ?? null;
    const issuesOnly = chapterEditorTabFilter === "issue";
    if (
      remembered.packWorkItemId !== pack ||
      remembered.chapterSourceTabId !== chapter ||
      remembered.activeTab !== (packDetailTab as StoryPackTab) ||
      remembered.issuesOnly !== issuesOnly
    ) {
      setStoryUiStates((states) =>
        updateStoryUiState(states, activeStoryKey, {
          packWorkItemId: pack,
          chapterSourceTabId: chapter,
          activeTab: packDetailTab as StoryPackTab,
          issuesOnly,
        })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoryKey, selectedSourceWorkItemId, chapterEditorTarget?.sourceTabId, packDetailTab, chapterEditorTabFilter]);

  // Switching stories: restore the remembered pack, tab, filter, and re-open
  // the chapter that was being edited (once the pack's draft tabs arrive).
  const lastRestoredStoryRef = useRef<string | null>(null);
  const pendingChapterRestoreRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeStoryKey || lastRestoredStoryRef.current === activeStoryKey) return;
    lastRestoredStoryRef.current = activeStoryKey;
    const remembered = resolveStoryUiState(storyUiStatesRef.current, activeStoryKey);
    // A selection made just before the focus switch (e.g. from the full
    // management table) wins when it already belongs to this story.
    const selectionBelongsToActiveStory =
      selectedSourceWorkItemId != null &&
      activeStoryGroup?.cards.some((card: any) => card.workItemId === selectedSourceWorkItemId);
    setSelectedSourceWorkItemId(
      selectionBelongsToActiveStory ? selectedSourceWorkItemId : remembered.packWorkItemId ?? undefined
    );
    setPackDetailTab(remembered.activeTab);
    setChapterEditorTabFilter(remembered.issuesOnly ? "issue" : "all");
    if (remembered.chapterSourceTabId) {
      pendingChapterRestoreRef.current = remembered.chapterSourceTabId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoryKey]);

  // IPE-064R3 UX: the daily context (story/pack/chapter) lives in the URL —
  // refresh, bookmark or a shared link restores the exact place. Restore
  // runs once when the board first arrives; the story-switch machinery
  // above then re-opens the seeded pack/chapter through storyUiStates.
  const urlRestoreAppliedRef = useRef(false);
  // IPE-064R4B review round 33 (P2): "settled" means both workspace-scoped
  // queries have SUCCESSFULLY resolved for the current workspace — !isLoading
  // alone also covers an ERROR state (failed first request, groups still
  // empty), and consuming the restore there would let the URL writer erase
  // the bookmarked story/pack/chapter before any retry could restore it. A
  // genuine retry-then-succeed path either restores the bookmark normally
  // (groups present) or consumes it only once the workspace is proven empty.
  const editorialWorkspaceDataSettled =
    Boolean(selectedWorkspaceId) && editorialBoard.isSuccess && detail.isSuccess;
  useEffect(() => {
    if (urlRestoreAppliedRef.current) return;
    // IPE-064R4B review round 11 (P1): wait for the workspace LIST before
    // consuming or rewriting anything — otherwise a workspace-only URL
    // (?workspace=B) is stripped by the writer before the initializer can
    // honor it.
    if (!workspaces.data?.length) return;
    const params = new URLSearchParams(window.location.search);
    const storyParam = params.get("story");
    if (!storyParam) {
      urlRestoreAppliedRef.current = true;
      return;
    }
    // IPE-064R4B (P2): resolve the workspace that owns the story BEFORE the
    // story lookup — a bookmark targeting workspace B must not strand on an
    // empty first workspace (editorialNovelGroups.length === 0 would
    // otherwise make the switch branch unreachable).
    // IPE-064R4B review round 7 (P2): a stale/mistyped workspace id must be
    // validated against the loaded workspace list — otherwise the page
    // switches to a nonexistent workspace and strands empty.
    const workspaceParam = Number(params.get("workspace"));
    const workspaceParamValid =
      Number.isInteger(workspaceParam) &&
      workspaceParam > 0 &&
      (workspaces.data as any[] | undefined)?.some(
        ({ workspace }: any) => workspace.id === workspaceParam
      );
    if (workspaceParamValid && workspaceParam !== selectedWorkspaceId) {
      setSelectedWorkspaceId(workspaceParam);
      return;
    }
    if (!editorialNovelGroups.length) {
      // IPE-064R4B review round 29 (P2): a zero-group list is evidence of a
      // removed story only once the workspace's board/detail queries have
      // SETTLED. A settled empty workspace consumes the stale restore exactly
      // like the !group branch below — the URL writer then canonicalizes from
      // live state and the stale ?workspace param can no longer yank the
      // operator back into the empty workspace. While still loading, keep
      // waiting: consuming here would eat legitimate bookmarks whose groups
      // are merely still in flight.
      if (!editorialWorkspaceDataSettled) return;
      urlRestoreAppliedRef.current = true;
      return;
    }
    const group = editorialNovelGroups.find(
      (candidate: any) =>
        storyKeyFor(candidate.workspaceNovelId, candidate.novel?.id) === storyParam
    );
    if (!group) {
      urlRestoreAppliedRef.current = true;
      return;
    }
    urlRestoreAppliedRef.current = true;
    const packParam = Number(params.get("pack"));
    const chapterParam = params.get("chapter");
    const packValid =
      Number.isInteger(packParam) &&
      packParam > 0 &&
      group.cards.some((card: any) => card.workItemId === packParam);
    setSelectedStoryKey(storyParam);
    setStoryEntered(true);
    if (packValid) setSelectedSourceWorkItemId(packParam);
    setStoryUiStates((states) =>
      updateStoryUiState(states, storyParam, {
        packWorkItemId: packValid ? packParam : null,
        chapterSourceTabId: chapterParam ?? null,
        activeTab: "editor" as StoryPackTab,
        issuesOnly: false,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorialNovelGroups.length, editorialWorkspaceDataSettled, selectedWorkspaceId, editorialBoard.data, workspaces.data]);

  // Keep the URL in sync with the live context (replaceState — no history
  // spam). Skipped until the one-time restore has consumed the params.
  useEffect(() => {
    if (!urlRestoreAppliedRef.current) return;
    const params = new URLSearchParams();
    // IPE-064R4B review round 12 (P2): the workspace parameter survives even
    // in story-picker mode — refresh/bookmark of the picker must not fall
    // back to the first workspace.
    if (selectedWorkspaceId) params.set("workspace", String(selectedWorkspaceId));
    if (storyEntered && activeStoryKey) {
      params.set("story", activeStoryKey);
      if (selectedSourceWorkItemId) params.set("pack", String(selectedSourceWorkItemId));
      if (chapterEditorTarget?.sourceTabId) params.set("chapter", chapterEditorTarget.sourceTabId);
    }
    const queryString = params.toString();
    window.history.replaceState(
      null,
      "",
      queryString ? `/workspace?${queryString}` : "/workspace"
    );
  }, [
    storyEntered,
    activeStoryKey,
    selectedWorkspaceId,
    selectedSourceWorkItemId,
    chapterEditorTarget?.sourceTabId,
  ]);

  // IPE-064R3 UX: jump target — the next needs-fix pack in episode order
  // (wrapping around), for the tree's cross-pack navigation button.
  const activeStoryPacks = activeStoryGroup ? activeStoryGroup.cards : [];
  // IPE-064R4B (P1): pack ids belonging to the ACTIVE story — the bulk
  // action-bar scope is intersected with this list so a selection parked in
  // another story is never mutated from the wrong context.
  const storySelectableWorkItemIds = activeStoryPacks
    .map((card: any) => card.workItemId)
    .filter((id: any) => Number.isInteger(id) && id > 0);
  const nextNeedsFixPackId = (() => {
    const needsFixIds = sortPacksByEpisode(activeStoryPacks)
      .filter(
        (card: any) =>
          card.workItemId != null &&
          derivePackStatus(card.evidence) === "needs_fix"
      )
      .map((card: any) => card.workItemId as number);
    if (!needsFixIds.length) return null;
    const at =
      selectedSourceWorkItemId != null
        ? needsFixIds.indexOf(selectedSourceWorkItemId)
        : -1;
    return needsFixIds[(at + 1) % needsFixIds.length] ?? null;
  })();
  // IPE-064R3: review summary renders from the light outline (unfiltered —
  // the tree applies its own tab filter; the summary always shows all).
  const reviewChapters = packOutlineRows.map(entry => entry.row);
  const jumpToReviewChapter = (sourceTabId: string) => {
    const tab = chapterEditorTabs.find((candidate: any) => candidate.sourceTabId === sourceTabId);
    if (tab) openChapterEditor(tab);
  };

  // IPE-064: bulk scope for the action bar — selected packs, or the pack
  // open in the editor when nothing is selected.
  const bulkBusy =
    bulkRunEditorialChecker.isPending ||
    bulkApproveEditorialDrafts.isPending ||
    bulkStageEditorialDrafts.isPending ||
    bulkRequestEditorialPublish.isPending;
  // IPE-064R4B (P1): the bulk scope is intersected with the ACTIVE story's
  // packs — a selection parked in another story must never be mutated by the
  // action bar of the story currently on screen.
  const rawBulkSelection = selectedEditorialWorkItemIds.length
    ? selectedEditorialWorkItemIds
    : selectedSourceWorkItemId
      ? [selectedSourceWorkItemId]
      : [];
  const intersectedBulkSelection = rawBulkSelection.filter((workItemId: number) =>
    storySelectableWorkItemIds.includes(workItemId)
  );
  const actionBarWorkItemIds = intersectedBulkSelection.length
    ? intersectedBulkSelection
    : selectedSourceWorkItemId && storySelectableWorkItemIds.includes(selectedSourceWorkItemId)
      ? [selectedSourceWorkItemId]
      : [];
  const actionBarScopeLabel = actionBarWorkItemIds.length
    ? intersectedBulkSelection.length
      ? `เลือก ${actionBarWorkItemIds.length} แพ็ก`
      : "แพ็กที่เปิดอยู่"
    : "ยังไม่ได้เลือกแพ็ก";
  // IPE-064R4B round 24 (P1): unsaved editor edits live only in the browser —
  // the bulk endpoints operate on the server-side latestDraft. While the open
  // pack is inside the action-bar scope and dirty, the bar must not fire, or
  // an operator can publish stale content believing the visible edits are
  // included.
  const actionBarContainsDirtyOpenPack =
    chapterEditorDirty &&
    selectedSourceWorkItemId != null &&
    actionBarWorkItemIds.includes(selectedSourceWorkItemId);
  const actionBarCards = editorialCards.filter((card: any) =>
    actionBarWorkItemIds.includes(card.workItemId)
  );
  // IPE-064R4B round 22 (P2): the bulk endpoints cap workItemIds at 100
  // (server/workspace/router.ts bulk*.max(100)), so a select-all over a large
  // story must not send the whole array in one request — it would be rejected
  // wholesale before any pack is processed. Split the scope into
  // endpoint-sized batches and run them sequentially; every batch refreshes
  // and toasts through the existing mutation hooks, and a failed batch stops
  // the remaining ones while the batches already applied stay visible.
  const BULK_ACTION_BATCH_LIMIT = 100;
  const runBulkAction = (
    action: "check" | "confirm" | "stage" | "publish"
  ) => {
    if (!selectedWorkspaceId || !actionBarWorkItemIds.length) return;
    // Round 24 (P1): mirror of the bar's disabled state — the bulk endpoints
    // never see browser-only edits, so a dirty in-scope pack must not fire.
    if (actionBarContainsDirtyOpenPack) return;
    let confirmed = true;
    if (action === "publish") {
      const readyCount = actionBarCards.filter(
        (card: any) => card.evidence?.readyToPublish && !card.evidence?.published
      ).length;
      const blockedCount = actionBarCards.length - readyCount;
      confirmed = window.confirm(
        `Controlled Publish\n\nพร้อมลง ${readyCount} ตอน · ยังไม่พร้อม ${blockedCount} ตอน\n\nรายการที่ไม่ผ่าน readiness / ownership / evidence จะไม่ถูกเผยแพร่`
      );
    }
    if (!confirmed) return;
    const batches: number[][] = [];
    for (
      let at = 0;
      at < actionBarWorkItemIds.length;
      at += BULK_ACTION_BATCH_LIMIT
    ) {
      batches.push(
        actionBarWorkItemIds.slice(at, at + BULK_ACTION_BATCH_LIMIT)
      );
    }
    const runBatches = async () => {
      for (const workItemIds of batches) {
        if (action === "check") {
          await bulkRunEditorialChecker.mutateAsync({
            workspaceId: selectedWorkspaceId,
            workItemIds,
          });
        } else if (action === "confirm") {
          await bulkApproveEditorialDrafts.mutateAsync({
            workspaceId: selectedWorkspaceId,
            workItemIds,
          });
        } else if (action === "stage") {
          await bulkStageEditorialDrafts.mutateAsync({
            workspaceId: selectedWorkspaceId,
            workItemIds,
          });
        } else {
          await bulkRequestEditorialPublish.mutateAsync({
            workspaceId: selectedWorkspaceId,
            workItemIds,
          });
        }
      }
    };
    // The mutation hooks toast per batch (success and transport error alike);
    // swallow the rejection here so the remaining batches simply stop.
    void runBatches().catch(() => undefined);
  };
  // IPE-064: master select-all over the active story's packs.
  const activeStorySelectableIds = activeStoryPacks
    .map((card: any) => card.workItemId)
    .filter((id: any) => Number.isInteger(id) && id > 0);
  const allStoryPacksSelected =
    activeStorySelectableIds.length > 0 &&
    activeStorySelectableIds.every((id: number) => selectedEditorialSet.has(id));
  const toggleAllStoryPacks = () =>
    setSelectedEditorialWorkItemIds((current) =>
      allStoryPacksSelected
        ? current.filter((id) => !activeStorySelectableIds.includes(id))
        : Array.from(new Set([...current, ...activeStorySelectableIds]))
    );

  if (adminLoading) {
    return (
      <main className="mx-auto flex min-h-[40vh] max-w-7xl items-center justify-center px-4 py-8">
        <Loader2 className="h-7 w-7 animate-spin" />
      </main>
    );
  }

  if (!isAdmin) return null;

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="flex flex-col gap-3 border-b pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {storyEntered && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="workspace-back-to-stories"
              onClick={() => setStoryEntered(false)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              ย้อนกลับ เลือกเรื่อง
            </Button>
          )}
          <div>
            <p className="text-sm font-medium text-primary">IpeNovel Workspace · Editorial</p>
            <h1 className="text-3xl font-bold tracking-tight">
              {storyEntered ? activeStoryGroup?.novel?.title ?? "Editorial Board" : "Editorial Board"}
            </h1>
          </div>
          {storyEntered && storyOverviewStories.length > 1 && (
            <select
              aria-label="สลับเรื่อง"
              data-testid="workspace-story-switcher"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={activeStoryKey ?? ""}
              onChange={(event) => {
                if (selectStory(event.target.value)) setStoryEntered(true);
              }}
            >
              {storyOverviewStories.map((story) => (
                <option key={story.key} value={story.key}>
                  {story.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <Link href="/novels" className="text-sm text-primary underline">Back to IpeNovel</Link>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Workspace</span>
        <select aria-label="Workspace" className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm" value={selectedWorkspaceId ?? ""} onChange={(event) => setSelectedWorkspaceId(Number(event.target.value) || undefined)}>
          <option value="">เลือก Workspace</option>
          {(workspaces.data as any[] | undefined)?.map(({ workspace }: any) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <Link
          href={`/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : ""}`}
          className="text-sm text-primary underline"
          data-testid="workspace-intake-link"
          data-intake-guarded-link="1"
          onClick={navigateToWorkspaceIntake}
        >
          ตั้งค่า / นำเข้า
        </Link>
        {selectedWorkspaceId && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="workspace-novel-export-trigger"
            disabled={!exportNovelOptions.length}
            onClick={() => setExportDialogOpen(true)}
          >
            ส่งออก
          </Button>
        )}
      </div>

      <WorkspaceNovelExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        novels={exportNovelOptions}
      />

      <section className="space-y-6">
        {/* IPE-064: workspace creation/management moved to /workspace/intake;
            the picker card remains for first-run discovery. */}
        <Card className={workspaces.data?.length ? "hidden" : "space-y-4 p-5"}>
          <div>
            <h2 className="font-semibold">Workspaces</h2>
            <p className="text-sm text-muted-foreground">All platform admins can open every active workspace.</p>
          </div>
          {workspaces.isLoading ? (
            <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          ) : (
            <div className="space-y-2">
              {(workspaces.data as any[] | undefined)?.map(({ workspace }: any) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className={`w-full rounded-md border p-3 text-left transition hover:border-primary ${selectedWorkspaceId === workspace.id ? "border-primary bg-primary/5" : ""}`}
                >
                  <div className="font-medium">{workspace.name}</div>
                  <div className="text-xs text-muted-foreground">admin access · {workspace.status}</div>
                </button>
              ))}
              {!workspaces.data?.length && <p className="text-sm text-muted-foreground">Create your first workspace to begin.</p>}
            </div>
          )}
        </Card>

        {!selectedWorkspaceId ? (
          <Card className="flex min-h-72 items-center justify-center p-6 text-center text-muted-foreground">
            Select a workspace to inspect its operational read models.
          </Card>
        ) : detail.isLoading ? (
          <Card className="flex min-h-72 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></Card>
        ) : selected ? (
          <div className="space-y-6">
            {/* IPE-062: multi-story work area — story overview cards + the
                focused story's three panes (pack list | pack detail |
                review summary + actions). */}
            {!storyEntered ? (
              <WorkspaceStoryOverview
                stories={storyOverviewStories}
                onFocusStory={(storyKey) => {
                  if (selectStory(storyKey)) setStoryEntered(true);
                }}
              />
            ) : null}
            {storyEntered && activeStoryPacks.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">
                เรื่องนี้ยังไม่มีแพ็ก — เพิ่มตอนผ่านหน้า{" "}
                <Link
                  href={`/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : ""}`}
                  data-intake-guarded-link="1"
                  onClick={navigateToWorkspaceIntake}
                >
                  ตั้งค่า / นำเข้า
                </Link>{" "}
                ก่อน
              </Card>
            ) : null}
            {storyEntered && activeStoryGroup ? (

            <div className="grid items-start gap-4 xl:grid-cols-[minmax(250px,0.65fr)_minmax(0,2.1fr)_minmax(280px,0.85fr)]" data-testid="workspace-master-detail">
            {activeStoryGroup ? (
                <div className="space-y-3">
                {/* IPE-062R4D fix: ONE wrapper per grid column — the tree and
                    the chapter tools share the left column so the outer
                    3-column grid keeps exactly three direct children. */}
              <WorkspacePackListPanel
                storyTitle={activeStoryGroup.novel?.title ?? "Untitled novel"}
                packs={activeStoryPacks}
                selectedWorkItemId={selectedSourceWorkItemId}
                bulkSelectedWorkItemIds={selectedEditorialSet}
                bulkBusy={bulkBusy}
                allSelected={allStoryPacksSelected}
                onToggleAll={toggleAllStoryPacks}
                nextNeedsFixPackId={nextNeedsFixPackId}
                onJumpToPack={(workItemId) => {
                  selectPackForActiveStory(workItemId);
                }}
                onSelectPack={selectPackForActiveStory}
                onToggleBulk={toggleEditorialSelection}
                onOpenEditor={(card) => {
                  if (selectPackForActiveStory(card.workItemId)) {
                    setPendingEditorOpenWorkItemId(card.workItemId);
                  }
                }}
                onEditRange={(card, next) =>
                  updateEditorialEpisode.mutate({
                    workspaceId: selectedWorkspaceId,
                    workItemId: card.workItemId,
                    episodeNumber: next,
                    episodeTitle: card.episodeTitle || undefined,
                  })
                }
                onEditSale={(card, mode, price) => {
                  if (mode === "free") {
                    updateEditorialEpisodeSale.mutate({
                      workspaceId: selectedWorkspaceId,
                      workItemId: card.workItemId,
                      price: "0.00",
                      isFree: true,
                    });
                    return;
                  }
                  updateEditorialEpisodeSale.mutate({
                    workspaceId: selectedWorkspaceId,
                    workItemId: card.workItemId,
                    price: price ?? "100.00",
                    isFree: false,
                  });
                }}
                onEditNote={(card, next) =>
                  updateEditorialWorkItemNote.mutate({
                    workspaceId: selectedWorkspaceId,
                    workItemId: card.workItemId,
                    note: next || null,
                    expectedVersion: card.workItemVersion,
                  })
                }
                onRemove={(card) =>
                  removeEditorialEpisode.mutate({
                    workspaceId: selectedWorkspaceId,
                    workItemId: card.workItemId,
                  })
                }
                editRangePending={updateEditorialEpisode.isPending}
                editSalePending={updateEditorialEpisodeSale.isPending}
                editNotePending={updateEditorialWorkItemNote.isPending}
                removePending={removeEditorialEpisode.isPending}
                chapters={packTreeChapters}
                activeChapterTabId={chapterEditorTarget?.sourceTabId ?? null}
                onSelectChapter={(row) => {
                  const tab = chapterEditorTabs.find((candidate: any) => candidate.sourceTabId === row.sourceTabId);
                  // IPE-064R3: tree rows now render from the light outline and
                  // can appear before the full paragraph payload arrives.
                  if (!tab) {
                    toast.info("กำลังโหลดเนื้อหาบท — กดอีกครั้งในอีกสักครู่");
                    return;
                  }
                  openChapterEditor(tab);
                }}
              />
              {selectedSourceWorkItemId && (
                <Card className="space-y-2 p-3" data-testid="workspace-chapter-tools">
                  <div className="flex flex-wrap gap-2 text-xs">
                    {draftStructureSummary.sequenceIssues.length > 0 && (
                      <span className="rounded-full border px-2 py-0.5">
                        เลขแท็บไม่เรียง {draftStructureSummary.sequenceIssues.length}
                      </span>
                    )}
                    {draftStructureSummary.emptyTabs.length > 0 && (
                      <span className="rounded-full border px-2 py-0.5">
                        แท็บว่าง {draftStructureSummary.emptyTabs.length}
                      </span>
                    )}
                    {draftStructureSummary.unnumberedTabs.length > 0 && (
                      <span className="rounded-full border px-2 py-0.5">
                        ไม่มีเลขแท็บ {draftStructureSummary.unnumberedTabs.length}
                      </span>
                    )}
                    {draftStructureSummary.shortTabs.length > 0 && (
                      <span className="rounded-full border px-2 py-0.5">
                        เนื้อหาสั้นผิดปกติ {draftStructureSummary.shortTabs.length}
                      </span>
                    )}
                    {draftStructureSummary.warningTabs.length > 0 && (
                      <span className="rounded-full border px-2 py-0.5">
                        warning {draftStructureSummary.warningTabs.length}
                      </span>
                    )}
                  </div>
                  {(draftStructureSummary.sequenceIssues.length > 0 ||
                    draftStructureSummary.emptyTabs.length > 0 ||
                    draftStructureSummary.unnumberedTabs.length > 0 ||
                    draftStructureSummary.shortTabs.length > 0) && (
                    <div className="space-y-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      {draftStructureSummary.sequenceIssues.length > 0 && (
                        <div>ลำดับ: {draftStructureSummary.sequenceIssues.join(", ")}</div>
                      )}
                      {draftStructureSummary.emptyTabs.length > 0 && (
                        <div>
                          ไม่มีเนื้อหา: {compactTabTitles(draftStructureSummary.emptyTabs)}
                        </div>
                      )}
                      {draftStructureSummary.unnumberedTabs.length > 0 && (
                        <div>
                          อ่านเลขแท็บไม่ได้: {compactTabTitles(draftStructureSummary.unnumberedTabs)}
                        </div>
                      )}
                      {draftStructureSummary.shortTabs.length > 0 && (
                        <div>
                          สั้นผิดปกติ: {draftStructureSummary.shortTabs
                            .slice(0, 6)
                            .map(tab => `${tab.title} (${tab.characterCount} ตัวอักษร)`)
                            .join(", ")}
                          {draftStructureSummary.shortTabs.length > 6
                            ? ` และอีก ${draftStructureSummary.shortTabs.length - 6}`
                            : ""}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="font-medium">
                        แท็บใน Draft · {filteredChapterEditorTabs.length}/{chapterEditorTabs.length}
                      </div>
                      <div className="flex flex-wrap gap-1 text-xs">
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">
                          ผ่าน {chapterEditorProgress.passed}
                        </span>
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900">
                          ค้าง {chapterEditorProgress.pending}
                        </span>
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800">
                          ยืนยันแล้ว {chapterEditorProgress.confirmed}
                        </span>
                        {chapterEditorProgress.unchecked > 0 && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                            ยังไม่ตรวจ {chapterEditorProgress.unchecked}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {([
                        ["all", "ทั้งหมด"],
                        ["issue", "มีปัญหา"],
                        ["unedited", "ยังไม่แก้"],
                        ["edited", "แก้แล้ว"],
                      ] as const).map(([value, label]) => (
                        <Button
                          key={value}
                          type="button"
                          size="sm"
                          variant={chapterEditorTabFilter === value ? "secondary" : "outline"}
                          onClick={() => setChapterEditorTabFilter(value)}
                        >
                          {label}
                        </Button>
                      ))}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!nextIssueChapterTab || editEditorialDraft.isPending}
                        onClick={() =>
                          nextIssueChapterTab && openChapterEditor(nextIssueChapterTab)
                        }
                      >
                        บทมีปัญหาถัดไป
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          !editorialEditorData?.canUndo ||
                          !latestEditorialDraft ||
                          undoEditorialEdit.isPending
                        }
                        onClick={() => {
                          if (!latestEditorialDraft) return;
                          undoEditorialEdit.mutate({
                            workspaceId: selectedWorkspaceId,
                            workItemId: selectedSourceWorkItemId,
                            expectedDraftId: latestEditorialDraft.id,
                            expectedDraftVersion: latestEditorialDraft.version,
                            expectedDraftSha256: latestEditorialDraft.draftSha256,
                            idempotencyKey: `editor-undo:${latestEditorialDraft.id}:${latestEditorialDraft.version}`,
                          });
                        }}
                      >
                        {undoEditorialEdit.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Undo
                      </Button>
                      {/* IPE-062R4D: tab exclusion for the open chapter — the
                          exclusion control stays on the visible draft structure
                          (tools rail) after the old per-row buttons retired. */}
                      {chapterEditorTarget && editorialEditorData?.latestDraft && (() => {
                        const draftTab = (editorialEditorData.tabs ?? []).find(
                          (candidate: any) => candidate.sourceTabId === chapterEditorTarget.sourceTabId
                        );
                        if (!draftTab) return null;
                        return (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={excludeEditorialTab.isPending || editorialEditorData.tabs.length <= 1}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `นำแท็บ ${chapterEditorTarget.title} ออกจาก Draft นี้หรือไม่? ระบบจะสร้าง Draft revision ใหม่ และต้องตรวจ QC/ยืนยันใหม่`
                                )
                              ) {
                                excludeEditorialTab.mutate({
                                  workspaceId: selectedWorkspaceId!,
                                  workItemId: selectedSourceWorkItemId!,
                                  expectedDraftId: editorialEditorData.latestDraft.id,
                                  expectedDraftSha256: editorialEditorData.latestDraft.draftSha256,
                                  sourceTabId: draftTab.sourceTabId,
                                });
                              }
                            }}
                          >
                            นำออก
                          </Button>
                        );
                      })()}
                    </div>
                  </div>
                </Card>
              )}
                </div>
            ) : (
              <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-semibold">Editorial Episode Packs</h2>
                    </div>
                  </div>
                  <StatusPill value={(editorialBoard.data as any)?.board?.status ?? "initializing"} />
                </div>
                {editorialBoard.isLoading || ensureEditorialBoard.isPending ? (
                  <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
                ) : (
                  <EmptyState>Editorial board is being prepared for this Workspace.</EmptyState>
                )}
              </Card>
            )}
            {/* IPE-062R4D: editor-first center — the MAIN CHAPTER EDITOR is the
                primary surface; pack metadata/source import collapse below it. */}
            <div className="min-w-0 space-y-3">
              {/* IPE-064: numbered workflow bar (3.ตรวจ / 4.ยืนยัน / 5.Stage /
                  6.Publish) above the editor — scope = selected packs. */}
              <WorkspaceActionBar
                scopeLabel={actionBarScopeLabel}
                disabled={
                  !actionBarWorkItemIds.length ||
                  bulkBusy ||
                  actionBarContainsDirtyOpenPack
                }
                blockedReason={
                  actionBarContainsDirtyOpenPack
                    ? "แพ็กที่เปิดอยู่มีการแก้ไขยังไม่บันทึก — กดบันทึก Draft ก่อนใช้แถบนี้ เพราะการตรวจ/ยืนยัน/Stage/เผยแพร่ ทำงานกับฉบับล่าสุดบนเซิร์ฟเวอร์เท่านั้น"
                    : null
                }
                checkPending={bulkRunEditorialChecker.isPending}
                confirmPending={bulkApproveEditorialDrafts.isPending}
                stagePending={bulkStageEditorialDrafts.isPending}
                publishPending={bulkRequestEditorialPublish.isPending}
                onCheck={() => runBulkAction("check")}
                onConfirm={() => runBulkAction("confirm")}
                onStage={() => runBulkAction("stage")}
                onPublish={() => runBulkAction("publish")}
              />
              {!selectedSourceWorkItemId ? (
                <Card className="space-y-4 p-4">
                  <EmptyState>เลือกแพ็กจากรายการด้านซ้ายเพื่อเริ่มแก้ตอน</EmptyState>
                </Card>
              ) : (
                <>
                  <Card className="space-y-3 p-4" data-testid="workspace-main-editor">
                    <div id="workspace-chapter-editor" className="rounded-md border bg-muted/10 p-3">
                      <div className="min-w-0 space-y-3" data-testid="workspace-chapter-editor-pane">
                    {chapterEditorTarget ? (
                      <div className="space-y-3 rounded-xl border bg-muted/10 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-lg font-semibold">Chapter Editor</div>
                            <div className="text-sm text-muted-foreground">
                              {chapterEditorTarget.title} · Draft v{chapterEditorTarget.draftVersion}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1 text-xs">
                              <span
                                className={
                                  currentChapterStatus?.edited
                                    ? "rounded-full bg-blue-100 px-2 py-0.5 text-blue-800"
                                    : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                                }
                              >
                                {currentChapterStatus?.edited ? "แก้แล้ว" : "ยังไม่แก้"}
                              </span>
                              {(currentChapterStatus?.foreignFindingCount ?? 0) > 0 && (
                                <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-yellow-900">
                                  มีคำต่างประเทศ {currentChapterStatus?.foreignFindingCount}
                                </span>
                              )}
                              {(currentChapterStatus?.structuralIssueCount ?? 0) > 0 && (
                                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-900">
                                  มี structural issue {currentChapterStatus?.structuralIssueCount}
                                </span>
                              )}
                              {chapterEditorDirty && (
                                <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">
                                  ยังไม่บันทึก
                                </span>
                              )}
                            </div>
                          </div>
                          {/* IPE-058-F: sticky toolbar — Prev/Next, state chip,
                              issue count and ONE primary CTA derived from the
                              canonical state machine (no count shortcuts). */}
                          <div className="sticky top-0 z-20 -mx-3 space-y-2 border-b bg-background/95 px-3 py-2 backdrop-blur">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!previousChapterTab || editEditorialDraft.isPending}
                              onClick={() => previousChapterTab && openChapterEditor(previousChapterTab)}
                            >
                              <ChevronLeft className="mr-1 h-4 w-4" />
                              ก่อนหน้า
                            </Button>
                            <span className="text-xs text-muted-foreground">
                              {chapterEditorCurrentIndex >= 0
                                ? `${chapterEditorCurrentIndex + 1}/${chapterEditorTabs.length}`
                                : "—"}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!nextChapterTab || editEditorialDraft.isPending}
                              onClick={() => nextChapterTab && openChapterEditor(nextChapterTab)}
                            >
                              ถัดไป
                              <ChevronRight className="ml-1 h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={editEditorialDraft.isPending}
                              onClick={closeChapterEditor}
                            >
                              ปิด Editor
                            </Button>
                          </div>
                          <WorkspaceEditorialToolbar
                            dirty={chapterEditorDirty}
                            saving={editEditorialDraft.isPending}
                            checkerState={editorialCheckerState}
                            unresolvedCount={editorialCheckerData?.unresolvedCount}
                            issueCount={chapterEditorIssueItems.length}
                            onGoToIssue={() => {
                              // IPE-062R4E: the fix_findings CTA jumps to the
                              // current issue (or the first when none selected).
                              if (!chapterEditorIssueItems.length) return;
                              const boundedIndex = Math.min(
                                chapterEditorIssueIndex,
                                chapterEditorIssueItems.length - 1
                              );
                              const issue =
                                chapterEditorIssueItems[boundedIndex] ??
                                chapterEditorIssueItems[0];
                              navigateChapterEditorIssue(
                                issue,
                                chapterEditorIssueItems.indexOf(issue)
                              );
                            }}
                            onIgnoreIssue={() => {
                              // IPE-062R4F: quick-skip — ignore the current
                              // finding (move names / proper nouns are not
                              // defects) and advance to the next issue.
                              const issue =
                                selectedChapterEditorIssue ??
                                chapterEditorIssueItems[0];
                              if (!issue || issue.kind !== "finding") return;
                              const finding = issue.finding as any;
                              if (finding.disposition !== "open") return;
                              resolveEditorialFinding.mutate({
                                workspaceId: selectedWorkspaceId,
                                workItemId: selectedSourceWorkItemId,
                                findingId: finding.id,
                                disposition: "ignored",
                                expectedVersion: finding.resolutionVersion ?? 0,
                                idempotencyKey: `editorial-ignore:${finding.id}:${finding.resolutionVersion ?? 0}`,
                              });
                              navigateRelativeChapterEditorIssue(1);
                            }}
                            ignorePending={resolveEditorialFinding.isPending}
                            hasDraft={Boolean(latestEditorialDraft)}
                            approvalValid={Boolean(
                              editorialApprovalData?.approvalStatus?.valid
                            )}
                            readyToPublish={Boolean(
                              editorialApprovalData?.readyToPublish
                            )}
                            positionLabel={
                              chapterEditorCurrentIndex >= 0
                                ? `${chapterEditorCurrentIndex + 1}/${chapterEditorTabs.length}`
                                : "—"
                            }
                            onPrev={() =>
                              previousChapterTab &&
                              openChapterEditor(previousChapterTab)
                            }
                            onNext={() =>
                              nextChapterTab && openChapterEditor(nextChapterTab)
                            }
                            prevDisabled={!previousChapterTab}
                            nextDisabled={!nextChapterTab}
                            onSaveCheck={submitChapterEditorEdit}
                            onRunChecker={runCheckerForCurrentDraft}
                            onConfirm={submitApprovalConfirm}
                            onStage={submitStageDraft}
                            confirmDisabled={
                              !editorialApprovalData?.latestDraft ||
                              !editorialApprovalData?.qc?.ready ||
                              !editorialApprovalData?.qc?.checkerRunId ||
                              !editorialApprovalData?.qc?.qcEvidenceSha256 ||
                              Boolean(editorialApprovalData?.approvalStatus?.valid)
                            }
                            stageDisabled={
                              !editorialApprovalData?.approvalStatus?.valid ||
                              !editorialApprovalData?.approval?.id ||
                              !editorialApprovalData?.stagePlan?.ready ||
                              Boolean(editorialApprovalData?.stageStatus?.valid)
                            }
                          />
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 text-sm">
                          <span className="rounded-md border px-2 py-1 font-medium">ข้อความบท</span>
                          <Button
                            type="button"
                            size="sm"
                            variant={chapterEditorHighlight ? "secondary" : "outline"}
                            onClick={() => setChapterEditorHighlight(value => !value)}
                          >
                            ไฮไลต์คำต่างประเทศ {chapterEditorHighlight ? "เปิด" : "ปิด"}
                          </Button>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {chapterEditorText.length.toLocaleString()} ตัวอักษร
                          </span>
                        </div>


                        <div
                          ref={chapterEditorScrollRef}
                          className="min-h-[30rem] max-h-[48rem] overflow-y-auto rounded-lg border bg-background p-5 shadow-inner"
                          onScroll={event => {
                            const sourceTabId = chapterEditorTarget?.sourceTabId;
                            if (!sourceTabId) return;
                            const scrollTop = event.currentTarget.scrollTop;
                            chapterEditorScrollByTab.current.set(sourceTabId, scrollTop);
                            window.sessionStorage.setItem(
                              chapterEditorScrollStorageKey(sourceTabId),
                              String(scrollTop)
                            );
                          }}
                        >
                          {/* IPE-058-C: ONE continuous editing surface. The
                              paragraph model lives in
                              workspaceChapterCanvas.ts — no per-paragraph
                              textareas. */}
                          <ChapterEditorCanvas
                            value={chapterEditorText}
                            flatFindings={chapterEditorCanvasFindings}
                            highlight={chapterEditorHighlight}
                            disabled={editEditorialDraft.isPending}
                            placeholder={
                              chapterEditorParagraphs.length <= 1 &&
                              !chapterEditorText
                                ? "เริ่มเขียนหรือวางเนื้อหาของบทนี้..."
                                : undefined
                            }
                            textareaRef={chapterEditorCanvasRef}
                            onChange={(value, _caret) =>
                              applyChapterEditorCanvasChange(value, false)
                            }
                            onKeyDown={chapterEditorCanvasKeyDown}
                            onPaste={chapterEditorCanvasPaste}
                          />
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs text-muted-foreground">
                            Enter = ย่อหน้าใหม่ · Shift+Enter = ขึ้นบรรทัดในย่อหน้า · Ctrl/Cmd+S = บันทึก · Ctrl/Cmd+Z / Ctrl+Y = เลิก/ทำซ้ำ · วางจาก ChatGPT/Google Docs จะจัดย่อหน้าอัตโนมัติ · สีไฮไลต์เป็น UI เท่านั้น
                          </div>
                          <Button
                            type="button"
                            disabled={
                              editEditorialDraft.isPending ||
                              chapterEditorSaveProjection.text === chapterEditorTarget.expectedText
                            }
                            onClick={submitChapterEditorEdit}
                          >
                            {editEditorialDraft.isPending && (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            บันทึก Draft + ตรวจซ้ำ
                          </Button>
                        </div>
                        <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                          การบันทึกสร้าง Draft revision ใหม่เท่านั้น ไม่ Publish อัตโนมัติ และต้องผ่าน QC/Confirm เดิมก่อน Stage/Publish
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="workspace-chapter-editor-empty">
                        เลือกตอนจากรายการด้านซ้าย — Editor จะเปิดในพื้นที่นี้ทันที ไม่ต้องเลื่อนหา
                      </div>
                    )}
                      </div>
                    </div>
                  </Card>

                  <details className="rounded-lg border bg-background" data-testid="workspace-pack-secondary">
                    <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">รายละเอียดแพ็ก · แหล่งข้อความ · สถานะ Draft</summary>
                    <div className="space-y-3 border-t p-3">
                  <div className="rounded-md border bg-muted/20 p-3 text-sm">
                    <strong>{selectedSourceCard?.novel?.title ?? "Editorial work item"}</strong>
                    {selectedSourceCard?.workItemType === "NEW_EPISODE" && (
                      <span className="ml-2 text-muted-foreground">
                        ตอน {selectedSourceCard?.episodeNumber || "—"} {selectedSourceCard?.episodeTitle || ""}
                      </span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">Work item #{selectedSourceWorkItemId}</span>
                  </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-md border p-3 text-sm">
                        <div className="font-medium">Source</div>
                        <div className="mt-1 text-muted-foreground">
                          {(editorialSourceDraft.data as any)?.source?.title ?? "ยังไม่มีต้นฉบับ"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          snapshots {(editorialSourceDraft.data as any)?.snapshots?.length ?? 0}
                        </div>
                      </div>
                      <div className="rounded-md border p-3 text-sm">
                        <div className="font-medium">Latest Draft</div>
                        <div className="mt-1 text-muted-foreground">
                          {(editorialSourceDraft.data as any)?.latestDraft
                            ? `v${(editorialSourceDraft.data as any).latestDraft.version} · ${(editorialSourceDraft.data as any).latestDraft.transformCode}`
                            : "ยังไม่มี Draft"}
                        </div>
                        <details className="mt-1 text-xs text-muted-foreground Advanced">
                          <summary className="cursor-pointer">Advanced</summary>
                          <div className="mt-1">SHA {shortHash((editorialSourceDraft.data as any)?.latestDraft?.draftSha256)}</div>
                        </details>
                      </div>
                      <div className="rounded-md border p-3 text-sm">
                        <div className="font-medium">Refresh safety</div>
                        <div className="mt-1 text-muted-foreground">
                          {(editorialSourceDraft.data as any)?.refreshPending
                            ? "มี snapshot ใหม่รอ review — ไม่เขียนทับ Draft"
                            : "Draft ตรงกับ source snapshot ล่าสุด"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          transforms {(editorialSourceDraft.data as any)?.transforms?.length ?? 0}
                        </div>
                      </div>
                    </div>
                    {(editorialEditorData?.excludedTabs ?? []).length > 0 && (
                      <details className="rounded-md border bg-background">
                        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                          แท็บที่นำออก {editorialEditorData.excludedTabs.length}
                        </summary>
                        <div className="space-y-2 border-t p-3">
                          {editorialEditorData.excludedTabs.map((tab: any) => (
                            <div key={tab.sourceTabId} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                              <span>{tab.title}</span>
                              <Button type="button" size="sm" variant="outline" disabled={restoreEditorialTab.isPending} onClick={() => restoreEditorialTab.mutate({ workspaceId: selectedWorkspaceId!, workItemId: selectedSourceWorkItemId!, expectedDraftId: editorialEditorData.latestDraft.id, expectedDraftSha256: editorialEditorData.latestDraft.draftSha256, sourceTabId: tab.sourceTabId })}>คืนแท็บ</Button>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    </div>
                  </details>
                </>
              )}
            </div>
            <div className="space-y-3" data-testid="workspace-side-panel">
              {selectedSourceWorkItemId ? (
                <>
                  <WorkspaceReviewSummaryPanel
                    packLabel={(() => {
                      const card = selectedSourceCard;
                      if (!card) return `Work item #${selectedSourceWorkItemId}`;
                      return `${card.novel?.title ?? ""} ${card.episodeNumber ?? ""}`.trim() || `Work item #${selectedSourceWorkItemId}`;
                    })()}
                    chapters={reviewChapters}
                    anomalyCount={currentCheckerAnomalies.length}
                    issuesOnly={chapterEditorTabFilter === "issue"}
                    onToggleIssuesOnly={() =>
                      setChapterEditorTabFilter(chapterEditorTabFilter === "issue" ? "all" : "issue")
                    }
                    onJumpToChapter={jumpToReviewChapter}
                    checkerCurrent={editorialCheckerCurrent}
                    checkerStale={editorialCheckerRunStale}
                    notRun={editorialCheckerState === "NOT_RUN"}
                  />
                  <WorkspaceFindingActions
                    active={Boolean(chapterEditorTarget)}
                    issueCount={chapterEditorIssueItems.length}
                    findingsCount={chapterEditorIssueCounts.findings}
                    structuralCount={chapterEditorIssueCounts.structural}
                    index={chapterEditorIssueIndex}
                    currentIssue={(() => {
                      const issue = selectedChapterEditorIssue;
                      if (!issue) return null;
                      if (issue.kind === "finding") {
                        const finding = issue.finding as any;
                        return {
                          kind: "finding" as const,
                          token: finding.token,
                          ruleKey: finding.ruleKey,
                          sentenceText: finding.sentenceText,
                          paragraphOrder: finding.paragraphOrder,
                          disposition: finding.disposition,
                        };
                      }
                      const anomaly = issue.anomaly as any;
                      return {
                        kind: "structural" as const,
                        anomalyType: anomaly.anomalyType,
                        message: anomaly.message,
                        severity: anomaly.severity,
                        guidance: chapterEditorStructuralRepairGuidance(anomaly.anomalyType),
                        confirmedSourceNote: anomaly.disposition === "confirmed_source_note",
                      };
                    })()}
                    relatedTabs={(() => {
                      const issue = selectedChapterEditorIssue;
                      if (!issue || issue.kind !== "structural") return [];
                      return structuralNavigationTabs(issue.anomaly).map((tab: any) => ({
                        sourceTabId: tab.sourceTabId,
                        title: tab.title,
                      }));
                    })()}
                    checkerStale={editorialCheckerRunStale}
                    rechecking={runEditorialForeignChecker.isPending}
                    canIgnore={Boolean(
                      selectedChapterEditorIssue &&
                        selectedChapterEditorIssue.kind === "finding" &&
                        (selectedChapterEditorIssue.finding as any).disposition === "open" &&
                        !editorialCheckerRunStale
                    )}
                    canAllow={Boolean(
                      selectedChapterEditorIssue &&
                        selectedChapterEditorIssue.kind === "finding" &&
                        (selectedChapterEditorIssue.finding as any).disposition !== "accepted" &&
                        (selectedChapterEditorIssue.finding as any).ruleKey !== "long_english" &&
                        (selectedChapterEditorIssue.finding as any).ruleKey !== "source_junk" &&
                        !editorialCheckerRunStale
                    )}
                    canConfirmSourceNote={Boolean(
                      selectedChapterEditorIssue &&
                        selectedChapterEditorIssue.kind === "structural" &&
                        (selectedChapterEditorIssue.anomaly as any).anomalyType === "source_note_only"
                    )}
                    // IPE-064R4B R32 (P2): reopen is for a reversible resolved
                    // disposition (ignored/fixed) — allowlist-derived accepted
                    // findings must use the existing allow/unallow authority,
                    // never this flow.
                    canReopen={Boolean(
                      selectedChapterEditorIssue &&
                        selectedChapterEditorIssue.kind === "finding" &&
                        ((selectedChapterEditorIssue.finding as any).disposition === "ignored" ||
                          (selectedChapterEditorIssue.finding as any).disposition === "fixed") &&
                        !editorialCheckerRunStale
                    )}
                    ignorePending={resolveEditorialFinding.isPending}
                    allowPending={allowEditorialFinding.isPending}
                    confirmNotePending={setStructuralConfirmation.isPending}
                    unallowPending={unallowEditorialWord.isPending}
                    reopenPending={resolveEditorialFinding.isPending}
                    dirty={chapterEditorDirty}
                    savePending={editEditorialDraft.isPending}
                    allowWords={(editorialCheckerData as any)?.allowWords ?? []}
                    onPrev={() => navigateRelativeChapterEditorIssue(-1)}
                    onNext={() => navigateRelativeChapterEditorIssue(1)}
                    onIgnore={() => {
                      // IPE-062R4F quick-skip contract, relocated from the
                      // toolbar: ignore the current open finding and advance.
                      const issue =
                        selectedChapterEditorIssue ??
                        chapterEditorIssueItems[0];
                      if (!issue || issue.kind !== "finding") return;
                      const finding = issue.finding as any;
                      if (finding.disposition !== "open") return;
                      resolveEditorialFinding.mutate({
                        workspaceId: selectedWorkspaceId,
                        workItemId: selectedSourceWorkItemId,
                        findingId: finding.id,
                        disposition: "ignored",
                        expectedVersion: finding.resolutionVersion ?? 0,
                        idempotencyKey: `editorial-ignore:${finding.id}:${finding.resolutionVersion ?? 0}`,
                      });
                      navigateRelativeChapterEditorIssue(1);
                    }}
                    onAllow={() => {
                      const issue = selectedChapterEditorIssue;
                      if (!issue || issue.kind !== "finding") return;
                      const finding = issue.finding as any;
                      allowEditorialFinding.mutate({
                        workspaceId: selectedWorkspaceId,
                        workItemId: selectedSourceWorkItemId,
                        findingId: finding.id,
                        expectedVersion: finding.resolutionVersion ?? 0,
                        idempotencyKey: `editorial-allow:${finding.id}:${finding.resolutionVersion ?? 0}`,
                      });
                    }}
                    // IPE-064R4B R32 (P2): reopen an accidentally ignored or
                    // resolved-fixed finding — the same resolve mutation with
                    // disposition "open", the current resolutionVersion as
                    // expectedVersion, and a distinct idempotencyKey.
                    onReopen={() => {
                      const issue = selectedChapterEditorIssue;
                      if (!issue || issue.kind !== "finding") return;
                      const finding = issue.finding as any;
                      if (finding.disposition !== "ignored" && finding.disposition !== "fixed") return;
                      resolveEditorialFinding.mutate({
                        workspaceId: selectedWorkspaceId,
                        workItemId: selectedSourceWorkItemId,
                        findingId: finding.id,
                        disposition: "open",
                        expectedVersion: finding.resolutionVersion ?? 0,
                        idempotencyKey: `editorial-reopen:${finding.id}:${finding.resolutionVersion ?? 0}`,
                      });
                    }}
                    onUnallow={(word) =>
                      unallowEditorialWord.mutate({
                        workspaceId: selectedWorkspaceId,
                        normalizedWord: word.normalizedWord,
                      })
                    }
                    onToggleConfirmSourceNote={() => {
                      const issue = selectedChapterEditorIssue;
                      if (!issue || issue.kind !== "structural") return;
                      const anomaly = issue.anomaly as any;
                      setStructuralConfirmation.mutate({
                        workspaceId: selectedWorkspaceId,
                        workItemId: selectedSourceWorkItemId,
                        anomalyId: anomaly.id,
                        confirmed: anomaly.disposition !== "confirmed_source_note",
                        expectedVersion: anomaly.confirmationVersion ?? 0,
                      });
                    }}
                    onOpenRelatedTab={(tab) => {
                      const target = chapterEditorTabs.find(
                        (candidate: any) => candidate.sourceTabId === tab.sourceTabId
                      );
                      if (target) openChapterEditor(target);
                    }}
                    onSave={submitChapterEditorEdit}
                  />
                </>
              ) : (
                <Card className="p-4 text-sm text-muted-foreground">
                  เลือกแพ็กจากรายการด้านซ้ายเพื่อดูสรุปผลตรวจและการทำงานหลัก
                </Card>
              )}
            </div>
            </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
