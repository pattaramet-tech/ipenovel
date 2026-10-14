import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** Read-only Author Workspace, no mutation clients. */
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
  const draft = trpc.workspace.authorRead.draft.useQuery(
    { workspaceId: workspaceId ?? 0, workItemId: workItemId ?? 0 },
    { enabled: inScope && workItemId !== null &&
      ownedItems.some(item => item.workItemId === workItemId) },
  );
  if (loading) return <main className="mx-auto max-w-5xl p-6">Loading Workspace…</main>;
  if (!isAuthor) return <main className="mx-auto max-w-5xl p-6">Workspace access requires an Author account.</main>;
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6" data-testid="author-workspace-read-only">
      <h1 className="text-2xl font-semibold">My Workspace</h1>
      <p className="text-sm text-muted-foreground">Read-only access to your own editorial content.</p>
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
                    <Button size="sm" variant="outline" onClick={() => setWorkItemId(item.workItemId)}>
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
              {workItemId !== null && (
                <section aria-label="Read-only draft preview" className="space-y-2">
                  <h3 className="font-semibold">Draft preview</h3>
                  {draft.isLoading && <p role="status">Loading draft…</p>}
                  {draft.isError && <p role="alert">Draft unavailable.</p>}
                  {draft.data === null && <p>No draft exists yet.</p>}
                  {draft.data && (
                    <Card><CardContent className="pt-4">
                      <p className="mb-3 text-xs text-muted-foreground">Version {draft.data.version} · Read-only</p>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
                        {draft.data.presentationJson}
                      </pre>
                    </CardContent></Card>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
