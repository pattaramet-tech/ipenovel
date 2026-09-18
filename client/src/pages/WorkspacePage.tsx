import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAdminGuard } from "@/hooks/useAdminGuard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Activity,
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Database,
  FileCheck2,
  GitBranch,
  Loader2,
  Plus,
  ShieldCheck,
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

export default function WorkspacePage() {
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number>();
  const [novelId, setNovelId] = useState("");
  const [newNovelTitle, setNewNovelTitle] = useState("");
  const [episodeWorkspaceNovelId, setEpisodeWorkspaceNovelId] = useState("");
  const [episodeNumber, setEpisodeNumber] = useState("");
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [episodeAssigneeUserId, setEpisodeAssigneeUserId] = useState("");
  const [editorialTypeFilter, setEditorialTypeFilter] = useState("all");
  const [editorialAssigneeFilter, setEditorialAssigneeFilter] = useState("all");
  const [editorialColumnFilter, setEditorialColumnFilter] = useState("all");
  const [selectedSourceWorkItemId, setSelectedSourceWorkItemId] = useState<number>();
  const [googleConnectionId, setGoogleConnectionId] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [uploadedSource, setUploadedSource] = useState<{
    name: string;
    mimeType: string;
    paragraphs: string[];
  }>();
  const [selectedCheckerRunId, setSelectedCheckerRunId] = useState<number>();
  const [selectedAiJobId, setSelectedAiJobId] = useState<number>();
  const [selectedPublishRunId, setSelectedPublishRunId] = useState<number>();
  const [checkerSnapshotId, setCheckerSnapshotId] = useState("");
  const [checkerRuleSetId, setCheckerRuleSetId] = useState("");
  const [aiSnapshotId, setAiSnapshotId] = useState("");
  const ensuredEditorialWorkspaces = useRef(new Set<number>());
  const { isAdmin, loading: adminLoading } = useAdminGuard();

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAdmin });
  const detail = trpc.workspace.detail.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const bindings = trpc.workspace.bindings.list.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const availableNovels = trpc.workspace.bindings.availablePublicationNovels.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const editorialBoard = trpc.workspace.editorial.board.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const editorialGoogleConnections = trpc.workspace.editorial.googleConnections.useQuery(
    undefined,
    { enabled: isAdmin }
  );
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
  const ownership = trpc.workspace.migrationOwnership.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const fingerprints = trpc.workspace.fingerprints.list.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const checkerRuns = trpc.workspace.checker.listRuns.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const operationalState = trpc.workspace.operationalState.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const dualRunState = trpc.workspace.dualRunState.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const aiJobs = trpc.workspace.aiQueue.list.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );
  const publishOverview = trpc.workspace.controlCenter.publishOverview.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) }
  );

  const effectiveCheckerRunId = selectedCheckerRunId ?? (checkerRuns.data as any[] | undefined)?.[0]?.run?.id;
  const effectiveAiJobId = selectedAiJobId ?? (aiJobs.data as any[] | undefined)?.[0]?.id;
  const effectivePublishRunId = selectedPublishRunId ?? (publishOverview.data as any)?.runs?.[0]?.run?.id;

  const checkerDetail = trpc.workspace.checker.runDetail.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, runId: effectiveCheckerRunId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId && effectiveCheckerRunId) }
  );
  const aiOperational = trpc.workspace.aiQueue.operational.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, jobId: effectiveAiJobId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId && effectiveAiJobId) }
  );
  const publishDetail = trpc.workspace.publishDryRun.detail.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, runId: effectivePublishRunId ?? 0 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId && effectivePublishRunId) }
  );

  const selectedPublishSummary = useMemo(
    () => (publishOverview.data as any)?.runs?.find((row: any) => row.run.id === effectivePublishRunId),
    [publishOverview.data, effectivePublishRunId]
  );
  const selected = detail.data;
  const canInspectFinalGate = isAdmin;
  const readinessEligible =
    selectedPublishSummary?.ownership?.owner === "sheets" &&
    selectedPublishSummary?.ownership?.cutoverEpoch === 0;

  const publishReadiness = trpc.workspace.publishCutover.readiness.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, runId: effectivePublishRunId ?? 0 },
    {
      enabled:
        isAdmin &&
        Boolean(selectedWorkspaceId && effectivePublishRunId && readinessEligible),
      retry: false,
    }
  );
  const finalGate = trpc.workspace.publishFinalGate.package.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, runId: effectivePublishRunId ?? 0 },
    {
      enabled:
        isAdmin &&
        Boolean(selectedWorkspaceId && effectivePublishRunId && readinessEligible && canInspectFinalGate),
      retry: false,
    }
  );

  useEffect(() => {
    if (!selectedWorkspaceId && workspaces.data?.length) {
      setSelectedWorkspaceId((workspaces.data as any[])[0].workspace.id);
    }
  }, [selectedWorkspaceId, workspaces.data]);

  useEffect(() => {
    setNovelId("");
    setNewNovelTitle("");
    setEpisodeWorkspaceNovelId("");
    setEpisodeNumber("");
    setEpisodeTitle("");
    setEpisodeAssigneeUserId("");
    setEditorialTypeFilter("all");
    setEditorialAssigneeFilter("all");
    setEditorialColumnFilter("all");
    setSelectedSourceWorkItemId(undefined);
    setGoogleConnectionId("");
    setGoogleDocUrl("");
    setUploadedSource(undefined);
    setSelectedCheckerRunId(undefined);
    setSelectedAiJobId(undefined);
    setSelectedPublishRunId(undefined);
  }, [selectedWorkspaceId]);

  const create = trpc.workspace.create.useMutation({
    onSuccess: async ({ workspaceId }) => {
      setName("");
      setSelectedWorkspaceId(workspaceId);
      await workspaces.refetch();
      toast.success("Workspace created");
    },
    onError: (error) => toast.error(error.message),
  });
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

  const refreshChecker = async (runId?: number) => {
    if (runId) setSelectedCheckerRunId(runId);
    await Promise.all([checkerRuns.refetch(), operationalState.refetch()]);
    if (runId) await checkerDetail.refetch();
  };
  const refreshAi = async (jobId?: number) => {
    if (jobId) setSelectedAiJobId(jobId);
    await aiJobs.refetch();
    if (jobId) await aiOperational.refetch();
  };
  const queueChecker = trpc.workspace.checker.queueRun.useMutation({
    onSuccess: async (run: any) => {
      await refreshChecker(run.id);
      toast.success("Checker run queued");
    },
    onError: (error) => toast.error(error.message),
  });
  const queueAi = trpc.workspace.aiQueue.queue.useMutation({
    onSuccess: async (result: any) => {
      await refreshAi(result.job?.id);
      toast.success(result.created ? "AI QC job queued" : "Existing AI QC job selected");
    },
    onError: (error) => toast.error(error.message),
  });
  const retryAi = trpc.workspace.aiQueue.retry.useMutation({
    onSuccess: async (job: any) => {
      await refreshAi(job?.id);
      toast.success("AI QC job queued for retry");
    },
    onError: (error) => toast.error(error.message),
  });
  const moveEditorialCard = trpc.workspace.kanban.transitionCard.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const createEditorialNovel = trpc.workspace.editorial.createNovel.useMutation({
    onSuccess: async () => {
      setNewNovelTitle("");
      if (selectedWorkspaceId) {
        await ensureEditorialBoard.mutateAsync({ workspaceId: selectedWorkspaceId });
      }
      await Promise.all([
        detail.refetch(),
        bindings.refetch(),
        ownership.refetch(),
        availableNovels.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success("New hidden novel added to Editorial Workspace");
    },
    onError: (error) => toast.error(error.message),
  });
  const createEditorialEpisode = trpc.workspace.editorial.createEpisode.useMutation({
    onSuccess: async () => {
      setEpisodeNumber("");
      setEpisodeTitle("");
      await editorialBoard.refetch();
      toast.success("Episode work item added");
    },
    onError: (error) => toast.error(error.message),
  });
  const assignEditorialWorkItem = trpc.workspace.editorial.assignWorkItem.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const importEditorialSource = trpc.workspace.editorial.importSource.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialForeignChecker.refetch(),
      ]);
      toast.success(
        result.refreshBlocked
          ? "เก็บ snapshot ใหม่แล้ว แต่ Draft เดิมมีการแก้ไข จึงไม่เขียนทับ"
          : result.draftCreated
            ? "นำเข้าต้นฉบับและสร้าง Draft แล้ว"
            : "ต้นฉบับเดิม ไม่มี Draft ใหม่"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const importEditorialGoogleDoc = trpc.workspace.editorial.importGoogleDoc.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialForeignChecker.refetch(),
      ]);
      toast.success(
        result.refreshBlocked
          ? "เก็บ Google Docs snapshot ใหม่แล้ว แต่ Draft เดิมมีการแก้ไข จึงไม่เขียนทับ"
          : result.draftCreated
            ? "นำเข้า Google Docs และสร้าง Draft แล้ว"
            : "Google Docs ไม่มีการเปลี่ยนแปลง"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const runEditorialForeignChecker = trpc.workspace.editorial.foreignCheckerRun.useMutation({
    onSuccess: async (result) => {
      await editorialForeignChecker.refetch();
      toast.success(
        result.unresolvedCount
          ? `พบ ${result.unresolvedCount} จุดที่ต้องตรวจ`
          : "ไม่พบคำต่างประเทศที่ค้างตรวจ"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveEditorialFinding = trpc.workspace.editorial.foreignCheckerResolve.useMutation({
    onSuccess: async () => {
      await editorialForeignChecker.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const allowEditorialFinding = trpc.workspace.editorial.foreignCheckerAllow.useMutation({
    onSuccess: async () => {
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        const latestDraft = (editorialSourceDraft.data as any)?.latestDraft;
        await runEditorialForeignChecker.mutateAsync({
          workspaceId: selectedWorkspaceId,
          workItemId: selectedSourceWorkItemId,
          expectedDraftId: latestDraft?.id,
        });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const unallowEditorialWord = trpc.workspace.editorial.foreignCheckerUnallow.useMutation({
    onSuccess: async () => {
      if (selectedWorkspaceId && selectedSourceWorkItemId) {
        const latestDraft = (editorialSourceDraft.data as any)?.latestDraft;
        await runEditorialForeignChecker.mutateAsync({
          workspaceId: selectedWorkspaceId,
          workItemId: selectedSourceWorkItemId,
          expectedDraftId: latestDraft?.id,
        });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const bindNovel = trpc.workspace.bindings.bindPublicationNovel.useMutation({
    onSuccess: async () => {
      setNovelId("");
      if (selectedWorkspaceId) {
        await ensureEditorialBoard.mutateAsync({ workspaceId: selectedWorkspaceId });
      }
      await Promise.all([
        detail.refetch(),
        bindings.refetch(),
        ownership.refetch(),
        availableNovels.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success("Novel added to Editorial Workspace");
    },
    onError: (error) => toast.error(error.message),
  });

  const operationalRows = (operationalState.data as any[] | undefined) ?? [];
  const checkerRows = (checkerRuns.data as any[] | undefined) ?? [];
  const aiRows = (aiJobs.data as any[] | undefined) ?? [];
  const publishRows = ((publishOverview.data as any)?.runs as any[] | undefined) ?? [];
  const publishTransitions = ((publishOverview.data as any)?.transitions as any[] | undefined) ?? [];
  const editorialColumns = (((editorialBoard.data as any)?.columns as any[] | undefined) ?? []);
  const editorialTransitions = (((editorialBoard.data as any)?.transitions as any[] | undefined) ?? []);
  const editorialAssignees = (((editorialBoard.data as any)?.assignees as any[] | undefined) ?? []);
  const editorialCards = editorialColumns.flatMap((column: any) => column.cards ?? []);
  const selectedSourceCard = editorialCards.find(
    (card: any) => card.workItemId === selectedSourceWorkItemId
  );
  const editorialCheckerData = editorialForeignChecker.data as any;
  const editorialCheckerRunStale = Boolean(
    editorialCheckerData?.run &&
      editorialCheckerData?.latestDraft &&
      editorialCheckerData.run.draftId !== editorialCheckerData.latestDraft.id
  );
  const googleConnections = (
    (editorialGoogleConnections.data as any[] | undefined) ?? []
  ).filter((connection: any) => connection.status === "active" && connection.scopeReady);
  const novelOptions = ((availableNovels.data as any[] | undefined) ?? []);
  const unboundNovelOptions = novelOptions.filter((novel: any) => !novel.bound);
  const workspaceNovelOptions = (((selected as any)?.novels as any[] | undefined) ?? []);
  const editorialColumnNameById = new Map(editorialColumns.map((column: any) => [column.id, column.name]));
  const filteredEditorialColumns = editorialColumns
    .filter((column: any) => editorialColumnFilter === "all" || column.key === editorialColumnFilter)
    .map((column: any) => ({
      ...column,
      cards: column.cards.filter((card: any) => {
        const typeMatch = editorialTypeFilter === "all" || card.workItemType === editorialTypeFilter;
        const assigneeMatch =
          editorialAssigneeFilter === "all" ||
          (editorialAssigneeFilter === "unassigned"
            ? !card.assigneeUserId
            : String(card.assigneeUserId ?? "") === editorialAssigneeFilter);
        return typeMatch && assigneeMatch;
      }),
    }));
  const checkerRuleSets = (((dualRunState.data as any)?.ruleSets as any[] | undefined) ?? []).filter((ruleSet: any) => ruleSet.status === "published");
  const snapshotOptions = Array.from(new Map(operationalRows.map((row: any) => [row.fingerprint.snapshotId, row.fingerprint])).values()) as any[];
  const effectiveCheckerSnapshotId = Number(checkerSnapshotId) || snapshotOptions[0]?.snapshotId;
  const effectiveCheckerRuleSetId = Number(checkerRuleSetId) || checkerRuleSets[0]?.id;
  const effectiveAiSnapshotId = Number(aiSnapshotId) || snapshotOptions[0]?.snapshotId;

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
      <header className="flex flex-col gap-3 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">IpeNovel Workspace - Editorial Workspace · Admin Operational Control Center</p>
          <h1 className="text-3xl font-bold tracking-tight">Editorial Board</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Day-to-day novel intake and workflow are shown first. Existing M03–M06 operational
            evidence remains available below; publish execution and ownership changes stay disabled.
          </p>
        </div>
        <Link href="/novels" className="text-sm text-primary underline">Back to IpeNovel</Link>
      </header>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>Editorial MVP.</strong> Story and episode work items move through the transition-backed
        Editorial Kanban with admin assignment/history. Publish execution and ownership changes remain unavailable;
        Checker/AI operational controls below are unchanged and are not required for this board.
      </div>

      <section className="grid gap-6 lg:grid-cols-[minmax(260px,0.75fr)_minmax(0,2.25fr)]">
        <Card className="h-fit space-y-4 p-5">
          <div>
            <h2 className="font-semibold">Workspaces</h2>
            <p className="text-sm text-muted-foreground">All platform admins can open every active workspace.</p>
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
            <Card className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Columns3 className="h-5 w-5 text-primary" />
                    <h2 className="text-xl font-semibold">Editorial Kanban</h2>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    One board per Workspace. Bound novels appear once as NEW STORY cards; movement is backed by immutable Kanban transitions.
                  </p>
                </div>
                <StatusPill value={(editorialBoard.data as any)?.board?.status ?? "initializing"} />
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <form
                  className="space-y-2 rounded-md border bg-muted/20 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const parsed = Number(novelId);
                    if (!Number.isInteger(parsed) || parsed <= 0) {
                      toast.error("Select an existing novel");
                      return;
                    }
                    bindNovel.mutate({ workspaceId: selectedWorkspaceId, novelId: parsed });
                  }}
                >
                  <div className="text-sm font-medium">เพิ่มเรื่องเดิม</div>
                  <select
                    aria-label="Existing publication novel"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={novelId}
                    onChange={(event) => setNovelId(event.target.value)}
                    disabled={bindNovel.isPending || availableNovels.isLoading}
                  >
                    <option value="">เลือกนิยาย</option>
                    {unboundNovelOptions.map((novel: any) => (
                      <option key={novel.id} value={novel.id}>
                        {novel.title} · #{novel.id}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" className="w-full" disabled={!novelId || bindNovel.isPending}>
                    {bindNovel.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BookOpen className="mr-2 h-4 w-4" />}
                    เพิ่มเข้า Workspace
                  </Button>
                </form>

                <form
                  className="space-y-2 rounded-md border bg-muted/20 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newNovelTitle.trim()) return;
                    createEditorialNovel.mutate({
                      workspaceId: selectedWorkspaceId,
                      title: newNovelTitle.trim(),
                    });
                  }}
                >
                  <div className="text-sm font-medium">สร้างเรื่องใหม่</div>
                  <Input
                    value={newNovelTitle}
                    onChange={(event) => setNewNovelTitle(event.target.value)}
                    maxLength={500}
                    placeholder="ชื่อเรื่อง"
                  />
                  <Button type="submit" className="w-full" disabled={!newNovelTitle.trim() || createEditorialNovel.isPending}>
                    {createEditorialNovel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    สร้างเป็นฉบับซ่อน
                  </Button>
                </form>

                <form
                  className="space-y-2 rounded-md border bg-muted/20 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const workspaceNovelId = Number(episodeWorkspaceNovelId);
                    if (!Number.isInteger(workspaceNovelId) || workspaceNovelId <= 0 || !episodeNumber.trim()) {
                      toast.error("Select a novel and enter an episode number");
                      return;
                    }
                    createEditorialEpisode.mutate({
                      workspaceId: selectedWorkspaceId,
                      workspaceNovelId,
                      episodeNumber: episodeNumber.trim(),
                      episodeTitle: episodeTitle.trim() || undefined,
                      assigneeUserId: episodeAssigneeUserId ? Number(episodeAssigneeUserId) : null,
                    });
                  }}
                >
                  <div className="text-sm font-medium">เพิ่มตอนใหม่</div>
                  <select
                    aria-label="Episode novel"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={episodeWorkspaceNovelId}
                    onChange={(event) => setEpisodeWorkspaceNovelId(event.target.value)}
                  >
                    <option value="">เลือกเรื่อง</option>
                    {workspaceNovelOptions.map(({ workspaceNovel, novel }: any) => (
                      <option key={workspaceNovel.id} value={workspaceNovel.id}>
                        {novel.title}
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={episodeNumber} onChange={(event) => setEpisodeNumber(event.target.value)} maxLength={100} placeholder="ตอน / ช่วงตอน" />
                    <Input value={episodeTitle} onChange={(event) => setEpisodeTitle(event.target.value)} maxLength={500} placeholder="ชื่อตอน (ถ้ามี)" />
                  </div>
                  <select
                    aria-label="Initial episode assignee"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={episodeAssigneeUserId}
                    onChange={(event) => setEpisodeAssigneeUserId(event.target.value)}
                  >
                    <option value="">ยังไม่มอบหมาย</option>
                    {editorialAssignees.map((admin: any) => (
                      <option key={admin.id} value={admin.id}>{admin.name || admin.email || `Admin #${admin.id}`}</option>
                    ))}
                  </select>
                  <Button type="submit" className="w-full" disabled={!episodeWorkspaceNovelId || !episodeNumber.trim() || createEditorialEpisode.isPending}>
                    {createEditorialEpisode.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    เพิ่มงานตอน
                  </Button>
                </form>
              </div>

              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-3">
                <select
                  aria-label="Editorial column filter"
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={editorialColumnFilter}
                  onChange={(event) => setEditorialColumnFilter(event.target.value)}
                >
                  <option value="all">ทุกสถานะ</option>
                  {editorialColumns.map((column: any) => <option key={column.id} value={column.key}>{column.name}</option>)}
                </select>
                <select
                  aria-label="Editorial type filter"
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={editorialTypeFilter}
                  onChange={(event) => setEditorialTypeFilter(event.target.value)}
                >
                  <option value="all">ทุกประเภท</option>
                  <option value="NEW_STORY">เรื่องใหม่</option>
                  <option value="NEW_EPISODE">ตอนใหม่</option>
                </select>
                <select
                  aria-label="Editorial assignee filter"
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={editorialAssigneeFilter}
                  onChange={(event) => setEditorialAssigneeFilter(event.target.value)}
                >
                  <option value="all">ผู้รับผิดชอบทั้งหมด</option>
                  <option value="unassigned">ยังไม่มอบหมาย</option>
                  {editorialAssignees.map((admin: any) => (
                    <option key={admin.id} value={admin.id}>{admin.name || admin.email || `Admin #${admin.id}`}</option>
                  ))}
                </select>
              </div>

              {editorialBoard.isLoading || ensureEditorialBoard.isPending ? (
                <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : editorialColumns.length ? (
                <div className="overflow-x-auto pb-2">
                  <div className="flex min-w-max gap-3">
                    {filteredEditorialColumns.map((column: any) => (
                      <div key={column.id} className="w-64 shrink-0 rounded-lg border bg-muted/20 p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <strong className="text-sm">{column.name}</strong>
                          <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">{column.cards.length}</span>
                        </div>
                        <div className="space-y-2">
                          {column.cards.map((card: any) => (
                            <div key={card.id} className="rounded-md border bg-background p-3 shadow-sm">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                                  {card.workItemType === "NEW_STORY" ? "เรื่องใหม่" : card.workItemType === "NEW_EPISODE" ? "ตอนใหม่" : card.workItemType}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  card v{card.version}{card.workItemVersion ? ` · item v${card.workItemVersion}` : ""}
                                </span>
                              </div>
                              <div className="text-sm font-medium">{card.novel?.title ?? card.logicalItemKey}</div>
                              {card.workItemType === "NEW_EPISODE" && (
                                <div className="mt-1 text-xs">
                                  ตอน {card.episodeNumber || "—"}{card.episodeTitle ? ` · ${card.episodeTitle}` : ""}
                                </div>
                              )}
                              <div className="mt-1 text-xs text-muted-foreground">Novel #{card.novel?.id ?? "—"}</div>
                              <select
                                aria-label={`Assignee for card ${card.id}`}
                                className="mt-2 h-8 w-full rounded-md border bg-background px-2 text-xs"
                                value={card.assigneeUserId ? String(card.assigneeUserId) : ""}
                                disabled={!card.workItemId || !card.workItemVersion || assignEditorialWorkItem.isPending}
                                onChange={(event) => {
                                  if (!card.workItemId || !card.workItemVersion) return;
                                  const nextAssignee = event.target.value ? Number(event.target.value) : null;
                                  assignEditorialWorkItem.mutate({
                                    workspaceId: selectedWorkspaceId,
                                    workItemId: card.workItemId,
                                    assigneeUserId: nextAssignee,
                                    expectedVersion: card.workItemVersion,
                                    idempotencyKey: `editorial-assignee:${card.workItemId}:${card.workItemVersion}:${nextAssignee ?? "none"}`,
                                  });
                                }}
                              >
                                <option value="">ยังไม่มอบหมาย</option>
                                {editorialAssignees.map((admin: any) => (
                                  <option key={admin.id} value={admin.id}>{admin.name || admin.email || `Admin #${admin.id}`}</option>
                                ))}
                              </select>
                              <details className="mt-2 text-xs text-muted-foreground">
                                <summary className="cursor-pointer">ประวัติ {card.history?.length ?? 0} รายการ</summary>
                                <ul className="mt-2 space-y-1 border-l pl-2">
                                  {(card.history ?? []).slice(0, 6).map((entry: any) => (
                                    <li key={`${entry.kind}:${entry.id}`}>
                                      {entry.kind === "transition"
                                        ? `${entry.fromColumnId ? editorialColumnNameById.get(entry.fromColumnId) ?? "?" : "เริ่ม"} → ${editorialColumnNameById.get(entry.toColumnId) ?? "?"}`
                                        : entry.eventType === "assignee_changed"
                                          ? "เปลี่ยนผู้รับผิดชอบ"
                                          : "สร้างงาน"}
                                      {" · "}{formatDate(entry.createdAt)}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                              <Button
                                type="button"
                                variant={selectedSourceWorkItemId === card.workItemId ? "default" : "outline"}
                                className="mt-3 h-8 w-full text-xs"
                                disabled={!card.workItemId}
                                onClick={() => setSelectedSourceWorkItemId(card.workItemId)}
                              >
                                ต้นฉบับ / Draft
                              </Button>
                              <div className="mt-2 flex justify-between">
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  className="h-8 w-8"
                                  disabled={editorialColumns.findIndex((item: any) => item.id === column.id) === 0 || moveEditorialCard.isPending}
                                  onClick={() => {
                                    const currentIndex = editorialColumns.findIndex((item: any) => item.id === column.id);
                                    const target = editorialColumns[currentIndex - 1];
                                    if (!target) return;
                                    moveEditorialCard.mutate({
                                      workspaceId: selectedWorkspaceId,
                                      cardId: card.id,
                                      toColumnKey: target.key,
                                      reason: "editorial_manual_move",
                                      idempotencyKey: `editorial:${card.id}:${card.version}:${target.key}`,
                                      expectedVersion: card.version,
                                    });
                                  }}
                                >
                                  <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  className="h-8 w-8"
                                  disabled={editorialColumns.findIndex((item: any) => item.id === column.id) === editorialColumns.length - 1 || moveEditorialCard.isPending}
                                  onClick={() => {
                                    const currentIndex = editorialColumns.findIndex((item: any) => item.id === column.id);
                                    const target = editorialColumns[currentIndex + 1];
                                    if (!target) return;
                                    moveEditorialCard.mutate({
                                      workspaceId: selectedWorkspaceId,
                                      cardId: card.id,
                                      toColumnKey: target.key,
                                      reason: "editorial_manual_move",
                                      idempotencyKey: `editorial:${card.id}:${card.version}:${target.key}`,
                                      expectedVersion: card.version,
                                    });
                                  }}
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                          {!column.cards.length && <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">ไม่มีงาน</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState>Editorial board is being prepared for this Workspace.</EmptyState>
              )}

              <div className="text-xs text-muted-foreground">
                Kanban transitions: {editorialTransitions.length} event(s). Card history also includes immutable assignment events. Episode intake creates Workspace work items only and does not create publication episodes.
              </div>
            </Card>

            <Card className="space-y-5 p-5">
              <div>
                <div className="flex items-center gap-2">
                  <FileCheck2 className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">Source Import + Draft</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  เลือกการ์ดจาก Kanban แล้วนำเข้า/รีเฟรช Google Docs หรือไฟล์ข้อความ ต้นฉบับเดิมถูกเก็บเป็น immutable snapshot และ Sarabun 18 / indent 36 / spacing 10 เป็น presentation contract แยกจากเนื้อหา
                </p>
              </div>

              {!selectedSourceWorkItemId ? (
                <EmptyState>กด “ต้นฉบับ / Draft” บนการ์ดเรื่องหรือตอนที่ต้องการก่อน</EmptyState>
              ) : (
                <>
                  <div className="rounded-md border bg-muted/20 p-3 text-sm">
                    <strong>{selectedSourceCard?.novel?.title ?? "Editorial work item"}</strong>
                    {selectedSourceCard?.workItemType === "NEW_EPISODE" && (
                      <span className="ml-2 text-muted-foreground">
                        ตอน {selectedSourceCard?.episodeNumber || "—"} {selectedSourceCard?.episodeTitle || ""}
                      </span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">Work item #{selectedSourceWorkItemId}</span>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <form
                      className="space-y-2 rounded-md border p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!googleConnectionId || !googleDocUrl.trim()) {
                          toast.error("เลือก Google connection และใส่ลิงก์ Google Docs");
                          return;
                        }
                        importEditorialGoogleDoc.mutate({
                          workspaceId: selectedWorkspaceId,
                          workItemId: selectedSourceWorkItemId,
                          connectionId: Number(googleConnectionId),
                          documentUrlOrId: googleDocUrl.trim(),
                        });
                      }}
                    >
                      <div className="font-medium">Google Docs</div>
                      <select
                        aria-label="Google Docs connection"
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={googleConnectionId}
                        onChange={(event) => setGoogleConnectionId(event.target.value)}
                      >
                        <option value="">เลือก Google connection</option>
                        {googleConnections.map((connection: any) => (
                          <option key={connection.id} value={connection.id}>
                            Connection #{connection.id}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={googleDocUrl}
                        onChange={(event) => setGoogleDocUrl(event.target.value)}
                        placeholder="https://docs.google.com/document/d/..."
                        maxLength={1000}
                      />
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={!googleConnectionId || !googleDocUrl.trim() || importEditorialGoogleDoc.isPending}
                      >
                        {importEditorialGoogleDoc.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Add / Refresh Google Doc
                      </Button>
                      {!googleConnections.length && (
                        <p className="text-xs text-muted-foreground">
                          ยังไม่มี active Google Docs connection ที่มี read-only scope
                        </p>
                      )}
                    </form>

                    <form
                      className="space-y-2 rounded-md border p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!uploadedSource) {
                          toast.error("เลือกไฟล์ข้อความก่อน");
                          return;
                        }
                        importEditorialSource.mutate({
                          workspaceId: selectedWorkspaceId,
                          workItemId: selectedSourceWorkItemId,
                          payload: {
                            sourceKind: "uploaded_file",
                            sourceKey: `uploaded-file:work-item-${selectedSourceWorkItemId}`,
                            mimeType: uploadedSource.mimeType,
                            title: uploadedSource.name,
                            tabs: [
                              {
                                sourceTabId: "file-main",
                                tabOrder: 0,
                                title: uploadedSource.name,
                                paragraphs: uploadedSource.paragraphs,
                              },
                            ],
                          },
                        });
                      }}
                    >
                      <div className="font-medium">ไฟล์ข้อความ</div>
                      <input
                        type="file"
                        accept=".txt,.md,text/plain,text/markdown"
                        className="block w-full text-sm"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          if (!file) {
                            setUploadedSource(undefined);
                            return;
                          }
                          if (file.size > 10 * 1024 * 1024) {
                            toast.error("ไฟล์ต้องไม่เกิน 10 MB");
                            event.target.value = "";
                            return;
                          }
                          const content = await file.text();
                          setUploadedSource({
                            name: file.name,
                            mimeType: file.type || "text/plain",
                            paragraphs: content.replace(/\r\n?/g, "\n").split("\n"),
                          });
                        }}
                      />
                      <div className="text-xs text-muted-foreground">
                        {uploadedSource
                          ? `${uploadedSource.name} · ${uploadedSource.paragraphs.length} บรรทัด`
                          : "รองรับ TXT / Markdown; source identity คงที่ตาม work item และเปลี่ยนชื่อไฟล์ได้โดยไม่สร้าง source ใหม่"}
                      </div>
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={!uploadedSource || importEditorialSource.isPending}
                      >
                        {importEditorialSource.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Add / Refresh File
                      </Button>
                    </form>
                  </div>

                  {editorialSourceDraft.isLoading ? (
                    <div className="flex min-h-24 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
                  ) : (
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
                        <div className="mt-1 text-xs text-muted-foreground">
                          SHA {shortHash((editorialSourceDraft.data as any)?.latestDraft?.draftSha256)}
                        </div>
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
                  )}

                  {!!(editorialSourceDraft.data as any)?.tabs?.length && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Draft structure</div>
                      {(editorialSourceDraft.data as any).tabs.map((tab: any) => (
                        <div key={tab.id} className="rounded-md border p-3 text-sm">
                          <div className="flex flex-wrap justify-between gap-2">
                            <span>{tab.title}</span>
                            <span className="text-xs text-muted-foreground">
                              {tab.paragraphs.length} paragraphs · {shortHash(tab.structuralSha256)}
                            </span>
                          </div>
                          {(tab.chapterNumber || tab.warnings?.length) && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {tab.chapterNumber ? `บทที่ ${tab.chapterNumber}${tab.chapterTitle ? ` · ${tab.chapterTitle}` : ""}` : ""}
                              {tab.warnings?.length ? ` · ${tab.warnings.join(", ")}` : ""}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">Deterministic Foreign-word Checker</div>
                        <div className="text-xs text-muted-foreground">
                          ตรวจ Draft ปัจจุบันแบบไม่ใช้ AI/API และผูก finding กับ paragraph key + UTF-16 offsets
                        </div>
                      </div>
                      <Button
                        type="button"
                        disabled={
                          !(editorialSourceDraft.data as any)?.latestDraft?.id ||
                          runEditorialForeignChecker.isPending
                        }
                        onClick={() =>
                          runEditorialForeignChecker.mutate({
                            workspaceId: selectedWorkspaceId,
                            workItemId: selectedSourceWorkItemId,
                            expectedDraftId: (editorialSourceDraft.data as any)?.latestDraft?.id,
                          })
                        }
                      >
                        {runEditorialForeignChecker.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        ตรวจ / ตรวจซ้ำ
                      </Button>
                    </div>

                    {editorialCheckerRunStale && (
                      <div className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                        ผลตรวจนี้เป็นของ Draft เก่า — Draft เปลี่ยนแล้ว ให้กด “ตรวจ / ตรวจซ้ำ” ก่อนแก้สถานะ finding
                      </div>
                    )}

                    {(editorialForeignChecker.data as any)?.run ? (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="rounded border p-2 text-sm">
                          Run #{(editorialForeignChecker.data as any).run.id}
                        </div>
                        <div className="rounded border p-2 text-sm">
                          Findings {(editorialForeignChecker.data as any).findings?.length ?? 0}
                        </div>
                        <div className="rounded border p-2 text-sm">
                          ค้างตรวจ {(editorialForeignChecker.data as any).unresolvedCount ?? 0} ·{" "}
                          <strong>{(editorialForeignChecker.data as any).effectiveStatus}</strong>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">ยังไม่ได้ตรวจ Draft นี้</p>
                    )}

                    {!!(editorialForeignChecker.data as any)?.allowWords?.length && (
                      <div className="flex flex-wrap gap-2">
                        {(editorialForeignChecker.data as any).allowWords.map((word: any) => (
                          <button
                            key={word.id}
                            type="button"
                            className="rounded-full border px-2 py-1 text-xs"
                            disabled={unallowEditorialWord.isPending}
                            onClick={() =>
                              unallowEditorialWord.mutate({
                                workspaceId: selectedWorkspaceId,
                                normalizedWord: word.normalizedWord,
                              })
                            }
                          >
                            อนุญาต: {word.displayWord} ×
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="space-y-2">
                      {((editorialForeignChecker.data as any)?.findings ?? []).map((finding: any) => (
                        <div key={finding.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-medium">{finding.token}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {finding.ruleKey} · paragraph {finding.paragraphOrder} · {finding.startOffset}-{finding.endOffset}
                              </span>
                            </div>
                            <StatusPill value={finding.disposition} />
                          </div>
                          <div className="mt-2 rounded bg-background p-2">
                            {finding.sentenceText}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={
                                editorialCheckerRunStale ||
                                finding.ruleKey === "long_english" ||
                                allowEditorialFinding.isPending
                              }
                              onClick={() =>
                                allowEditorialFinding.mutate({
                                  workspaceId: selectedWorkspaceId,
                                  workItemId: selectedSourceWorkItemId,
                                  findingId: finding.id,
                                  expectedVersion: finding.resolutionVersion ?? 0,
                                  idempotencyKey: `editorial-allow:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                })
                              }
                            >
                              ยอมรับคำนี้
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={
                                editorialCheckerRunStale ||
                                resolveEditorialFinding.isPending
                              }
                              onClick={() =>
                                resolveEditorialFinding.mutate({
                                  workspaceId: selectedWorkspaceId,
                                  workItemId: selectedSourceWorkItemId,
                                  findingId: finding.id,
                                  disposition: "ignored",
                                  expectedVersion: finding.resolutionVersion ?? 0,
                                  idempotencyKey: `editorial-ignore:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                })
                              }
                            >
                              Ignore
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={
                                editorialCheckerRunStale ||
                                resolveEditorialFinding.isPending
                              }
                              onClick={() =>
                                resolveEditorialFinding.mutate({
                                  workspaceId: selectedWorkspaceId,
                                  workItemId: selectedSourceWorkItemId,
                                  findingId: finding.id,
                                  disposition: finding.disposition === "open" ? "fixed" : "open",
                                  expectedVersion: finding.resolutionVersion ?? 0,
                                  idempotencyKey: `editorial-resolution:${finding.id}:${finding.resolutionVersion ?? 0}:${finding.disposition === "open" ? "fixed" : "open"}`,
                                })
                              }
                            >
                              {finding.disposition === "open" ? "Mark fixed" : "Reopen"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </Card>

            <Card className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-primary" />
                    <h2 className="text-xl font-semibold">{selected.workspace.name}</h2>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Platform admin access: <span className="font-medium">full</span>. Workspace membership and per-workspace roles do not restrict admin operations.
                  </p>
                </div>
                <StatusPill value={selected.workspace.status} />
              </div>

              <div className="rounded-md border bg-muted/30 p-4">
                <h3 className="font-medium">Operational detail</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Novel intake now lives in the Editorial Kanban above. The sections below retain
                  legacy ownership, source-binding, Checker/AI and publish evidence for operators.
                </p>
              </div>

              <div className="grid gap-5 md:grid-cols-3">
                <div>
                  <h3 className="font-medium">Admin access</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Every platform admin has the same Workspace authority. Historical membership rows are not used for authorization.
                  </p>
                </div>
                <div>
                  <h3 className="font-medium">Capability ownership</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {(ownership.data as any[] | undefined)?.map(({ entry, novel }: any) => (
                      <li key={entry.id}>{novel.title}: {entry.capability} → <strong>{entry.owner}</strong> · epoch {entry.cutoverEpoch} · v{entry.version}</li>
                    ))}
                    {!ownership.data?.length && <li>No novel binding yet; Sheets remains unchanged.</li>}
                  </ul>
                </div>
                <div>
                  <h3 className="font-medium">Source bindings</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {(bindings.data as any[] | undefined)?.map(({ binding, novel }: any) => <li key={binding.id}>{novel.title}: {binding.displayName} ({binding.sourceKind})</li>)}
                    {!bindings.data?.length && <li>No source bindings yet.</li>}
                  </ul>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Database className="h-4 w-4" /> Fingerprints</div>
                <div className="mt-2 text-2xl font-semibold">{fingerprints.data?.length ?? 0}</div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><FileCheck2 className="h-4 w-4" /> Checker runs</div>
                <div className="mt-2 text-2xl font-semibold">{checkerRows.length}</div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Bot className="h-4 w-4" /> AI jobs</div>
                <div className="mt-2 text-2xl font-semibold">{aiRows.length}</div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Activity className="h-4 w-4" /> Publish runs</div>
                <div className="mt-2 text-2xl font-semibold">{publishRows.length}</div>
              </Card>
            </div>

            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold">Document fingerprints & operational projection</h3>
                  <p className="text-sm text-muted-foreground">Metadata/hash only; document body content is not returned by this read model.</p>
                </div>
              </div>
              {operationalState.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : operationalRows.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b text-xs uppercase text-muted-foreground">
                      <tr><th className="py-2 pr-3">Binding</th><th className="py-2 pr-3">Snapshot</th><th className="py-2 pr-3">Revision / hash</th><th className="py-2 pr-3">Checker</th><th className="py-2 pr-3">Parity</th><th className="py-2">Kanban projection</th></tr>
                    </thead>
                    <tbody>
                      {operationalRows.map((row: any) => (
                        <tr key={row.bindingId} className="border-b last:border-0">
                          <td className="py-3 pr-3">#{row.bindingId}</td>
                          <td className="py-3 pr-3">#{row.fingerprint.snapshotId}</td>
                          <td className="py-3 pr-3 font-mono text-xs">{row.fingerprint.providerRevisionId}<br />{shortHash(row.fingerprint.normalizedSha256)}</td>
                          <td className="py-3 pr-3"><StatusPill value={row.checkerStatus} />{row.checker && <div className="mt-1 text-xs text-muted-foreground">E {row.checker.severityCounts.error} · W {row.checker.severityCounts.warning} · I {row.checker.severityCounts.info}</div>}</td>
                          <td className="py-3 pr-3"><StatusPill value={row.parityStatus} /></td>
                          <td className="py-3"><StatusPill value={row.kanbanProjectionStatus} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState>No fingerprint projection exists in this workspace yet.</EmptyState>}
              <div className="text-xs text-muted-foreground">
                Dual-run foundation: {(dualRunState.data as any)?.boards?.length ?? 0} board(s), {(dualRunState.data as any)?.ruleSets?.length ?? 0} rule set(s).
              </div>
            </Card>

            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <FileCheck2 className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold">Checker runs & findings</h3>
                  <p className="text-sm text-muted-foreground">Queue deterministic Checker work against an immutable snapshot and published rule set; execution remains lease-controlled by the Checker worker.</p>
                </div>
              </div>
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]">
                <select aria-label="Checker snapshot" className="h-10 rounded-md border bg-background px-3 text-sm" value={checkerSnapshotId} onChange={(event) => setCheckerSnapshotId(event.target.value)} disabled={!snapshotOptions.length || queueChecker.isPending}>
                  {snapshotOptions.map((snapshot: any) => <option key={snapshot.snapshotId} value={snapshot.snapshotId}>Snapshot #{snapshot.snapshotId} - {shortHash(snapshot.normalizedSha256)}</option>)}
                </select>
                <select aria-label="Checker rule set" className="h-10 rounded-md border bg-background px-3 text-sm" value={checkerRuleSetId} onChange={(event) => setCheckerRuleSetId(event.target.value)} disabled={!checkerRuleSets.length || queueChecker.isPending}>
                  {checkerRuleSets.map((ruleSet: any) => <option key={ruleSet.id} value={ruleSet.id}>{ruleSet.name} v{ruleSet.versionNo}</option>)}
                </select>
                <Button disabled={!selectedWorkspaceId || !effectiveCheckerSnapshotId || !effectiveCheckerRuleSetId || queueChecker.isPending} onClick={() => queueChecker.mutate({ workspaceId: selectedWorkspaceId!, snapshotId: effectiveCheckerSnapshotId, ruleSetId: effectiveCheckerRuleSetId })}>
                  {queueChecker.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run Checker
                </Button>
                {(!snapshotOptions.length || !checkerRuleSets.length) && <p className="text-xs text-muted-foreground md:col-span-3">Requires a fingerprint snapshot and a published Checker rule set. Duplicate requests are idempotent.</p>}
              </div>
              {checkerRows.length ? (
                <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.8fr)]">
                  <div className="space-y-2">
                    {checkerRows.map((row: any) => (
                      <button key={row.run.id} type="button" onClick={() => setSelectedCheckerRunId(row.run.id)} className={`w-full rounded-md border p-3 text-left text-sm ${effectiveCheckerRunId === row.run.id ? "border-primary bg-primary/5" : ""}`}>
                        <div className="flex items-center justify-between gap-2"><strong>Run #{row.run.id}</strong><StatusPill value={row.run.status} /></div>
                        <div className="mt-1 text-xs text-muted-foreground">Snapshot #{row.run.snapshotId} · {row.ruleSet.name} v{row.ruleSet.versionNo}</div>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-md border p-4">
                    {checkerDetail.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : checkerDetail.data ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><strong>Run #{(checkerDetail.data as any).run.id}</strong><StatusPill value={(checkerDetail.data as any).run.status} /></div>
                        <div className="text-xs text-muted-foreground">Engine {(checkerDetail.data as any).run.engineVersion} · created {formatDate((checkerDetail.data as any).run.createdAt)}</div>
                        {(checkerDetail.data as any).findings.length ? (
                          <ul className="space-y-2 text-sm">
                            {(checkerDetail.data as any).findings.map((finding: any) => <li key={finding.id} className="rounded border p-2"><StatusPill value={finding.severity} /> <span className="font-medium">{finding.ruleKey}</span><div className="mt-1 text-xs text-muted-foreground">{finding.locationKey} · {shortHash(finding.excerptSha256)}</div></li>)}
                          </ul>
                        ) : <EmptyState>No findings persisted for this run.</EmptyState>}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : <EmptyState>No Checker runs exist in this workspace.</EmptyState>}
            </Card>

            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold">AI QC operational state</h3>
                  <p className="text-sm text-muted-foreground">Queue advisory AI QC work against an immutable snapshot, or retry a failed job. Provider execution remains worker/config gated.</p>
                </div>
              </div>
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_auto]">
                <select aria-label="AI QC snapshot" className="h-10 rounded-md border bg-background px-3 text-sm" value={aiSnapshotId} onChange={(event) => setAiSnapshotId(event.target.value)} disabled={!snapshotOptions.length || queueAi.isPending}>
                  {snapshotOptions.map((snapshot: any) => <option key={snapshot.snapshotId} value={snapshot.snapshotId}>Snapshot #{snapshot.snapshotId} - {shortHash(snapshot.normalizedSha256)}</option>)}
                </select>
                <Button disabled={!selectedWorkspaceId || !effectiveAiSnapshotId || queueAi.isPending} onClick={() => queueAi.mutate({ workspaceId: selectedWorkspaceId!, snapshotId: effectiveAiSnapshotId, operation: "semantic_qc", promptVersion: "qc-prompt-v1", modelPolicyVersion: "qc-policy-v1" })}>
                  {queueAi.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Queue AI QC
                </Button>
                {!snapshotOptions.length && <p className="text-xs text-muted-foreground md:col-span-2">Requires a fingerprint snapshot. AI output remains advisory; this action does not write Docs, transition Kanban, or publish.</p>}
              </div>
              {aiRows.length ? (
                <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.8fr)]">
                  <div className="space-y-2">
                    {aiRows.map((job: any) => (
                      <button key={job.id} type="button" onClick={() => setSelectedAiJobId(job.id)} className={`w-full rounded-md border p-3 text-left text-sm ${effectiveAiJobId === job.id ? "border-primary bg-primary/5" : ""}`}>
                        <div className="flex items-center justify-between gap-2"><strong>Job #{job.id}</strong><StatusPill value={job.status} /></div>
                        <div className="mt-1 text-xs text-muted-foreground">Snapshot #{job.snapshotId} · {job.operation}</div>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-md border p-4">
                    {aiOperational.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : aiOperational.data ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><strong>Job #{(aiOperational.data as any).job.id}</strong><div className="flex items-center gap-2"><StatusPill value={(aiOperational.data as any).operational.state} />{(aiOperational.data as any).job.status === "failed" && <Button size="sm" variant="outline" disabled={retryAi.isPending} onClick={() => retryAi.mutate({ workspaceId: selectedWorkspaceId!, jobId: (aiOperational.data as any).job.id })}>{retryAi.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}Retry</Button>}</div></div>
                        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                          <div>Attempts: {(aiOperational.data as any).attempts.length}</div>
                          <div>Artifacts: {(aiOperational.data as any).artifacts.length}</div>
                          <div>Receipt count: {(aiOperational.data as any).operational.distinctProviderReceiptCount}</div>
                        </div>
                        <div className="text-sm">Recovery required: <strong>{(aiOperational.data as any).operational.recoveryRequired ? "yes" : "no"}</strong></div>
                        {(aiOperational.data as any).attempts.length ? <ul className="space-y-1 text-xs text-muted-foreground">{(aiOperational.data as any).attempts.map((attempt: any) => <li key={attempt.id}>Attempt #{attempt.attemptNo} · {attempt.status} · receipt {attempt.providerRequestId ?? "—"} · {attempt.errorClass ?? "no error"}</li>)}</ul> : <EmptyState>No attempts persisted yet.</EmptyState>}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : <EmptyState>No AI QC jobs exist in this workspace.</EmptyState>}
            </Card>

            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold">Publish runs, outbox & readiness</h3>
                  <p className="text-sm text-muted-foreground">Read-only operational evidence. No execute, cutover or rollback controls are exposed.</p>
                </div>
              </div>
              {publishRows.length ? (
                <div className="grid gap-4 xl:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.9fr)]">
                  <div className="space-y-2">
                    {publishRows.map((row: any) => (
                      <button key={row.run.id} type="button" onClick={() => setSelectedPublishRunId(row.run.id)} className={`w-full rounded-md border p-3 text-left text-sm ${effectivePublishRunId === row.run.id ? "border-primary bg-primary/5" : ""}`}>
                        <div className="flex items-center justify-between gap-2"><strong>Run #{row.run.id}</strong><StatusPill value={row.run.status} /></div>
                        <div className="mt-1 text-xs text-muted-foreground">Novel #{row.workspaceNovel.id} · owner {row.ownership?.owner ?? "unknown"} epoch {row.ownership?.cutoverEpoch ?? "?"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">Items {row.itemCount} · unresolved {row.unresolvedItemCount} · outbox backlog {row.outboxBacklogCount}</div>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-4 rounded-md border p-4">
                    {publishDetail.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : publishDetail.data ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2"><strong>Publish run #{(publishDetail.data as any).run.id}</strong><StatusPill value={(publishDetail.data as any).run.status} /></div>
                        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                          <div>Snapshot #{(publishDetail.data as any).run.snapshotId}</div>
                          <div>Items {(publishDetail.data as any).items.length}</div>
                          <div>Outbox {(publishDetail.data as any).outbox.length}</div>
                          <div>Expected hash {shortHash((publishDetail.data as any).run.expectedLastPublishedSha256)}</div>
                        </div>
                        <div>
                          <h4 className="text-sm font-medium">Items</h4>
                          {(publishDetail.data as any).items.length ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{(publishDetail.data as any).items.map((item: any) => <li key={item.id}>{item.itemKey} · {item.status} · receipt {item.providerReceipt ?? "—"}</li>)}</ul> : <EmptyState>No publish items persisted.</EmptyState>}
                        </div>
                        <div>
                          <h4 className="text-sm font-medium">Outbox</h4>
                          {(publishDetail.data as any).outbox.length ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{(publishDetail.data as any).outbox.map((entry: any) => <li key={entry.id}>#{entry.id} · {entry.status} · attempts {entry.attempts} · epoch {entry.ownershipEpoch ?? "—"}</li>)}</ul> : <EmptyState>No outbox rows for this run.</EmptyState>}
                        </div>
                        <div className="rounded-md bg-muted/30 p-3 text-sm">
                          {readinessEligible ? (
                            publishReadiness.isLoading ? <span>Loading readiness…</span> : publishReadiness.data ? (
                              <div className="space-y-1"><div>Cutover readiness: <strong>{(publishReadiness.data as any).readyForSyntheticCutover ? "ready" : "blocked"}</strong></div><div className="text-xs text-muted-foreground">Blockers: {(publishReadiness.data as any).blockers.join(", ") || "none"}</div><div className="font-mono text-xs">Digest {shortHash((publishReadiness.data as any).readinessDigest)}</div></div>
                            ) : publishReadiness.error ? <span className="text-destructive">Readiness unavailable: {publishReadiness.error.message}</span> : null
                          ) : <span className="text-muted-foreground">Cutover readiness applies only to exactly one Sheets-owned publish registry row at epoch 0. Current state: {selectedPublishSummary?.ownership?.owner ?? "unknown"} epoch {selectedPublishSummary?.ownership?.cutoverEpoch ?? "?"}.</span>}
                        </div>
                        <div className="rounded-md bg-muted/30 p-3 text-sm">
                          {!canInspectFinalGate ? <span className="text-muted-foreground">Final gate package requires platform admin access.</span> : !readinessEligible ? <span className="text-muted-foreground">Final gate package is not applicable in the current ownership epoch.</span> : finalGate.isLoading ? <span>Loading final gate…</span> : finalGate.data ? <div className="space-y-1"><div>Preview ready: <strong>{(finalGate.data as any).gate.previewReady ? "yes" : "no"}</strong></div><div>Operator cutover eligible: <strong>{(finalGate.data as any).gate.operatorCutoverEligible ? "yes" : "no"}</strong></div><div className="text-xs text-muted-foreground">Execution enabled in gate input: {(finalGate.data as any).gate.executionEnabled ? "yes" : "no"}</div><div className="text-xs text-muted-foreground">Blockers: {(finalGate.data as any).gate.blockers.join(", ") || "none"}</div></div> : finalGate.error ? <span className="text-destructive">Final gate unavailable: {finalGate.error.message}</span> : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : <EmptyState>No publish runs exist in this workspace.</EmptyState>}
            </Card>

            <Card className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <GitBranch className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold">Ownership & cutover history</h3>
                  <p className="text-sm text-muted-foreground">Persisted transition evidence only; this panel cannot change registry ownership.</p>
                </div>
              </div>
              {publishTransitions.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b text-xs uppercase text-muted-foreground"><tr><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Novel</th><th className="py-2 pr-3">Run</th><th className="py-2 pr-3">Direction</th><th className="py-2 pr-3">Owner</th><th className="py-2">Epoch / version</th></tr></thead>
                    <tbody>{publishTransitions.map((transition: any) => <tr key={transition.id} className="border-b last:border-0"><td className="py-3 pr-3">{formatDate(transition.createdAt)}</td><td className="py-3 pr-3">#{transition.workspaceNovelId}</td><td className="py-3 pr-3">#{transition.publishRunId}</td><td className="py-3 pr-3"><StatusPill value={transition.direction} /></td><td className="py-3 pr-3">{transition.fromOwner} → {transition.toOwner}</td><td className="py-3">{transition.fromEpoch}→{transition.toEpoch} / v{transition.fromVersion}→v{transition.toVersion}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : <EmptyState>No publish ownership transitions exist in this workspace.</EmptyState>}
              <p className="text-xs text-muted-foreground">Control Center publish projection reports sideEffectsApplied = {String((publishOverview.data as any)?.sideEffectsApplied ?? false)} and readOnly = {String((publishOverview.data as any)?.readOnly ?? true)}.</p>
            </Card>
          </div>
        ) : null}
      </section>
    </main>
  );
}
