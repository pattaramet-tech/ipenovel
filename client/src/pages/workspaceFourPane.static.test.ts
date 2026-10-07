// IPE-064 — 4-pane workspace static contract. The daily work area is:
// left = pack/chapter tree with select-all, center-top = numbered action
// bar, center = single chapter canvas, right = finding workflow card.
// Intake/ops tooling lives in its own page. Per repo convention (no
// jsdom/RTL) these read the sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-064 — intake separation", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const intake = source("client/src/pages/WorkspaceIntakePage.tsx");
  const app = source("client/src/App.tsx");

  it("registers the intake route and cross-links both pages", () => {
    expect(app).toContain('path={"/workspace/intake"}');
    // IPE-064R4B (P1): the intake link carries the selected workspace so the
    // intake page cannot fall back to the wrong (first) workspace.
    expect(page).toContain("href={`/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : \"\"}`}");
    expect(page).toContain('params.get("workspace")');
    // IPE-064R4B (P2): the return link carries the managed workspace back.
    expect(intake).toContain("href={`/workspace${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : \"\"}`}");
  });

  it("moves the import/intake tooling out of WorkspacePage", () => {
    expect(page).not.toContain('data-testid="workspace-ops-advanced"');
    expect(page).not.toContain("Google Sheets Master Intake");
    expect(page).not.toContain("2. เพิ่มตอนใหม่");
    expect(page).not.toContain("bulkImportGoogleDocs");
    expect(page).not.toContain("masterIntakeSync");
    expect(intake).toContain("Google Sheets Master Intake");
    expect(intake).toContain("2. เพิ่มตอนใหม่");
    expect(intake).toContain("bulkImportGoogleDocs");
    expect(intake).toContain("masterIntakeSync");
  });

  it("moves per-pack source imports and ops read models to the intake page", () => {
    expect(page).not.toContain('data-testid="workspace-pack-imports"');
    expect(page).not.toContain("Operations / Advanced");
    expect(page).not.toContain('data-testid="workspace-management-table"');
    expect(intake).toContain('data-testid="intake-pack-imports"');
    expect(intake).toContain("Add / Refresh Google Doc");
    expect(intake).toContain("Operations / Advanced");
  });

  it("retires the Issue Queue, Full Checker vNext and Safe Transform Preview cards", () => {
    expect(page).not.toContain("Issue Queue");
    expect(page).not.toContain("Full Checker vNext");
    expect(page).not.toContain("Safe Transform Preview");
    expect(page).not.toContain("Apply เป็น Draft revision ใหม่");
  });

  it("retains only failed files after a partial bulk-file import (IPE-064R4B R33)", () => {
    // Mirror of the Google Docs bulk handler: onSuccess reads the mutation
    // variables, keeps the FAILED result positions only, and retains the
    // original client file objects (name/mimeType/paragraphs/episodeNumber/
    // episodeTitle) so retry resubmits exactly the files that never created
    // their Episode Pack.
    expect(intake).toContain("bulkImportEpisodeFiles.useMutation({");
    expect(intake).toContain("onSuccess: async (results, variables) => {");
    // Positional mapping: results[index] ↔ variables.files[index] — failed
    // indexes derive from the results array in order.
    expect(intake).toContain("results.flatMap((result, index) => (result.ok ? [] : [index]))");
    // Prefer the live client batch when it still matches the submission
    // (rich file objects preserved); otherwise the retained rows are rebuilt
    // from the submitted request with every retry field.
    expect(intake).toContain("current.length === variables.files.length ? current : variables.files.map((file) => ({");
    expect(intake).toContain("name: file.fileName,");
    expect(intake).toContain("paragraphs: [...file.paragraphs],");
    expect(intake).toContain("episodeTitle: file.episodeTitle ?? \"\",");
    // All success clears the batch exactly as before; the filter path only
    // runs when failed.length > 0.
    expect(intake).toContain("if (!failed.length) {");
    // The Google Docs bulk behavior is unchanged (rowIndex-based retention).
    expect(intake).toContain("const failedIndexes = new Set(failed.map((result) => result.rowIndex));");
  });

  it("keeps the board event-driven and the evidence projection scoped (IPE-065)", () => {
    // D: the heavy board query no longer force-refetches on every mount and
    // focus and has NO unconditional 30s interval — a staleTime window makes
    // remounts/focus reuse recent data, and mutations refetch via onSuccess.
    expect(page).not.toContain('refetchOnMount: "always"');
    expect(page).not.toContain('refetchOnWindowFocus: "always"');
    expect(page).not.toContain("refetchInterval: 30_000");
    expect(page).toContain("staleTime: 30_000,");
    expect(page).toContain("refetchOnMount: true,");
    expect(page).toContain("refetchOnWindowFocus: true,");

    // C: the evidence projection query is scoped to the ACTIVE story's pack
    // ids (state-held, stable per story) — not every work item on the board.
    expect(page).toContain("const [activeEvidenceScopeIds, setActiveEvidenceScopeIds] = useState<number[]>([]);");
    expect(page).toContain("workItemIds: activeEvidenceScopeIds },");
    expect(page).toContain("activeEvidenceScopeIds.length > 0");
    // Rows accumulate per workspace so loaded stories keep their badges;
    // IPE-065R5: the rows live in the LIFECYCLE-tagged container, rotated
    // synchronously with the workspace identity (old rows are
    // non-authoritative from the first new-lifecycle render).
    expect(page).toContain("const evidenceLifecycleRef = useRef<EvidenceLifecycleState>({");
    expect(page).toContain("const evidenceRowsForRender = evidenceLifecycleRef.current.rows;");
    // B: a card without a loaded row is neutral — loading only while its
    // scoped projection is in flight, otherwise unavailable.
    expect(page).toContain('const evidenceState: "loaded" | "loading" | "unavailable" = row');
    expect(page).toContain('activeEvidenceScopeSet.has(card.workItemId) && editorialEvidenceStatuses.isFetching');
  });

  it("removes a workspace story instantly via cache pruning (IPE-065)", () => {
    // E: the unlink success path prunes the detail/bindings/board caches
    // FIRST, toasts without waiting, and only then reconciles in the
    // background — never `await refreshIntake()` before the UI settles.
    expect(intake).toContain("const utils = trpc.useUtils();");
    expect(intake).toContain("onSuccess: async (_result, variables) => {");
    expect(intake).toContain("utils.workspace.detail.setData(scope,");
    expect(intake).toContain("utils.workspace.bindings.list.setData(scope,");
    expect(intake).toContain("utils.workspace.editorial.board.setData(scope,");
    expect(intake).toContain('toast.success("นำเรื่องออกจาก Workspace แล้ว — ตัวนิยายต้นฉบับยังอยู่");');
    expect(intake).toContain("void refreshIntake();");
    // The unlink message keeps remove-from-workspace distinct from deleting
    // the source novel.
    expect(intake).toContain("ตัวนิยายต้นฉบับยังอยู่");
  });

  it("invalidates stale evidence rows on every evidence-changing mutation (IPE-065R1 P1)", () => {
    // ONE centralized invalidation authority: drops the affected rows from
    // the accumulated map immediately (fail closed to loading/unknown), then
    // refetches the SCOPED projection only when an affected id is in the
    // active scope — with cancelRefetch so a pre-mutation in-flight response
    // can never reinsert stale positive rows.
    expect(page).toContain("const invalidateEvidenceRows = (");
    // R5: the affected ids are tombstoned + pruned against the CONTAINER and
    // the revision bumps (fail closed to loading/unknown immediately).
    expect(page).toContain("lifecycle.invalidatedIds.add(id);");
    expect(page).toContain("lifecycle.rows.delete(id);");
    expect(page).toContain("bumpEvidenceRevision();");
    expect(page).toContain("ids.some((id) => activeEvidenceScopeSet.has(id))");
    expect(page).toContain('editorialEvidenceStatuses.refetch({ cancelRefetch: true })');
    // Single-pack evidence-changing paths wired to the helper.
    for (const mutation of [
      "runEditorialForeignChecker = trpc.workspace.editorial.foreignCheckerRun.useMutation",
      "editEditorialDraft = trpc.workspace.editorial.editorEdit.useMutation",
      "approveEditorialDraft = trpc.workspace.editorial.approveDraft.useMutation",
      "stageEditorialEpisode = trpc.workspace.editorial.stageEpisodeDraft.useMutation",
      "resolveEditorialFinding = trpc.workspace.editorial.foreignCheckerResolve.useMutation",
      "allowEditorialFinding = trpc.workspace.editorial.foreignCheckerAllow.useMutation",
      "setStructuralConfirmation = trpc.workspace.editorial.structuralConfirmation.useMutation",
      "updateEditorialEpisode = trpc.workspace.editorial.updateEpisode.useMutation",
      "updateEditorialEpisodeSale = trpc.workspace.editorial.updateEpisodeSale.useMutation",
    ]) {
      const at = page.indexOf(mutation);
      expect(at).toBeGreaterThan(-1);
      // Each mutation's onSuccess body calls the invalidation helper WITH the
      // mutation's workspaceId (R5 §12: cross-workspace completion fences the
      // stale identity there instead of touching the current lifecycle).
      const body = page.slice(at, at + 1700);
      expect(body).toContain(
        "invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId })"
      );
    }
    // exclude/restore/undo route through the same helper.
    expect(page).toContain(
      "invalidateEvidenceRows([variables.workItemId], { workspaceId: variables.workspaceId });\n      await refreshAfterTabRevision();"
    );
    expect(page).toContain("// IPE-065R1 (P1): undo creates a new draft revision — same stale rule.");
    // Bulk paths prune the affected ids, then refreshBulkEditorial refetches
    // board/approval only (no page-wide evidence reintroduction).
    const bulkPrunes = page.match(/invalidateEvidenceRows\(\s*results\.map\(\(result: any\) => result\.workItemId\),\s*\{ refetch: false, workspaceId: variables\.workspaceId \}\s*\)/g) ?? [];
    expect(bulkPrunes.length).toBe(4);
    // remove pack prunes its evidence row (refetch suppressed — board refetch
    // already runs and the work item is gone).
    const removeAt = page.indexOf("removeEditorialEpisode = trpc.workspace.editorial.removeEpisode.useMutation");
    expect(page.slice(removeAt, removeAt + 750)).toContain(
      "invalidateEvidenceRows([variables.workItemId], { refetch: false, workspaceId: variables.workspaceId })"
    );
    // unallow has no workItemId in its input — the selected pack's row is
    // invalidated instead, tagged with the closure's workspace.
    const unallowAt = page.indexOf("unallowEditorialWord = trpc.workspace.editorial.foreignCheckerUnallow.useMutation");
    expect(page.slice(unallowAt, unallowAt + 700)).toContain(
      "invalidateEvidenceRows([selectedSourceWorkItemId], { workspaceId: selectedWorkspaceId })"
    );
    // Evidence-neutral mutations stay untouched (no helper wiring).
    const assignAt = page.indexOf("assignEditorialWorkItem = trpc.workspace.editorial.assignWorkItem.useMutation");
    expect(page.slice(assignAt, assignAt + 320)).not.toContain("invalidateEvidenceRows");
    // The performance contract survives: scoped query input, no polling.
    expect(page).toContain("workItemIds: activeEvidenceScopeIds },");
    expect(page).not.toContain("refetchInterval: 30_000");
    expect(page).not.toContain('refetchOnMount: "always"');
  });

  it("renders the story footer through the pure fail-closed helper (IPE-065R1 P2)", () => {
    const overview = source("client/src/pages/WorkspaceStoryOverview.tsx");
    // The footer comes from storyOverviewFooterLine — no inline fallthrough
    // that could print ผ่าน for an unknown/loading story.
    expect(overview).toContain("storyOverviewFooterLine(story)");
    expect(overview).not.toContain(": STORY_PACK_STATUS_LABEL.passed}");
  });

  it("binds evidence refresh to the invalidation generation fence (IPE-065R2/R3) inside a lifecycle-tagged container (R5)", () => {
    // R5: ALL mutable evidence authority lives in ONE lifecycle-tagged
    // container (epoch + rows + tombstones + generations) — no standalone
    // tombstone/generation states that a delayed workspace-reset effect
    // could wipe after new-lifecycle mutation work.
    expect(page).toContain("const evidenceLifecycleRef = useRef<EvidenceLifecycleState>({");
    expect(page).toContain("const [evidenceRevision, setEvidenceRevision] = useState(0);");
    expect(page).toContain("const bumpEvidenceRevision = () => setEvidenceRevision((revision) => revision + 1);");
    // R3: monotonic per-workItem generation bump on every invalidation —
    // applied to the CONTAINER (the old unconditional passive reset is gone:
    // no setInvalidatedEvidenceIds(new Set()) / blind registry .clear()).
    expect(page).toContain("lifecycle.generations = bumpEvidenceGenerations(lifecycle.generations, ids);");
    expect(page).not.toContain("evidenceInvalidatedAtRef");
    expect(page).not.toContain("dataUpdatedAt >");
    expect(page).not.toContain("setInvalidatedEvidenceIds(new Set())");
    expect(page).not.toContain("evidenceGenerationRef.current = new Map();");
    expect(page).not.toContain("evidenceReconciliationInFlightRef.current.clear();");
    // R5 (§4/§8): the container rotates SYNCHRONOUSLY with the workspace
    // identity — old rows are non-authoritative from the first
    // new-lifecycle render, and stale identities from away-mutations are
    // re-seeded as tombstones.
    expect(page).toContain(
      "evidenceLifecycleRef.current = rotateEvidenceLifecycleState(\n    evidenceLifecycleRef.current,\n    evidenceWorkspaceIdentityRef.current.epoch\n  );"
    );
    expect(page).toContain("invalidatedIdsForWorkspace(\n      invalidEvidenceByWorkspaceRef.current,\n      selectedWorkspaceId\n    )");
    expect(page).toContain("recordInvalidEvidenceForWorkspace(\n        invalidEvidenceByWorkspaceRef.current,\n        targetWorkspaceId,\n        ids\n      );");
    // R5 (§10/§11): lifecycle-selective registry prune (never a blind .clear()).
    expect(page).toContain("pruneEvidenceRegistryForLifecycle(\n    evidenceReconciliationInFlightRef.current,\n    selectedWorkspaceId ?? -1,\n    evidenceWorkspaceIdentityRef.current.epoch\n  );");
    // R5 (§8): card rows read the lifecycle container directly.
    expect(page).toContain("const evidenceRowsForRender = evidenceLifecycleRef.current.rows;");
    // Generic merge is ALWAYS fenced against the container's tombstones and
    // never clears them.
    expect(page).toContain(
      "mergeEvidenceRowsSkippingInvalidated(\n      lifecycle.rows,\n      data,\n      lifecycle.invalidatedIds\n    );"
    );
    // Explicit reconciliation consumes the refetch RESULT directly (never
    // `.data` observation / dataUpdatedAt / structural references) and only
    // accepts rows whose captured generation still matches.
    expect(page).toContain("const result = await editorialEvidenceStatuses.refetch({ cancelRefetch: true });");
    expect(page).toContain("const freshRows = result.data;");
    expect(page).toContain("acceptedReconciliationIds(\n          captured,\n          lifecycle.generations,\n          lifecycle.invalidatedIds,\n          freshRows\n        );");
    expect(page).toContain("const rows = acceptedReconciliationRows(freshRows, acceptedSet);");
    // IPE-065R4: workspace LIFECYCLE fence — the response is authoritative
    // only while the page lives in the captured id AND epoch.
    expect(page).toContain("evidenceWorkspaceIdentityRef.current = nextEvidenceWorkspaceIdentity(");
    expect(page).toContain(
      "sameEvidenceWorkspaceLifecycle(\n            evidenceWorkspaceIdentityRef.current,\n            capturedWorkspaceId,\n            capturedIdentity.epoch\n          )"
    );
    // The epoch rotates synchronously during render — no effect-lag gap.
    expect(page).not.toContain("capturedWorkspaceId !== selectedWorkspaceIdRef.current");
    // Coalescing registry — one in-flight reconciliation per
    // workspace lifecycle+scope+generation key, with OWNERSHIP-SAFE cleanup.
    expect(page).toContain("buildEvidenceReconciliationKey(\n      capturedWorkspaceId,\n      capturedIdentity.epoch,\n      targets,\n      captured\n    )");
    expect(page).toContain("evidenceReconciliationInFlightRef.current.get(key)");
    expect(page).toContain("evidenceReconciliationInFlightRef.current.set(key, promise);");
    expect(page).toContain(
      "releaseOwnedReconciliationEntry(\n          evidenceReconciliationInFlightRef.current,\n          key,\n          promise\n        )"
    );
    expect(page).not.toContain("evidenceReconciliationInFlightRef.current.delete(key);");
    // Scope activation routes through the centralized generation-bound
    // reconciliation — never an unbound refetch — and re-runs on revision
    // bumps so fresh tombstones reconcile without polling.
    expect(page).toContain("scopeNeedsReconciliation(activeEvidenceScopeIds, evidenceLifecycleRef.current.invalidatedIds)");
    expect(page).toContain("void reconcileInvalidatedEvidence(activeEvidenceScopeIds);");
    // Bulk flow: refreshBulkEditorial no longer touches the evidence query;
    // affected active-scope ids reconcile explicitly.
    expect(page).not.toContain("editorialEvidenceStatuses.refetch(), editorialApproval");
    expect(page).toContain("await Promise.all([editorialBoard.refetch(), editorialApproval.refetch()]);");
    // Performance contract intact: scoped input, no polling.
    expect(page).toContain("workItemIds: activeEvidenceScopeIds },");
    expect(page).not.toContain("refetchInterval: 30_000");
    expect(page).not.toContain('refetchOnMount: "always"');
  });

  it("hydrates inactive story statuses progressively in the background (IPE-065R8A/R8B)", () => {
    // Separate mechanism: the ACTIVE story keeps its scoped query; inactive
    // stories hydrate through utils fetch with their OWN story-scoped ids —
    // never multiplexed through activeEvidenceScopeIds, never one
    // all-workspace workItemIds query.
    // IPE-065R8B: the single-flight marker is a LIFECYCLE-OWNED request
    // identity (workspaceId + epoch + storyKey + monotonic requestId) — an
    // old lifecycle's in-flight request never blocks a new lifecycle's queue.
    expect(page).toContain("const [backgroundHydrationOwner, setBackgroundHydrationOwner] = useState<BackgroundHydrationOwner | null>(");
    expect(page).toContain("buildBackgroundHydrationQueue({");
    expect(page).toContain("activeStoryKey,");
    expect(page).toContain("statuses: storyHydrationRef.current.statuses,");
    expect(page).toContain("utils.workspace.editorial.evidenceStatuses.fetch(");
    expect(page).toContain("workItemIds: next.workItemIds },");
    // Bounded concurrency PER CURRENT LIFECYCLE: only a same-lifecycle owner
    // blocks the runner.
    expect(page).toContain(
      "backgroundHydrationOwnerBlocksCurrentLifecycle(\n        backgroundHydrationOwnerRef.current,\n        selectedWorkspaceId,\n        evidenceWorkspaceIdentityRef.current.epoch\n      )"
    );
    expect(page).toContain("const capturedRequestId = ++backgroundHydrationRequestIdRef.current;");
    // Lifecycle fence: workspace id AND epoch captured; a result from an old
    // lifecycle (switch or ABA return) is rejected before any merge.
    expect(page).toContain(
      "sameEvidenceWorkspaceLifecycle(\n            evidenceWorkspaceIdentityRef.current,\n            capturedWorkspaceId,\n            capturedEpoch\n          )"
    );
    expect(page).toContain("evidenceLifecycleRef.current.epoch !== capturedLifecycleEpoch");
    // Board-removal guard runs BEFORE the tombstone-fenced merge — rows for
    // removed workItems/stories are discarded first.
    expect(page).toContain("const boardRows = filterEvidenceRowsToCurrentBoard(");
    expect(page).toContain("new Set(editorialEvidenceWorkItemIdsRef.current)");
    expect(page).toContain(
      "mergeEvidenceRowsSkippingInvalidated(\n          lifecycle.rows,\n          boardRows,\n          lifecycle.invalidatedIds\n        );"
    );
    // Ownership-safe release: settlement clears the marker only while it is
    // still the current owner.
    expect(page).toContain(
      "releaseOwnedBackgroundHydration(\n          backgroundHydrationOwnerRef.current,\n          capturedOwner\n        );"
    );
    // No navigation side effects from hydration: the block must not call the
    // story/pack navigation setters.
    const hydrationAt = page.indexOf("IPE-065R8A: bounded progressive background hydration");
    const hydrationBlock = page.slice(hydrationAt, hydrationAt + 4600);
    expect(hydrationBlock).not.toContain("setSelectedStoryKey(");
    expect(hydrationBlock).not.toContain("setSelectedSourceWorkItemId(");
    expect(hydrationBlock).not.toContain("setStoryEntered(");
    // Card visibility: a pack whose story is hydrating shows loading.
    expect(page).toContain("cardStoryKey === backgroundHydratingStoryKey");
    // Hydration ledger rotates with the workspace epoch.
    expect(page).toContain("rotateStoryHydrationState(");
    // The active-story scoped query is untouched by the background path.
    expect(page).toContain("workItemIds: activeEvidenceScopeIds },");
  });
});

describe("IPE-064 — story gate", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("shows the story picker first and a back button inside the work area", () => {
    expect(page).toContain("const [storyEntered, setStoryEntered] = useState(false);");
    expect(page).toContain("!storyEntered ? (");
    expect(page).toContain("<WorkspaceStoryOverview");
    expect(page).toContain('data-testid="workspace-back-to-stories"');
    expect(page).toContain("ย้อนกลับ เลือกเรื่อง");
    expect(page).toContain("if (selectStory(storyKey)) setStoryEntered(true);");
  });
});

describe("IPE-064 — the 4-pane work area", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const actionBar = source("client/src/pages/WorkspaceActionBar.tsx");
  const findingActions = source("client/src/pages/WorkspaceFindingActions.tsx");
  const packPanel = source("client/src/pages/WorkspacePackListPanel.tsx");

  it("keeps the three-column master-detail grid", () => {
    expect(page).toContain('data-testid="workspace-master-detail"');
    expect(page).toContain("xl:grid-cols-[minmax(250px,0.65fr)_minmax(0,2.1fr)_minmax(280px,0.85fr)]");
    expect(page).toContain('data-testid="workspace-side-panel"');
  });

  it("pane 1: pack list supports select-all over the active story's packs", () => {
    expect(packPanel).toContain('data-testid="workspace-pack-select-all"');
    expect(packPanel).toContain("เลือกทั้งหมด");
    expect(page).toContain("allSelected={allStoryPacksSelected}");
    expect(page).toContain("onToggleAll={toggleAllStoryPacks}");
    expect(page).toContain("const toggleAllStoryPacks = () =>");
  });

  it("pane 2: the numbered action bar sits above the editor in the center column", () => {
    expect(actionBar).toContain('data-testid="workspace-action-bar"');
    expect(actionBar).toContain("3. ตรวจ");
    expect(actionBar).toContain("4. ยืนยัน");
    expect(actionBar).toContain("5. Stage");
    expect(actionBar).toContain("6. Publish");
    // Scope: selected packs, or the open pack when nothing is selected —
    // intersected with the ACTIVE story (IPE-064R4B P1: no cross-story bulk),
    // with the open-pack fallback applied after the intersection.
    expect(page).toContain("const intersectedBulkSelection = rawBulkSelection.filter((workItemId: number) =>");
    expect(page).toContain("storySelectableWorkItemIds.includes(workItemId)");
    expect(page).toContain("<WorkspaceActionBar");
    // Bar is inside the center column, before the main editor card.
    const center = page.indexOf('className="min-w-0 space-y-3"');
    const bar = page.indexOf("<WorkspaceActionBar");
    const editor = page.indexOf('data-testid="workspace-main-editor"');
    expect(bar).toBeGreaterThan(center);
    expect(editor).toBeGreaterThan(bar);
    // Bulk endpoints are unchanged.
    expect(page).toContain("bulkRunEditorialChecker.mutate");
    expect(page).toContain("bulkApproveEditorialDrafts.mutate");
    expect(page).toContain("bulkStageEditorialDrafts.mutate");
    expect(page).toContain("bulkRequestEditorialPublish.mutate");
  });

  it("pane 3: the center stays the single ChapterEditorCanvas surface", () => {
    expect(page).toContain('data-testid="workspace-main-editor"');
    expect((page.match(/<ChapterEditorCanvas/g) ?? []).length).toBe(1);
    expect(page).toContain('data-testid="workspace-chapter-editor-empty"');
    expect(page).toContain('data-testid="workspace-pack-secondary"');
    // The canvas appears before the collapsed secondary pack metadata.
    expect(page.indexOf('data-testid="workspace-pack-secondary"')).toBeGreaterThan(
      page.indexOf('data-testid="workspace-main-editor"')
    );
  });

  it("pane 4: the finding workflow card owns go-to-issue / skip / allow / note / save", () => {
    expect(findingActions).toContain('data-testid="workspace-finding-actions"');
    expect(findingActions).toContain("ไปจุดต้องแก้ไข");
    expect(findingActions).toContain("ข้าม");
    expect(findingActions).toContain("เพิ่มอนุญาต");
    expect(findingActions).toContain("ยืนยันหมายเหตุจากผู้เขียน");
    expect(findingActions).toContain("บันทึก Draft");
    expect(page).toContain("<WorkspaceFindingActions");
    // Reuses the same guarded mutations as before (no new authority).
    expect(page).toContain('disposition: "ignored"');
    expect(page).toContain("allowEditorialFinding.mutate");
    expect(page).toContain("setStructuralConfirmation.mutate");
    expect(page).toContain("unallowEditorialWord.mutate");
    expect(page).toContain("onSave={submitChapterEditorEdit}");
  });

  it("pane 4 keeps the compact review summary as the counters strip", () => {
    expect(page).toContain("<WorkspaceReviewSummaryPanel");
  });

  it("refreshes the outline read model after every draft revision (IPE-064R4B)", () => {
    expect(page).toContain("editorialSourceDraftOutline.refetch()");
    // The revision-changing flows: save rebind, tab exclude/restore, undo.
    const saveBlock = page.slice(
      page.indexOf("const [sourceDraftResult] = await Promise.all(["),
      page.indexOf("]);", page.indexOf("const [sourceDraftResult] = await Promise.all(["))
    );
    expect(saveBlock).toContain("editorialSourceDraftOutline.refetch()");
    const undoBlock = page.slice(
      page.indexOf("const undoEditorialEdit = trpc.workspace.editorial.editorUndo.useMutation({"),
      page.indexOf("const approveEditorialDraft = trpc.workspace.editorial.approveDraft.useMutation({")
    );
    expect(undoBlock).toContain("editorialSourceDraftOutline.refetch()");
    expect(page).toContain("editorialSourceDraftOutline.refetch(),\n    ]);");
  });
});

describe("IPE-064R3 — workspace context & navigation", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const packPanel = source("client/src/pages/WorkspacePackListPanel.tsx");

  it("restores story/pack/chapter from the URL and keeps it in sync", () => {
    expect(page).toContain('params.get("story")');
    expect(page).toContain('params.get("chapter")');
    // IPE-064R4B (P2): the context belongs to a workspace — retry restore
    // after switching to the workspace that owns the story.
    expect(page).toContain('params.get("workspace")');
    expect(page).toContain('if (selectedWorkspaceId) params.set("workspace", String(selectedWorkspaceId))');
    expect(page).toContain("updateStoryUiState(states, storyParam");
    expect(page).toContain('params.set("story", activeStoryKey)');
    expect(page).toContain("window.history.replaceState");
    // Restore consumes the params exactly once, before the writer starts.
    expect(page).toContain("const urlRestoreAppliedRef = useRef(false);");
    expect(page).toContain("if (!urlRestoreAppliedRef.current) return;");
  });

  it("consumes the stale story restore only after the workspace data settles (IPE-064R4B R29/R33)", () => {
    // R33 (P2): settled = both workspace-scoped queries have SUCCESSFULLY
    // resolved — !isLoading alone also covers an ERROR state, which would
    // consume the restore and let the URL writer erase the bookmark before
    // any retry could restore it.
    expect(page).toContain("const editorialWorkspaceDataSettled =");
    expect(page).toContain(
      "Boolean(selectedWorkspaceId) && editorialBoard.isSuccess && detail.isSuccess;"
    );
    expect(page).not.toContain("!editorialBoard.isLoading && !detail.isLoading");
    // A SETTLED empty workspace consumes the stale restore exactly like the
    // !group branch below it — the URL writer then canonicalizes from live
    // state and the stale ?workspace can never yank the operator back into
    // the empty workspace (R29 behavior preserved).
    expect(page).toContain("if (!editorialWorkspaceDataSettled) return;");
    // The settled flag participates in the effect deps so a zero-length group
    // list that merely settles (length 0 → 0) still re-runs the restore
    // decision.
    expect(page).toContain(
      "[editorialNovelGroups.length, editorialWorkspaceDataSettled, selectedWorkspaceId, editorialBoard.data, workspaces.data]"
    );
    // The restore ref is never reset — resetting it would revive the stale
    // params and reintroduce the empty-workspace trap.
    expect(page).not.toContain("urlRestoreAppliedRef.current = false");
    // The URL writer stays guarded by the one-time restore flag.
    expect(page).toContain("if (!urlRestoreAppliedRef.current) return;");
  });

  it("requires SUCCESSFUL workspace queries before consuming the URL restore (IPE-064R4B R33)", () => {
    // A/B/C: loading OR error on either query must never classify as a
    // settled empty workspace — only isSuccess (retry-resolved success)
    // counts; the restore keeps waiting so the bookmark survives a failed
    // first board request and can restore on a later retry.
    expect(page).toContain(
      "Boolean(selectedWorkspaceId) && editorialBoard.isSuccess && detail.isSuccess;"
    );
    expect(page).not.toContain("!editorialBoard.isLoading");
    expect(page).not.toContain("!detail.isLoading");
    // D: a successfully resolved empty workspace still consumes the stale
    // restore (the R29 dead-end fix preserved).
    expect(page).toContain("if (!editorialWorkspaceDataSettled) return;");
    expect(page).toContain("urlRestoreAppliedRef.current = true;");
    // F: the pre-existing restore branches (no story param, workspace-first
    // switch, stale workspace validation, pack/chapter seeding) untouched.
    expect(page).toContain("if (!workspaces.data?.length) return;");
    expect(page).toContain('const storyParam = params.get("story");');
    expect(page).toContain("if (workspaceParamValid && workspaceParam !== selectedWorkspaceId) {");
    expect(page).toContain("const packValid =");
    expect(page).toContain("const chapterParam = params.get(\"chapter\");");
  });

  it("routes both intake links through the canonical dirty-editor boundary (IPE-064R4B R31)", () => {
    // One handler owns the intake navigation: it prompts with the
    // leaving-for-intake message, cancels the in-app Wouter navigation on
    // Cancel (link preventDefault — beforeunload never fires for Wouter),
    // and on Confirm runs the SAME discard authority as story/pack switches
    // before navigating to the unchanged intake URL contract.
    expect(page).toContain('const [, navigateIntake] = useLocation();');
    expect(page).toContain("const navigateToWorkspaceIntake = (event: { preventDefault(): void }) => {");
    expect(page).toContain("event.preventDefault();");
    expect(page).toContain(
      'discardChapterEditorForContextSwitch(\n        "มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วไปหน้าตั้งค่า / นำเข้าหรือไม่?"\n      )'
    );
    expect(page).toContain(
      'navigateIntake(\n      `/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : ""}`\n    );'
    );
    // A. Clean editor: the boundary returns true without prompting — no
    // confirmation stands between a clean editor and the intake navigation.
    expect(page).toContain("if (!chapterEditorTarget) return true;");
    // B. Dirty + Cancel: the shared authority returns false on Cancel and
    // the handler aborts before navigating (navigation blocked, editor kept).
    expect(page).not.toMatch(/navigateToWorkspaceIntake[\s\S]{0,200}navigateIntake\([^)]*\)[\s\S]{0,40}setChapterEditorTarget/);

    // D. BOTH intake entry points are guarded — no unguarded
    // /workspace/intake Link may remain inside WorkspacePage.
    const guardedLinks = page.match(/data-intake-guarded-link="1"/g) ?? [];
    expect(guardedLinks.length).toBe(2);
    const intakeHrefs = page.match(/href=\{`\/workspace\/intake/g) ?? [];
    expect(intakeHrefs.length).toBe(2);
    // Every intake href sits on a guarded link.
    for (const match of page.matchAll(/href=\{`\/workspace\/intake[\s\S]{0,300}?onClick={navigateToWorkspaceIntake}/g)) {
      expect(match[0]).toContain('data-intake-guarded-link="1"');
    }
    // The global dirty click-guard skips only these self-guarded links —
    // every OTHER anchor keeps the capture-phase confirmation (E: the
    // browser/tab-close beforeunload guard is untouched in this effect).
    expect(page).toContain('if (anchor.closest("[data-intake-guarded-link]")) return;');
    expect(page).toContain('window.addEventListener("beforeunload", beforeUnload);');
  });

  it("reopens reversible resolved findings via the existing resolve mutation (IPE-064R4B R32)", () => {
    const card = source("client/src/pages/WorkspaceFindingActions.tsx");
    // The reopen action renders ONLY for a reversible resolved disposition
    // (ignored/fixed) and shares the resolve mutation's pending state, so a
    // repeated click cannot double-submit while pending.
    expect(card).toContain('data-testid="workspace-finding-reopen"');
    expect(card).toContain("canReopen ? (");
    expect(card).toContain("คืนสถานะ");
    expect(card).toContain("reopenPending");
    expect(card).toContain("disabled={reopenPending || ignorePending || allowPending}");

    // The page's open handler targets ONLY ignored/fixed dispositions —
    // allowlist-derived accepted findings must use the existing allow/unallow
    // authority, not this flow.
    expect(page).toContain('if (finding.disposition !== "ignored" && finding.disposition !== "fixed") return;');
    // Same mutation + expectedVersion (current resolutionVersion) + distinct
    // idempotencyKey namespace — no duplicate server endpoint.
    expect(page).toContain('disposition: "open",');
    expect(page).toContain('idempotencyKey: `editorial-reopen:${finding.id}:${finding.resolutionVersion ?? 0}`');
    // canReopen gates on the checker evidence being current (stale →
    // disabled, consistent with the other finding mutations) — pin via the
    // canReopen block's last condition.
    const canReopenIndex = page.indexOf("canReopen={Boolean(");
    expect(canReopenIndex).toBeGreaterThan(-1);
    expect(page.slice(canReopenIndex, canReopenIndex + 420)).toContain("!editorialCheckerRunStale");
  });

  it("offers a quick story switcher in the header (guarded by the dirty check)", () => {
    expect(page).toContain('data-testid="workspace-story-switcher"');
    expect(page).toContain("if (selectStory(event.target.value)) setStoryEntered(true);");
  });

  it("jumps to the next needs-fix pack and auto-expands the selected pack", () => {
    expect(page).toContain('derivePackStatus(card.evidence) === "needs_fix"');
    expect(page).toContain("onJumpToPack={(workItemId) => {");
    expect(packPanel).toContain('data-testid="workspace-next-needs-fix-pack"');
    expect(packPanel).toContain("selectedRowKey");
    expect(packPanel).toContain("setExpandedPackIds((current) =>");
  });
});
