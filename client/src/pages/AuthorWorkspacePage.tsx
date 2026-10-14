import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChapterEditorCanvas } from "./WorkspacePage";
import {
  AuthorStageButton,
  authorCanvasLoadDecision,
  authorMutationNotice,
  confirmDiscardUnsavedEdits,
} from "./authorEditorGuards";
import {
  applyChapterCanvasChange,
  authorCanvasFindings,
  serializeChapterCanvasForSave,
  serializeChapterCanvasText,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";

/** Author Workspace for owned novels. Publish stays on the Admin Workspace. */
export default function AuthorWorkspacePage() {
  const { user, loading } = useAuth();
  const isAuthor = !loading && user?.role === "author";
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [workItemId, setWorkItemId] = useState<number | null>(null);
  const workspaces = trpc.workspace.authorRead.list.useInfiniteQuery(
    { limit: 25 },
    { enabled: isAuthor, getNextPageParam: last => last.nextCursor ?? undefined },
  );
  const workspaceRows = workspaces.data?.pages.flatMap(page => page.items) ?? [];
  const selected = workspaceRows.find(row => row.workspaceId === workspaceId) ?? null;
  const detail = trpc.workspace.authorRead.detail.useQuery(
    { workspaceId: workspaceId ?? 0 }, { enabled: isAuthor && selected !== null },
  );
  const inScope = isAuthor && detail.isSuccess && selected !== null;
  const novels = trpc.workspace.authorRead.novels.useInfiniteQuery(
    { workspaceId: workspaceId ?? 0, limit: 25 },
    { enabled: inScope, getNextPageParam: last => last.nextCursor ?? undefined },
  );
  const workItems = trpc.workspace.authorRead.workItems.useInfiniteQuery(
    { workspaceId: workspaceId ?? 0, limit: 50 },
    { enabled: inScope, getNextPageParam: last => last.nextCursor ?? undefined },
  );
  const ownedNovels = novels.data?.pages.flatMap(page => page.items) ?? [];
  const ownedItems = workItems.data?.pages.flatMap(page => page.items) ?? [];
  const editorDirtyRef = useRef(false);
  const onEditorDirty = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
  }, []);
  const discardUnsavedEdits = () => confirmDiscardUnsavedEdits(
    editorDirtyRef.current,
    () => window.confirm("Discard unsaved chapter edits?"),
  );
  const draft = trpc.workspace.authorRead.draft.useQuery(
    { workspaceId: workspaceId ?? 0, workItemId: workItemId ?? 0 },
    { enabled: inScope && workItemId !== null &&
      ownedItems.some(item => item.workItemId === workItemId) },
  );
  if (loading) return <main className="mx-auto max-w-5xl p-6">Loading Workspace…</main>;
  if (!isAuthor) return <main className="mx-auto max-w-5xl p-6">Workspace access requires an Author account.</main>;
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6" data-testid="author-workspace">
      <h1 className="text-2xl font-semibold">My Workspace</h1>
      <p className="text-sm text-muted-foreground">Edit, check, approve, and stage your own novels.</p>
      <Link href="/admin/novels" className="text-sm underline">Manage my novels</Link>
      {workspaces.isLoading && <p role="status">Loading owned workspaces…</p>}
      {workspaces.isError && <p role="alert">Could not load your workspaces.</p>}
      {!workspaces.isLoading && !workspaces.isError && workspaceRows.length === 0 &&
        <p>No active Workspace membership with owned novels was found.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {workspaceRows.map(workspace => (
          <Card key={workspace.workspaceId}>
            <CardHeader><CardTitle className="text-base">{workspace.name}</CardTitle></CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => {
                if (workspace.workspaceId === workspaceId) return;
                if (!discardUnsavedEdits()) return;
                setWorkspaceId(workspace.workspaceId);
                setWorkItemId(null);
              }}>View owned content</Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {workspaces.hasNextPage && (
        <Button variant="outline" disabled={workspaces.isFetchingNextPage}
          onClick={() => void workspaces.fetchNextPage()}>
          {workspaces.isFetchingNextPage ? "Loading…" : "Load more workspaces"}
        </Button>
      )}
      {selected && (
        <section aria-label="My workspace novels" className="space-y-4">
          {detail.isError && <p role="alert">Owned Workspace details are unavailable.</p>}
          {detail.isLoading && <p role="status">Loading selected Workspace…</p>}
          {detail.data && <h2 className="text-lg font-semibold">{detail.data.name}</h2>}
          {inScope && (
            <>
              <h3 className="font-semibold">My novels</h3>
              {novels.isError && <p role="alert">Could not load owned novels.</p>}
              {novels.isLoading && <p role="status">Loading owned novels…</p>}
              <div className="grid gap-3 md:grid-cols-2">
                {ownedNovels.map(novel => (
                  <Card key={novel.workspaceNovelId}>
                    <CardHeader><CardTitle className="text-base">{novel.title}</CardTitle></CardHeader>
                    <CardContent className="text-sm">Publication: {novel.publicationStatus}</CardContent>
                  </Card>
                ))}
              </div>
              {novels.hasNextPage && (
                <Button variant="outline" disabled={novels.isFetchingNextPage}
                  onClick={() => void novels.fetchNextPage()}>
                  {novels.isFetchingNextPage ? "Loading…" : "Load more novels"}
                </Button>
              )}
              <h3 className="font-semibold">Editorial work items</h3>
              {workItems.isError && <p role="alert">Could not load editorial work items.</p>}
              {workItems.isLoading && <p role="status">Loading owned work items…</p>}
              {!workItems.isLoading && ownedItems.length === 0 &&
                <p>No editorial work items in your owned novels.</p>}
              <div className="space-y-2">
                {ownedItems.map(item => (
                  <div key={item.workItemId} className="flex items-center justify-between rounded-md border p-3">
                    <span className="text-sm">{item.episodeNumber ?? item.workItemType} — {item.episodeTitle ?? "Untitled"}</span>
                    <Button size="sm" variant="outline" onClick={() => {
                      if (item.workItemId === workItemId) return;
                      if (!discardUnsavedEdits()) return;
                      setWorkItemId(item.workItemId);
                    }}>
                      Read draft
                    </Button>
                  </div>
                ))}
              </div>
              {workItems.hasNextPage && (
                <Button variant="outline" disabled={workItems.isFetchingNextPage}
                  onClick={() => void workItems.fetchNextPage()}>
                  {workItems.isFetchingNextPage ? "Loading…" : "Load more work items"}
                </Button>
              )}
              {workItemId !== null && selected && (
                <>
                  <section aria-label="Read-only draft preview" className="space-y-2">
                    <h3 className="font-semibold">Draft preview</h3>
                    {draft.isLoading && <p role="status">Loading draft…</p>}
                    {draft.isError && <p role="alert">Draft unavailable.</p>}
                    {draft.data === null && <p>No draft exists yet.</p>}
                    {draft.data && (
                      <Card><CardContent className="pt-4">
                        <p className="mb-3 text-xs text-muted-foreground">Version {draft.data.version}</p>
                        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
                          {draft.data.presentationJson}
                        </pre>
                      </CardContent></Card>
                    )}
                  </section>
                  <AuthorDraftEditor
                    workspaceId={selected.workspaceId}
                    workItemId={workItemId}
                    onDirtyChange={onEditorDirty}
                  />
                </>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}

function AuthorDraftEditor({
  workspaceId,
  workItemId,
  onDirtyChange,
}: {
  workspaceId: number;
  workItemId: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const scopeKey = `${workspaceId}:${workItemId}`;
  const scopeRef = useRef(scopeKey);
  const forceLoad = useRef(false);
  const pendingSaveText = useRef<string | null>(null);
  const acceptedSaveText = useRef<string | null>(null);
  const [notice, setNotice] = useState<{ role: "status" | "alert"; text: string } | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [paragraphs, setParagraphs] = useState<ChapterCanvasParagraph[]>([]);
  const [baselineText, setBaselineText] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    forceLoad.current = true;
    pendingSaveText.current = null;
    acceptedSaveText.current = null;
    setNotice(null);
    setTabId(null);
    setParagraphs([]);
    setBaselineText("");
    setLoadedKey("");
  }
  const surface = trpc.workspace.authorEditorial.surface.useQuery({ workspaceId, workItemId });
  const report = (action: string, reloadOnSuccess: boolean) => ({
    onSuccess: () => {
      if (reloadOnSuccess) forceLoad.current = true;
      setNotice(authorMutationNotice("success", action));
      void surface.refetch();
    },
    onError: (error: { message?: string }) => {
      setNotice(authorMutationNotice("error", action, error.message));
    },
  });
  const edit = trpc.workspace.authorEditorial.edit.useMutation({
    onSuccess: () => {
      acceptedSaveText.current = pendingSaveText.current;
      pendingSaveText.current = null;
      setNotice(authorMutationNotice("success", "Save"));
      void surface.refetch();
    },
    onError: (error: { message?: string }) => {
      pendingSaveText.current = null;
      acceptedSaveText.current = null;
      setNotice(authorMutationNotice("error", "Save", error.message));
    },
  });
  const undo = trpc.workspace.authorEditorial.undo.useMutation(report("Undo", true));
  const runChecker = trpc.workspace.authorEditorial.runChecker.useMutation(report("QC", false));
  const resolveFinding = trpc.workspace.authorEditorial.resolveFinding.useMutation(report("Finding resolution", false));
  const confirmAnomaly = trpc.workspace.authorEditorial.confirmAnomaly.useMutation(report("Source note", false));
  const approve = trpc.workspace.authorEditorial.approve.useMutation(report("Approval", false));
  const stage = trpc.workspace.authorEditorial.stage.useMutation(report("Stage", false));
  const data = surface.data;
  const tab = data?.tabs.find(item => item.sourceTabId === tabId) ?? data?.tabs[0] ?? null;
  const loadKey = data && tab ? `${data.draft?.id ?? 0}:${tab.sourceTabId}:${tab.structuralSha256}` : "";
  const text = serializeChapterCanvasText(paragraphs);
  if (data && tab && surface.isSuccess && loadKey !== loadedKey) {
    const next = tab.paragraphs.map(paragraph => ({
      id: paragraph.paragraphKey,
      paragraphKey: paragraph.paragraphKey,
      text: paragraph.text,
    }));
    const serverText = serializeChapterCanvasText(next);
    const decision = authorCanvasLoadDecision({
      forceLoad: forceLoad.current,
      localDirty: loadedKey !== "" && text !== baselineText,
      acceptedSaveText: acceptedSaveText.current,
      currentText: text,
    });
    if (decision === "replace") {
      forceLoad.current = false;
      pendingSaveText.current = null;
      acceptedSaveText.current = null;
      setParagraphs(next.length ? next : [{ id: "empty", text: "" }]);
      setBaselineText(serverText);
      setTabId(tab.sourceTabId);
      setLoadedKey(loadKey);
    } else if (decision === "keep-edits") {
      pendingSaveText.current = null;
      acceptedSaveText.current = null;
      setBaselineText(serverText);
      setTabId(tab.sourceTabId);
      setLoadedKey(loadKey);
    }
  }
  const dirty = serializeChapterCanvasText(paragraphs) !== baselineText;
  onDirtyChange(dirty);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const busy = edit.isPending || undo.isPending || runChecker.isPending || resolveFinding.isPending || confirmAnomaly.isPending || approve.isPending || stage.isPending;
  const begin = () => setNotice(null);
  const save = () => {
    if (!data?.draft || !tab || busy) return;
    const projected = serializeChapterCanvasForSave(paragraphs);
    pendingSaveText.current = text;
    begin();
    edit.mutate({
      workspaceId,
      workItemId,
      expectedDraftId: data.draft.id,
      expectedDraftVersion: data.draft.version,
      expectedDraftSha256: data.draft.draftSha256,
      command: {
        kind: "replace_tab",
        sourceTabId: tab.sourceTabId,
        expectedTabStructuralSha256: tab.structuralSha256,
        expectedText: baselineText,
        replacementText: projected.text,
        replacementParagraphKeys: projected.replacementParagraphKeys,
      },
      idempotencyKey: `author-edit:${data.draft.id}:${tab.sourceTabId}:${crypto.randomUUID()}`,
    });
  };
  return (
    <section aria-label="Author editor" className="space-y-3">
      <h3 className="font-semibold">Editor</h3>
      {surface.isLoading && <p role="status">Loading editor…</p>}
      {surface.isError && <p role="alert">This draft cannot be edited with the current Author access.</p>}
      {notice && <p role={notice.role}>{notice.text}</p>}
      {data && !data.draft && <p>No draft exists yet.</p>}
      {data?.draft && tab && (
        <Card><CardContent className="space-y-3 pt-4">
          <p className="text-xs text-muted-foreground">Version {data.draft.version}</p>
          <div className="flex flex-wrap gap-2">
            {data.tabs.map(item => (
              <Button key={item.sourceTabId} size="sm" variant={item.sourceTabId === tab.sourceTabId ? "default" : "outline"}
                onClick={() => {
                  if (item.sourceTabId === tab.sourceTabId) return;
                  if (!confirmDiscardUnsavedEdits(dirty, () => window.confirm("Discard unsaved chapter edits?"))) return;
                  forceLoad.current = true;
                  setTabId(item.sourceTabId);
                }}>
                {item.title || item.sourceTabId}
              </Button>
            ))}
          </div>
          <ChapterEditorCanvas
            value={text}
            flatFindings={authorCanvasFindings(paragraphs, data.checker.findings, tab.sourceTabId)}
            highlight
            disabled={busy}
            textareaRef={textareaRef}
            onChange={value => {
              const next = applyChapterCanvasChange({
                previous: paragraphs,
                oldText: text,
                newText: value,
                nextId: () => crypto.randomUUID(),
              });
              setParagraphs(next.paragraphs);
            }}
            onKeyDown={() => {}}
            onPaste={() => {}}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy || text === baselineText}>Save draft</Button>
            <Button variant="outline" disabled={busy || !data.canUndo} onClick={() => {
              if (!confirmDiscardUnsavedEdits(dirty, () => window.confirm("Discard unsaved chapter edits and undo the last save?"))) return;
              begin();
              undo.mutate({
                workspaceId,
                workItemId,
                expectedDraftId: data.draft!.id,
                expectedDraftVersion: data.draft!.version,
                expectedDraftSha256: data.draft!.draftSha256,
                idempotencyKey: `author-undo:${data.draft!.id}:${crypto.randomUUID()}`,
              });
            }}>Undo</Button>
            <Button variant="outline" disabled={busy || dirty} onClick={() => {
              begin();
              runChecker.mutate({
                workspaceId,
                workItemId,
                expectedDraftId: data.draft!.id,
              });
            }}>Run QC</Button>
            <Button variant="outline" disabled={busy || dirty || !data.approval.qcReady || !data.approval.checkerRunId || !data.approval.qcEvidenceSha256}
              onClick={() => {
                begin();
                approve.mutate({
                  workspaceId,
                  workItemId,
                  expectedDraftId: data.draft!.id,
                  expectedDraftVersion: data.draft!.version,
                  expectedDraftSha256: data.draft!.draftSha256,
                  expectedCheckerRunId: data.approval.checkerRunId!,
                  expectedQcEvidenceSha256: data.approval.qcEvidenceSha256!,
                  idempotencyKey: `author-approve:${data.draft!.id}:${data.approval.checkerRunId}`,
                });
              }}>Approve</Button>
            <AuthorStageButton
              busy={busy}
              dirty={dirty}
              stageActionReady={data.approval.stageActionReady}
              approvalId={data.approval.approvalId}
              onStage={() => {
                if (!data.draft || data.approval.approvalId == null) return;
                begin();
                stage.mutate({
                  workspaceId,
                  workItemId,
                  approvalId: data.approval.approvalId,
                  expectedDraftId: data.draft.id,
                  expectedDraftVersion: data.draft.version,
                  expectedDraftSha256: data.draft.draftSha256,
                  idempotencyKey: `author-stage:${data.approval.approvalId}:${data.draft.id}`,
                });
              }}
            />
          </div>
          {dirty && <p role="status">Save the draft before QC, approval, or stage.</p>}
          {data.approval.qcReason && !data.approval.qcReady && <p role="status">{data.approval.qcReason}</p>}
          {data.approval.stageActionReason && !data.approval.stageActionReady && <p role="status">{data.approval.stageActionReason}</p>}
          <ul className="space-y-2">
            {data.checker.findings.filter(finding => finding.disposition === "open").map(finding => (
              <li key={finding.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{finding.token}</span>
                <Button size="sm" variant="outline" disabled={resolveFinding.isPending} onClick={() => {
                  begin();
                  resolveFinding.mutate({
                    workspaceId,
                    workItemId,
                    findingId: finding.id,
                    disposition: "fixed",
                    expectedVersion: finding.resolutionVersion,
                    idempotencyKey: `author-resolve:${finding.id}:${finding.resolutionVersion}`,
                  });
                }}>Mark fixed</Button>
              </li>
            ))}
            {data.checker.anomalies.filter(anomaly => anomaly.anomalyType === "source_note_only" && anomaly.disposition !== "confirmed_source_note").map(anomaly => (
              <li key={anomaly.id} className="flex items-center justify-between gap-3 text-sm">
                <span>Source note</span>
                <Button size="sm" variant="outline" disabled={confirmAnomaly.isPending} onClick={() => {
                  begin();
                  confirmAnomaly.mutate({
                    workspaceId,
                    workItemId,
                    anomalyId: anomaly.id,
                    confirmed: true,
                    expectedVersion: anomaly.confirmationVersion,
                  });
                }}>Confirm note</Button>
              </li>
            ))}
          </ul>
        </CardContent></Card>
      )}
    </section>
  );
}
