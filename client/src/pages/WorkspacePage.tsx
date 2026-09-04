import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, ShieldCheck } from "lucide-react";

export default function WorkspacePage() {
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number>();
  const [novelId, setNovelId] = useState("");
  const auth = useAuth({ redirectOnUnauthenticated: true });

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: auth.isAuthenticated });
  const detail = trpc.workspace.detail.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: auth.isAuthenticated && Boolean(selectedWorkspaceId) }
  );
  const bindings = trpc.workspace.bindings.list.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: auth.isAuthenticated && Boolean(selectedWorkspaceId) }
  );
  const ownership = trpc.workspace.migrationOwnership.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: auth.isAuthenticated && Boolean(selectedWorkspaceId) }
  );

  const create = trpc.workspace.create.useMutation({
    onSuccess: async ({ workspaceId }) => {
      setName("");
      setSelectedWorkspaceId(workspaceId);
      await workspaces.refetch();
      toast.success("Workspace created");
    },
    onError: (error) => toast.error(error.message),
  });
  const bindNovel = trpc.workspace.bindings.bindPublicationNovel.useMutation({
    onSuccess: async () => {
      setNovelId("");
      await Promise.all([detail.refetch(), bindings.refetch(), ownership.refetch()]);
      toast.success("Read-only novel binding created");
    },
    onError: (error) => toast.error(error.message),
  });

  const selected = detail.data;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="flex flex-col gap-3 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">IpeNovel Workspace · M01</p>
          <h1 className="text-3xl font-bold tracking-tight">Novel Control Center</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Google Docs remains the editor. This first release establishes secure workspace membership
            and read-only publication bindings; Sheets remains the operational owner.
          </p>
        </div>
        <Link href="/novels" className="text-sm text-primary underline">Back to IpeNovel</Link>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-semibold">Your workspaces</h2>
            <p className="text-sm text-muted-foreground">Only active members can open a workspace.</p>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({ name });
            }}
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="Workspace name" />
            <Button type="submit" size="icon" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </form>
          {workspaces.isLoading ? (
            <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          ) : (
            <div className="space-y-2">
              {(workspaces.data as any[] | undefined)?.map(({ workspace, membership }: any) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className="w-full rounded-md border p-3 text-left transition hover:border-primary"
                >
                  <div className="font-medium">{workspace.name}</div>
                  <div className="text-xs text-muted-foreground">{membership.role} · {workspace.status}</div>
                </button>
              ))}
              {!workspaces.data?.length && <p className="text-sm text-muted-foreground">Create your first workspace to begin.</p>}
            </div>
          )}
        </Card>

        <Card className="min-h-96 p-5">
          {!selectedWorkspaceId ? (
            <div className="flex h-full min-h-72 items-center justify-center text-center text-muted-foreground">
              Select a workspace to inspect its protected foundation.
            </div>
          ) : detail.isLoading ? (
            <div className="flex h-full min-h-72 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div>
          ) : selected ? (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">{selected.workspace.name}</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Membership role: <span className="font-medium">{selected.membership.role}</span>. Platform admin rights do not replace this membership.
                </p>
              </div>

              <div className="rounded-md border bg-muted/30 p-4">
                <h3 className="font-medium">Read-only publication binding</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Binding an existing novel creates only a synthetic source contract. It never reads Google Docs, runs Checker/AI, publishes, exports, or changes Sheets.
                </p>
                <form
                  className="mt-3 flex max-w-sm gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const parsed = Number(novelId);
                    if (!Number.isInteger(parsed) || parsed <= 0) {
                      toast.error("Enter an existing numeric novel ID");
                      return;
                    }
                    bindNovel.mutate({ workspaceId: selectedWorkspaceId, novelId: parsed });
                  }}
                >
                  <Input value={novelId} onChange={(event) => setNovelId(event.target.value)} inputMode="numeric" placeholder="Existing novel ID" />
                  <Button type="submit" disabled={bindNovel.isPending}>Bind</Button>
                </form>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <h3 className="font-medium">Members</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {selected.members.map((member: any) => <li key={member.id}>User #{member.userId} · {member.role} · {member.status}</li>)}
                  </ul>
                </div>
                <div>
                  <h3 className="font-medium">Legacy ownership</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {(ownership.data as any[] | undefined)?.map(({ entry, novel }: any) => <li key={entry.id}>{novel.title}: {entry.capability} → {entry.owner}</li>)}
                    {!ownership.data?.length && <li>No novel binding yet; Sheets remains unchanged.</li>}
                  </ul>
                </div>
              </div>

              <div>
                <h3 className="font-medium">Synthetic source bindings</h3>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {(bindings.data as any[] | undefined)?.map(({ binding, novel }: any) => <li key={binding.id}>{novel.title}: {binding.displayName} ({binding.sourceKind})</li>)}
                  {!bindings.data?.length && <li>No source bindings yet.</li>}
                </ul>
              </div>
            </div>
          ) : null}
        </Card>
      </section>
    </main>
  );
}
