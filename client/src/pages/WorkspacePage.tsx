import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAdminGuard } from "@/hooks/useAdminGuard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { summarizeEditorialDraftTabs } from "./workspaceEditorialDraftSummary";
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
  const [editorialSearch, setEditorialSearch] = useState("");
  const [editorialQuickFilter, setEditorialQuickFilter] = useState("all");
  const [editorialView, setEditorialView] = useState<"table" | "kanban">("table");
  const [episodeNovelSearch, setEpisodeNovelSearch] = useState("");
  const [selectedSourceWorkItemId, setSelectedSourceWorkItemId] = useState<number>();
  const [googleConnectionId, setGoogleConnectionId] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [episodeGoogleDocUrl, setEpisodeGoogleDocUrl] = useState("");
  const [uploadedSource, setUploadedSource] = useState<{
    name: string;
    mimeType: string;
    paragraphs: string[];
  }>();
  const [editorTarget, setEditorTarget] = useState<{
    kind: "replace_sentence" | "replace_range" | "replace_paragraph";
    label: string;
    paragraphKey: string;
    expectedParagraphFingerprint: string;
    startOffset?: number;
    endOffset?: number;
    expectedText: string;
    draftId: number;
    draftVersion: number;
    draftSha256: string;
    findingId?: number;
    findingKey?: string;
  }>();
  const [editorText, setEditorText] = useState("");
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
  const editorialEvidenceWorkItemIds = (((editorialBoard.data as any)?.columns ?? []) as any[])
    .flatMap((column: any) => column.cards ?? [])
    .map((card: any) => card.workItemId)
    .filter((id: any): id is number => Number.isInteger(id) && id > 0);
  const editorialEvidenceStatuses = trpc.workspace.editorial.evidenceStatuses.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, workItemIds: editorialEvidenceWorkItemIds },
    { enabled: isAdmin && Boolean(selectedWorkspaceId) && editorialEvidenceWorkItemIds.length > 0, retry: false }
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
  const editorialPublish = trpc.workspace.editorial.publish.useQuery(
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
    setEditorTarget(undefined);
    setEditorText("");
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
      await Promise.all([
        detail.refetch(),
        bindings.refetch(),
        ownership.refetch(),
        availableNovels.refetch(),
        editorialBoard.refetch(),
      ]);
      toast.success("สร้างเรื่องใหม่แล้ว — เพิ่ม Episode Pack เมื่อต้องการเริ่มงานตอน");
    },
    onError: (error) => toast.error(error.message),
  });
  const createEditorialEpisode = trpc.workspace.editorial.createEpisode.useMutation({
    onSuccess: async (result, variables) => {
      const quickDocUrl = episodeGoogleDocUrl.trim();
      let quickImportSucceeded = false;
      setEpisodeNumber("");
      setEpisodeTitle("");
      setEpisodeGoogleDocUrl("");
      const refreshed = await editorialBoard.refetch();
      const board: any = refreshed.data ?? result.board;
      const episodeCard = board?.columns
        ?.flatMap((column: any) => column.cards ?? [])
        .find(
          (card: any) =>
            card.workItemType === "NEW_EPISODE" &&
            card.workspaceNovelId === variables.workspaceNovelId &&
            String(card.episodeNumber ?? "").trim() === variables.episodeNumber.trim()
        );
      if (episodeCard?.workItemId) {
        setSelectedSourceWorkItemId(episodeCard.workItemId);
      }
      if (quickDocUrl) {
        setGoogleDocUrl(quickDocUrl);
        if (!episodeCard?.workItemId) {
          toast.error("เพิ่มตอนแล้ว แต่ยังหา Editorial work item สำหรับ Quick Import ไม่พบ");
        } else {
          const connectionId =
            Number(googleConnectionId) || Number(googleConnections[0]?.id);
          if (!connectionId) {
            toast.error("เพิ่มตอนแล้ว แต่ยังไม่มี Google Docs connection สำหรับ Quick Import");
          } else {
            try {
              await importEditorialGoogleDoc.mutateAsync({
                workspaceId: selectedWorkspaceId!,
                workItemId: episodeCard.workItemId,
                connectionId,
                documentUrlOrId: quickDocUrl,
              });
              quickImportSucceeded = true;
            } catch {
              // The Google import mutation already reports the provider error.
            }
          }
        }
      }
      toast.success(
        quickImportSucceeded
          ? "เพิ่มตอนและนำเข้า Google Docs แล้ว"
          : "Episode work item added"
      );
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
  const importEditorialSource = trpc.workspace.editorial.importSource.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
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
        editorialApproval.refetch(),
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
  const editEditorialDraft = trpc.workspace.editorial.editorEdit.useMutation({
    onSuccess: async (result) => {
      setEditorTarget(undefined);
      setEditorText("");
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialEditor.refetch(),
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
        editorialBoard.refetch(),
      ]);
      if (
        selectedWorkspaceId &&
        selectedSourceWorkItemId &&
        result.draft?.id &&
        result.isCurrent !== false
      ) {
        await runEditorialForeignChecker.mutateAsync({
          workspaceId: selectedWorkspaceId,
          workItemId: selectedSourceWorkItemId,
          expectedDraftId: result.draft.id,
        });
      }
      toast.success(
        result.replayed
          ? "ใช้ผลบันทึกเดิมอย่างปลอดภัย"
          : "บันทึก Draft เวอร์ชันใหม่และตรวจซ้ำแล้ว"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const undoEditorialEdit = trpc.workspace.editorial.editorUndo.useMutation({
    onSuccess: async (result) => {
      setEditorTarget(undefined);
      setEditorText("");
      await Promise.all([
        editorialSourceDraft.refetch(),
        editorialEditor.refetch(),
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
        editorialBoard.refetch(),
      ]);
      if (
        selectedWorkspaceId &&
        selectedSourceWorkItemId &&
        result.draft?.id &&
        result.isCurrent !== false
      ) {
        await runEditorialForeignChecker.mutateAsync({
          workspaceId: selectedWorkspaceId,
          workItemId: selectedSourceWorkItemId,
          expectedDraftId: result.draft.id,
        });
      }
      toast.success("Undo สร้าง Draft เวอร์ชันใหม่และตรวจซ้ำแล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const approveEditorialDraft = trpc.workspace.editorial.approveDraft.useMutation({
    onSuccess: async (result) => {
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
    onSuccess: async (result) => {
      await Promise.all([
        editorialApproval.refetch(),
        editorialPublish.refetch(),
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
  const prepareEditorialPublishOwnership = trpc.workspace.editorial.preparePublishOwnership.useMutation({
    onSuccess: async () => {
      await Promise.all([editorialPublish.refetch(), ownership.refetch(), publishOverview.refetch()]);
      toast.success("Publish ownership พร้อมแล้ว — ตรวจสถานะก่อนกด Publish (Controlled)");
    },
    onError: (error) => toast.error(error.message),
  });
  const requestEditorialPublish = trpc.workspace.editorial.requestPublish.useMutation({
    onSuccess: async () => {
      await Promise.all([
        editorialApproval.refetch(),
        editorialPublish.refetch(),
        editorialBoard.refetch(),
        publishOverview.refetch(),
      ]);
      toast.success("Controlled Publish ถูก enqueue แล้ว");
    },
    onError: async (error) => {
      await Promise.all([
        editorialPublish.refetch(),
        publishOverview.refetch(),
      ]);
      toast.error(error.message);
    },
  });
  const resolveEditorialFinding = trpc.workspace.editorial.foreignCheckerResolve.useMutation({
    onSuccess: async () => {
      await Promise.all([
        editorialForeignChecker.refetch(),
        editorialApproval.refetch(),
      ]);
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
  const submitEditorEdit = (source: "manual" | "autosave") => {
    if (
      !selectedWorkspaceId ||
      !selectedSourceWorkItemId ||
      !editorTarget ||
      editEditorialDraft.isPending ||
      editorText === editorTarget.expectedText
    ) {
      return;
    }
    const command =
      editorTarget.kind === "replace_paragraph"
        ? {
            kind: "replace_paragraph" as const,
            paragraphKey: editorTarget.paragraphKey,
            expectedParagraphFingerprint:
              editorTarget.expectedParagraphFingerprint,
            expectedText: editorTarget.expectedText,
            replacementText: editorText,
          }
        : {
            kind: editorTarget.kind,
            paragraphKey: editorTarget.paragraphKey,
            expectedParagraphFingerprint:
              editorTarget.expectedParagraphFingerprint,
            startOffset: editorTarget.startOffset ?? 0,
            endOffset: editorTarget.endOffset ?? 0,
            expectedText: editorTarget.expectedText,
            replacementText: editorText,
          };
    editEditorialDraft.mutate({
      workspaceId: selectedWorkspaceId,
      workItemId: selectedSourceWorkItemId,
      expectedDraftId: editorTarget.draftId,
      expectedDraftVersion: editorTarget.draftVersion,
      expectedDraftSha256: editorTarget.draftSha256,
      findingId: editorTarget.findingId,
      findingKey: editorTarget.findingKey,
      command,
      idempotencyKey: `editor-${source}:${editorTarget.draftId}:${editorTarget.paragraphKey}:${Date.now()}`,
    });
  };

  useEffect(() => {
    if (
      !editorTarget ||
      editorText === editorTarget.expectedText ||
      editEditorialDraft.isPending
    ) {
      return;
    }
    const timer = window.setTimeout(() => submitEditorEdit("autosave"), 3000);
    return () => window.clearTimeout(timer);
  }, [editorTarget, editorText, editEditorialDraft.isPending]);

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
  const editorialEvidenceByWorkItemId = new Map(
    (((editorialEvidenceStatuses.data as any[]) ?? [])).map((status: any) => [status.workItemId, status])
  );
  const editorialCards = editorialColumns.flatMap((column: any) =>
    (column.cards ?? [])
      .filter((card: any) => card.workItemType !== "NEW_STORY")
      .map((card: any) => ({
        ...card,
        columnKey: column.key,
        columnName: column.name,
        evidence: editorialEvidenceByWorkItemId.get(card.workItemId) ?? null,
      }))
  );
  const selectedSourceCard = editorialCards.find(
    (card: any) => card.workItemId === selectedSourceWorkItemId
  );
  const editorialDraftData = editorialSourceDraft.data as any;
  const latestEditorialDraft = editorialDraftData?.latestDraft;
  const editorialEditorData = editorialEditor.data as any;
  const editorialApprovalData = editorialApproval.data as any;
  const editorialCheckerData = editorialForeignChecker.data as any;
  const editorialCheckerRunStale = Boolean(
    editorialCheckerData?.run &&
      editorialCheckerData?.latestDraft &&
      editorialCheckerData.run.draftId !== editorialCheckerData.latestDraft.id
  );
  const googleConnections = (
    (editorialGoogleConnections.data as any[] | undefined) ?? []
  ).filter((connection: any) => connection.status === "active" && connection.scopeReady);
  const firstGoogleConnectionId = googleConnections[0]?.id;
  const draftStructureSummary = useMemo(
    () => summarizeEditorialDraftTabs(editorialDraftData?.tabs ?? []),
    [editorialDraftData?.tabs]
  );
  useEffect(() => {
    if (!googleConnectionId && firstGoogleConnectionId) {
      setGoogleConnectionId(String(firstGoogleConnectionId));
    }
  }, [firstGoogleConnectionId, googleConnectionId]);
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
  const normalizedEditorialSearch = editorialSearch.trim().toLocaleLowerCase("th");
  const visibleEditorialCards = editorialCards.filter((card: any) => {
    const haystack = [card.novel?.title, card.novel?.id, card.episodeNumber, card.episodeTitle, card.note, card.columnName]
      .filter((value) => value != null)
      .join(" ")
      .toLocaleLowerCase("th");
    const matchesSearch = !normalizedEditorialSearch || haystack.includes(normalizedEditorialSearch);
    const matchesQuickFilter =
      editorialQuickFilter === "all" ||
      (editorialQuickFilter === "new" && !card.evidence?.checkerRan) ||
      (editorialQuickFilter === "unchecked" && !card.evidence?.checker) ||
      (editorialQuickFilter === "needs_fix" && card.evidence?.checkerRan && !card.evidence?.checker) ||
      (editorialQuickFilter === "awaiting_confirm" && card.evidence?.checker && !card.evidence?.approval) ||
      (editorialQuickFilter === "ready_stage" && card.evidence?.approval && !card.evidence?.stage) ||
      (editorialQuickFilter === "ready_publish" && card.evidence?.readyToPublish && !card.evidence?.published) ||
      (editorialQuickFilter === "published" && card.evidence?.published);
    return matchesSearch && matchesQuickFilter;
  });
  const normalizedEpisodeNovelSearch = episodeNovelSearch.trim().toLocaleLowerCase("th");
  const searchableWorkspaceNovelOptions = workspaceNovelOptions.filter(({ workspaceNovel, novel }: any) =>
    !normalizedEpisodeNovelSearch ||
    [novel.title, novel.id, workspaceNovel.id].join(" ").toLocaleLowerCase("th").includes(normalizedEpisodeNovelSearch)
  );
  const editorialNovelGroups = Array.from(
    visibleEditorialCards.reduce((groups: Map<number, any>, card: any) => {
      const key = Number(card.workspaceNovelId ?? card.novel?.id ?? card.id);
      const existing = groups.get(key) ?? { workspaceNovelId: card.workspaceNovelId, novel: card.novel, cards: [] };
      existing.cards.push(card);
      groups.set(key, existing);
      return groups;
    }, new Map<number, any>()).values()
  ).sort((a: any, b: any) => String(a.novel?.title ?? "").localeCompare(String(b.novel?.title ?? ""), "th"));
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

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Workspace</span>
        <select aria-label="Workspace" className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm" value={selectedWorkspaceId ?? ""} onChange={(event) => setSelectedWorkspaceId(Number(event.target.value) || undefined)}>
          <option value="">เลือก Workspace</option>
          {(workspaces.data as any[] | undefined)?.map(({ workspace }: any) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
      </div>

      <section className="space-y-6">
        <Card className="hidden">
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
                    <h2 className="text-xl font-semibold">Editorial Episode Packs</h2>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Table-first workspace: Novel เป็นกลุ่ม และแต่ละแถวคือ Episode Pack / ไฟล์งาน โดย workflow เดิมยังคงเป็น durable evidence ด้านหลัง.
                  </p>
                </div>
                <StatusPill value={(editorialBoard.data as any)?.board?.status ?? "initializing"} />
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/10 p-3 text-sm">
                <span className="font-medium">Google Docs สำหรับ Quick Import</span>
                <select
                  aria-label="Quick import Google Docs connection"
                  className="h-9 min-w-52 rounded-md border bg-background px-3 text-sm"
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
                <span className="text-xs text-muted-foreground">
                  ใส่ลิงก์ตอนสร้างเรื่อง/เพิ่มตอนได้เลย · รองรับ Google Docs ที่มีหลายแท็บในลิงก์เดียว
                </span>
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
                  <div className="text-xs text-muted-foreground">
                    สร้าง Novel container เท่านั้น · ยังไม่สร้าง Episode Pack หรือ Draft ให้เพิ่มช่วงตอนจาก “เพิ่มตอนใหม่” เมื่อพร้อม
                  </div>
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
                  <Input
                    value={episodeNovelSearch}
                    onChange={(event) => setEpisodeNovelSearch(event.target.value)}
                    placeholder="ค้นหาเรื่องด้วยชื่อ / Novel ID"
                  />
                  <select
                    aria-label="Episode novel"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={episodeWorkspaceNovelId}
                    onChange={(event) => setEpisodeWorkspaceNovelId(event.target.value)}
                  >
                    <option value="">เลือกเรื่อง</option>
                    {searchableWorkspaceNovelOptions.map(({ workspaceNovel, novel }: any) => (
                      <option key={workspaceNovel.id} value={workspaceNovel.id}>
                        {novel.title} · Novel #{novel.id}
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={episodeNumber} onChange={(event) => setEpisodeNumber(event.target.value)} maxLength={100} placeholder="ตอน / ช่วงตอน" />
                    <Input value={episodeTitle} onChange={(event) => setEpisodeTitle(event.target.value)} maxLength={500} placeholder="ชื่อตอน (ถ้ามี)" />
                  </div>
                  <Input
                    value={episodeGoogleDocUrl}
                    onChange={(event) => setEpisodeGoogleDocUrl(event.target.value)}
                    maxLength={1000}
                    placeholder="Google Docs link สำหรับ Import (ถ้ามี)"
                    disabled={createEditorialEpisode.isPending}
                  />
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

              <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div><div className="font-medium">Editorial Workspace</div><div className="text-xs text-muted-foreground">Table เป็นมุมมองหลัก · Kanban ใช้ดู workflow เดิมจากข้อมูลชุดเดียวกัน</div></div>
                  <div className="flex items-center gap-2">
                    <div className="flex rounded-md border bg-background p-1" aria-label="Editorial view">
                      <Button type="button" size="sm" variant={editorialView === "table" ? "default" : "ghost"} onClick={() => setEditorialView("table")}>Table</Button>
                      <Button type="button" size="sm" variant={editorialView === "kanban" ? "default" : "ghost"} onClick={() => setEditorialView("kanban")}>Kanban</Button>
                    </div>
                    <span className="text-xs text-muted-foreground">{visibleEditorialCards.length}/{editorialCards.length} pack(s)</span>
                  </div>
                </div>
                <Input value={editorialSearch} onChange={(event) => setEditorialSearch(event.target.value)} placeholder="ค้นหาชื่อเรื่อง / Novel ID / ช่วงตอน / ชื่อตอน / หมายเหตุ" aria-label="Editorial pack search" />
                <div className="flex flex-wrap gap-2">
                  {[["all","ทั้งหมด"],["new","มาใหม่"],["unchecked","ยังไม่ตรวจ"],["needs_fix","ต้องแก้"],["awaiting_confirm","รอยืนยัน"],["ready_stage","พร้อม Stage"],["ready_publish","พร้อมลง"],["published","ลงแล้ว"]].map(([key,label]) => (
                    <Button key={key} type="button" size="sm" variant={editorialQuickFilter === key ? "default" : "outline"} onClick={() => setEditorialQuickFilter(key)}>{label}</Button>
                  ))}
                </div>
              </div>
              {editorialBoard.isLoading || ensureEditorialBoard.isPending ? (
                <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : editorialView === "kanban" ? (
                <div className="grid gap-3 xl:grid-cols-4">
                  {editorialColumns.map((column: any) => {
                    const cards = visibleEditorialCards.filter((card: any) => card.columnId === column.id);
                    return <div key={column.id} className="rounded-lg border bg-muted/10">
                      <div className="flex items-center justify-between border-b px-3 py-2"><strong className="text-sm">{column.name}</strong><span className="text-xs text-muted-foreground">{cards.length}</span></div>
                      <div className="space-y-2 p-2">
                        {cards.map((card: any) => <button key={card.id} type="button" disabled={!card.workItemId} onClick={() => setSelectedSourceWorkItemId(card.workItemId)} className="w-full rounded-md border bg-background p-3 text-left text-sm hover:bg-muted/20"><div className="font-medium">{card.novel?.title ?? "Untitled novel"}</div><div className="mt-1 text-xs text-muted-foreground">{card.workItemType === "NEW_EPISODE" ? card.episodeNumber || "ตอนใหม่" : "เรื่องใหม่ / Draft แรก"}</div>{card.note && <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{card.note}</div>}</button>)}
                        {!cards.length && <div className="p-3 text-center text-xs text-muted-foreground">ไม่มี Episode Pack</div>}
                      </div>
                    </div>;
                  })}
                </div>
              ) : editorialNovelGroups.length ? (
                <div className="space-y-3">{editorialNovelGroups.map((group: any) => (
                  <details key={group.workspaceNovelId ?? group.novel?.id} className="overflow-hidden rounded-lg border bg-background">
                    <summary className="cursor-pointer select-none bg-muted/20 px-4 py-3"><span className="font-semibold">{group.novel?.title ?? "Untitled novel"}</span><span className="ml-2 text-xs text-muted-foreground">{group.cards.length} pack(s) · Novel #{group.novel?.id ?? "—"}</span></summary>
                    <div className="overflow-x-auto"><table className="w-full min-w-[980px] border-collapse text-sm">
                      <thead><tr className="border-y bg-muted/10 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">เรื่อง / ช่วงตอน</th><th className="px-3 py-2 text-center font-medium">ตรวจคำ</th><th className="px-3 py-2 text-center font-medium">ตรวจแล้ว</th><th className="px-3 py-2 text-center font-medium">Stage</th><th className="px-3 py-2 text-center font-medium">พร้อมลง</th><th className="px-3 py-2 text-center font-medium">เผยแพร่</th><th className="min-w-72 px-3 py-2 font-medium">หมายเหตุ</th></tr></thead>
                      <tbody>{group.cards.slice().sort((a: any,b: any)=>String(a.episodeNumber??"").localeCompare(String(b.episodeNumber??""),"th",{numeric:true})).map((card:any)=>(
                        <tr key={card.id} className="border-b last:border-b-0 hover:bg-muted/10">
                          <td className="px-3 py-3"><button type="button" className="text-left font-medium text-primary hover:underline" disabled={!card.workItemId} onClick={()=>setSelectedSourceWorkItemId(card.workItemId)}>{card.workItemType==="NEW_EPISODE" ? card.episodeNumber||"ตอนใหม่" : "เรื่องใหม่ / Draft แรก"}</button>{card.episodeTitle&&<div className="mt-0.5 text-xs text-muted-foreground">{card.episodeTitle}</div>}<div className="mt-0.5 text-[11px] text-muted-foreground">{card.columnName}</div></td>
                          {[
                            ["checker", card.evidence?.checker, "Deterministic Checker ผ่านบน Draft ปัจจุบัน"],
                            ["approval", card.evidence?.approval, "Approval ตรงกับ Draft/QC ปัจจุบัน"],
                            ["stage", card.evidence?.stage, "Episode staging ครบและยัง valid"],
                            ["ready", card.evidence?.readyToPublish, "Publish readiness ผ่าน stage + ownership + anchor"],
                            ["published", card.evidence?.published, "Publish run + receipt + outbox + reader visibility ครบ"],
                          ].map(([key, passed, label]) => (
                            <td key={String(key)} className="px-3 py-3 text-center" title={String(label)}>
                              {card.evidence ? (
                                <span aria-label={passed ? "ผ่าน" : "ยังไม่ผ่าน"} className={passed ? "font-semibold text-foreground" : "text-muted-foreground"}>
                                  {passed ? "✓" : "—"}
                                </span>
                              ) : <span className="text-muted-foreground">…</span>}
                            </td>
                          ))}
                          <td className="px-3 py-2"><Input key={String(card.workItemId) + ":" + String(card.workItemVersion) + ":" + String(card.note ?? "")} defaultValue={card.note??""} maxLength={1000} placeholder="บันทึกหมายเหตุ" disabled={!card.workItemId||!card.workItemVersion||updateEditorialWorkItemNote.isPending} onBlur={(event)=>{const next=event.currentTarget.value.trim();if(next===(card.note??""))return;updateEditorialWorkItemNote.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId,note:next||null,expectedVersion:card.workItemVersion});}} /></td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  </details>
                ))}</div>
              ) : <EmptyState>Editorial board is being prepared for this Workspace.</EmptyState>}

              <div className="text-xs text-muted-foreground">
                Kanban transitions: {editorialTransitions.length} event(s). Card history also includes immutable assignment events. Episode intake creates Workspace work items only and does not create publication episodes.
              </div>
            </Card>

            <Card className="space-y-5 p-5">
              <div>
                <div className="flex items-center gap-2">
                  <FileCheck2 className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">Episode Pack Detail</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  เปิดแถว Episode Pack จากตาราง แล้วทำงานตามลำดับ Google Docs Import → Draft → Checker → แก้ประโยค → Confirm → Stage → Controlled Publish โดยทุกสถานะยังยึด durable evidence เดิม
                </p>
              </div>

              {!selectedSourceWorkItemId ? (
                <EmptyState>คลิกช่วงตอนในตารางเพื่อเปิด Episode Pack Detail</EmptyState>
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
                          {editorTarget && editorTarget.findingId === finding.id && (
                            <div className="mt-2 space-y-2 rounded-md border bg-background p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="font-medium">{editorTarget.label}</div>
                                  <div className="text-xs text-muted-foreground">
                                    แก้ตรง finding นี้ · Draft v{editorTarget.draftVersion} · auto-save หลังหยุดพิมพ์ 3 วินาที
                                  </div>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={editEditorialDraft.isPending}
                                  onClick={() => {
                                    setEditorTarget(undefined);
                                    setEditorText("");
                                  }}
                                >
                                  ยกเลิก
                                </Button>
                              </div>
                              <textarea
                                className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
                                value={editorText}
                                maxLength={200000}
                                disabled={editEditorialDraft.isPending}
                                onChange={(event) => setEditorText(event.target.value)}
                                autoFocus
                              />
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                  {editorText.length.toLocaleString()} ตัวอักษร · บันทึกแล้วตรวจซ้ำอัตโนมัติ
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={
                                    editEditorialDraft.isPending ||
                                    editorText === editorTarget.expectedText
                                  }
                                  onClick={() => submitEditorEdit("manual")}
                                >
                                  {editEditorialDraft.isPending && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  )}
                                  บันทึกทันที + ตรวจซ้ำ
                                </Button>
                              </div>
                            </div>
                          )}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                editorialCheckerRunStale ||
                                !latestEditorialDraft ||
                                editEditorialDraft.isPending
                              }
                              onClick={() => {
                                if (!latestEditorialDraft) return;
                                setEditorTarget({
                                  kind: "replace_sentence",
                                  label: `แก้ประโยคที่พบ “${finding.token}”`,
                                  paragraphKey: finding.paragraphKey,
                                  expectedParagraphFingerprint:
                                    finding.paragraphFingerprint,
                                  startOffset: finding.sentenceStartOffset,
                                  endOffset: finding.sentenceEndOffset,
                                  expectedText: finding.sentenceText,
                                  draftId: latestEditorialDraft.id,
                                  draftVersion: latestEditorialDraft.version,
                                  draftSha256: latestEditorialDraft.draftSha256,
                                  findingId: finding.id,
                                  findingKey: finding.findingKey,
                                });
                                setEditorText(finding.sentenceText);
                              }}
                            >
                              แก้ประโยค
                            </Button>
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


                  {!!(editorialSourceDraft.data as any)?.tabs?.length && (
                    <details className="rounded-md border bg-muted/10">
                      <summary className="cursor-pointer list-none p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">
                            Draft structure · {draftStructureSummary.totalTabs} แท็บ
                          </div>
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
                        </div>
                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
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
                          {!draftStructureSummary.sequenceIssues.length &&
                            !draftStructureSummary.emptyTabs.length &&
                            !draftStructureSummary.unnumberedTabs.length &&
                            !draftStructureSummary.shortTabs.length && (
                              <div>โครงสร้างแท็บปกติ · กดเพื่อดูรายละเอียดทุกแท็บ</div>
                            )}
                        </div>
                      </summary>
                      <div className="space-y-2 border-t p-3">
                        {(editorialSourceDraft.data as any).tabs.map((tab: any) => (
                          <div key={tab.id} className="rounded-md border bg-background p-3 text-sm">
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
                    </details>
                  )}

                  <details className="rounded-md border">
                    <summary className="cursor-pointer list-none p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">Workspace Editor</div>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>Draft v{latestEditorialDraft?.version ?? "—"}</span>
                          <span>SHA {shortHash(latestEditorialDraft?.draftSha256)}</span>
                          <span>แก้ไข {editorialEditorData?.history?.length ?? 0}</span>
                        </div>
                      </div>
                    </summary>
                    <div className="space-y-3 border-t p-3">
                      <div className="flex justify-end">
                        <Button
                          type="button"
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
                      </div>

                    {editorTarget && !editorTarget.findingId && (
                      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">{editorTarget.label}</div>
                            <div className="text-xs text-muted-foreground">
                              {editorTarget.kind} · Draft v{editorTarget.draftVersion} · auto-save หลังหยุดพิมพ์ 3 วินาที
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={editEditorialDraft.isPending}
                            onClick={() => {
                              setEditorTarget(undefined);
                              setEditorText("");
                            }}
                          >
                            ยกเลิก
                          </Button>
                        </div>
                        <textarea
                          className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
                          value={editorText}
                          maxLength={200000}
                          disabled={editEditorialDraft.isPending}
                          onChange={(event) => setEditorText(event.target.value)}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>
                            {editorText.length.toLocaleString()} ตัวอักษร · ห้ามสร้างบรรทัดใหม่ใน mutation เดียว
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              editEditorialDraft.isPending ||
                              editorText === editorTarget.expectedText
                            }
                            onClick={() => submitEditorEdit("manual")}
                          >
                            {editEditorialDraft.isPending && (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            บันทึกทันที + ตรวจซ้ำ
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      {(editorialDraftData?.tabs ?? []).map((tab: any) => (
                        <details key={tab.id} className="rounded-md border">
                          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                            {tab.title} · {tab.paragraphs.length} paragraphs
                          </summary>
                          <div className="space-y-2 border-t p-3">
                            {tab.paragraphs.map((paragraph: any) => (
                              <div
                                key={paragraph.paragraphKey}
                                className="rounded border bg-background p-2 text-sm"
                              >
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="text-xs text-muted-foreground">
                                    ¶{paragraph.paragraphOrder} · {shortHash(paragraph.paragraphFingerprint)}
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={!latestEditorialDraft || editEditorialDraft.isPending}
                                    onClick={() => {
                                      if (!latestEditorialDraft) return;
                                      setEditorTarget({
                                        kind: "replace_paragraph",
                                        label: `แก้ย่อหน้า ¶${paragraph.paragraphOrder}`,
                                        paragraphKey: paragraph.paragraphKey,
                                        expectedParagraphFingerprint:
                                          paragraph.paragraphFingerprint,
                                        expectedText: paragraph.text,
                                        draftId: latestEditorialDraft.id,
                                        draftVersion: latestEditorialDraft.version,
                                        draftSha256: latestEditorialDraft.draftSha256,
                                      });
                                      setEditorText(paragraph.text);
                                    }}
                                  >
                                    แก้ย่อหน้า
                                  </Button>
                                </div>
                                <div className="whitespace-pre-wrap">{paragraph.text || "—"}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                  </details>

                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">Confirm + Episode Draft Staging</div>
                        <div className="text-xs text-muted-foreground">
                          การยืนยันผูกกับ Draft SHA256 + deterministic QC evidence แบบ exact; แก้ Draft หรือเปลี่ยน QC ภายหลังจะทำให้ approval เดิมใช้ต่อไม่ได้
                        </div>
                      </div>
                      <StatusPill
                        value={
                          editorialApprovalData?.readyToPublish
                            ? "ready_to_publish"
                            : editorialApprovalData?.approvalStatus?.valid
                              ? "approved"
                              : "pending_confirm"
                        }
                      />
                    </div>

                    <div className="grid gap-2 md:grid-cols-4">
                      <div className="rounded border p-2 text-sm">
                        Draft v{editorialApprovalData?.latestDraft?.version ?? "—"}
                        <div className="text-xs text-muted-foreground">
                          {shortHash(editorialApprovalData?.latestDraft?.draftSha256)}
                        </div>
                      </div>
                      <div className="rounded border p-2 text-sm">
                        QC {editorialApprovalData?.qc?.ready ? "clean" : "not ready"}
                        <div className="text-xs text-muted-foreground">
                          run #{editorialApprovalData?.qc?.checkerRunId ?? "—"} · open {editorialApprovalData?.qc?.unresolvedCount ?? "—"}
                        </div>
                      </div>
                      <div className="rounded border p-2 text-sm">
                        Approval {editorialApprovalData?.approvalStatus?.valid ? "valid" : "not current"}
                        <div className="text-xs text-muted-foreground">
                          {editorialApprovalData?.approval
                            ? `#${editorialApprovalData.approval.id} · ${shortHash(editorialApprovalData.approval.approvedDraftSha256)}`
                            : editorialApprovalData?.approvalStatus?.reason ?? "ยังไม่ยืนยัน"}
                        </div>
                      </div>
                      <div className="rounded border p-2 text-sm">
                        Episode stage {editorialApprovalData?.stageStatus?.valid ? "ready" : "not ready"}
                        <div className="text-xs text-muted-foreground">
                          {(editorialApprovalData?.stages?.length ?? 0) > 0
                            ? `${editorialApprovalData.stages.length} ตอน · unpublished ${editorialApprovalData.stageEpisodes?.filter((episode: any) => episode && !episode.isPublished).length ?? 0}`
                            : editorialApprovalData?.stageStatus?.reason ?? "ยังไม่ stage"}
                        </div>
                      </div>
                    </div>

                    {editorialApprovalData?.stagePlan ? (
                      <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">
                            {editorialApprovalData.stagePlan.ready
                              ? `พร้อม Stage ${editorialApprovalData.stagePlan.itemCount} ตอน`
                              : "Mapping ยังไม่พร้อม Stage"}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {editorialApprovalData.stagePlan.requestedEpisodeNumber} · Draft{" "}
                            {editorialApprovalData.stagePlan.draftTabCount ?? editorialApprovalData.stagePlan.itemCount} แท็บ · Episode{" "}
                            {editorialApprovalData.stagePlan.itemCount}/{editorialApprovalData.stagePlan.expectedCount}
                            {(editorialApprovalData.stagePlan.excludedCount ?? 0) > 0
                              ? ` · ไม่นับ ${editorialApprovalData.stagePlan.excludedCount} แท็บ`
                              : ""}
                          </span>
                        </div>

                        {(editorialApprovalData.stagePlan.excludedTabs?.length ?? 0) > 0 && (
                          <details className="rounded border bg-background">
                            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                              ไม่นับ {editorialApprovalData.stagePlan.excludedTabs.length} แท็บ
                            </summary>
                            <div className="space-y-1 border-t p-2 text-xs text-muted-foreground">
                              {editorialApprovalData.stagePlan.excludedTabs.map((tab: any) => (
                                <div key={tab.sourceTabId}>
                                  {tab.sourceTabTitle} — {tab.label}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}

                        {editorialApprovalData.stagePlan.anomalies?.length > 0 && (
                          <div className="space-y-1 text-xs">
                            {editorialApprovalData.stagePlan.anomalies.map(
                              (anomaly: any, index: number) => (
                                <div
                                  key={`${anomaly.code}:${anomaly.episodeNumber ?? anomaly.sourceTabId ?? index}`}
                                  className={
                                    anomaly.severity === "blocker"
                                      ? "font-medium text-destructive"
                                      : "text-muted-foreground"
                                  }
                                >
                                  {anomaly.severity === "blocker" ? "Blocker" : "Warning"} ·{" "}
                                  {anomaly.message}
                                </div>
                              )
                            )}
                          </div>
                        )}

                        {editorialApprovalData.stagePlan.items?.length > 0 && (
                          <details className="rounded border bg-background">
                            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                              Mapping {editorialApprovalData.stagePlan.items.length} ตอน
                            </summary>
                            <div className="max-h-72 space-y-1 overflow-auto border-t p-2 text-xs">
                              {editorialApprovalData.stagePlan.items.map((item: any) => (
                                <div
                                  key={item.sourceTabId}
                                  className="flex flex-wrap justify-between gap-2 rounded px-2 py-1"
                                >
                                  <span>
                                    {item.episodeNumber} → {item.sourceTabTitle}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {item.wordCount} words · {shortHash(item.contentSha256)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                        {editorialApprovalData?.stagePlanError ??
                          "ยังไม่สามารถสร้าง Episode staging plan ได้"}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={
                          !editorialApprovalData?.latestDraft ||
                          !editorialApprovalData?.qc?.ready ||
                          !editorialApprovalData?.qc?.checkerRunId ||
                          !editorialApprovalData?.qc?.qcEvidenceSha256 ||
                          editorialApprovalData?.approvalStatus?.valid ||
                          approveEditorialDraft.isPending
                        }
                        onClick={() => {
                          const draft = editorialApprovalData?.latestDraft;
                          const qc = editorialApprovalData?.qc;
                          if (!draft || !qc?.checkerRunId || !qc?.qcEvidenceSha256) return;
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
                        }}
                      >
                        {approveEditorialDraft.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        ยืนยัน Draft ปัจจุบัน
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !editorialApprovalData?.approvalStatus?.valid ||
                          !editorialApprovalData?.approval?.id ||
                          !editorialApprovalData?.stagePlan?.ready ||
                          editorialApprovalData?.stageStatus?.valid ||
                          stageEditorialEpisode.isPending
                        }
                        onClick={() => {
                          const draft = editorialApprovalData?.latestDraft;
                          const approval = editorialApprovalData?.approval;
                          if (!draft || !approval?.id) return;
                          stageEditorialEpisode.mutate({
                            workspaceId: selectedWorkspaceId,
                            workItemId: selectedSourceWorkItemId,
                            approvalId: approval.id,
                            expectedDraftId: draft.id,
                            expectedDraftVersion: draft.version,
                            expectedDraftSha256: draft.draftSha256,
                            idempotencyKey: `editorial-stage:${approval.id}:${draft.id}:${draft.draftSha256.slice(0, 16)}`,
                          });
                        }}
                      >
                        {stageEditorialEpisode.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        {(editorialApprovalData?.stagePlan?.itemCount ?? 1) > 1
                          ? `Stage ${editorialApprovalData.stagePlan.itemCount} Episode Drafts`
                          : "Stage Episode Draft"}
                      </Button>
                    </div>

                    {editorialApprovalData?.readyToPublish && (
                      <div className="space-y-2 rounded-md border p-3 text-sm">
                        <div>
                          พร้อม Controlled Publish{" "}
                          <strong>{editorialApprovalData.stages?.length ?? 1} ตอน</strong> · unpublished ครบ · Draft SHA{" "}
                          {shortHash(editorialApprovalData.stage?.stagedDraftSha256)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          publish owner {(editorialPublish.data as any)?.ownership?.owner ?? "—"} · epoch {(editorialPublish.data as any)?.ownership?.cutoverEpoch ?? "—"} · run #{(editorialPublish.data as any)?.publishRun?.id ?? "ยังไม่สร้าง"} · {(editorialPublish.data as any)?.blocker ?? "พร้อม enqueue"}
                        </div>
                        {(editorialPublish.data as any)?.blocker === "PUBLISH_OWNERSHIP_CONFLICT" && (editorialPublish.data as any)?.ownership?.owner === "sheets" && (editorialPublish.data as any)?.ownership?.cutoverEpoch === 0 && (
                          <Button type="button" variant="outline" disabled={prepareEditorialPublishOwnership.isPending} onClick={() => prepareEditorialPublishOwnership.mutate({ workspaceId: selectedWorkspaceId, workItemId: selectedSourceWorkItemId })}>
                            {prepareEditorialPublishOwnership.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Prepare Publish Ownership
                          </Button>
                        )}
                        <Button
                          type="button"
                          disabled={
                            !(editorialPublish.data as any)?.requestReady ||
                            requestEditorialPublish.isPending
                          }
                          onClick={() => {
                            const publish = editorialPublish.data as any;
                            if (!publish?.stage?.id || !publish?.ownership) return;
                            requestEditorialPublish.mutate({
                              workspaceId: selectedWorkspaceId,
                              workItemId: selectedSourceWorkItemId,
                              expectedStageSetSha256: publish.stageSetSha256,
                              expectedStagedDraftSha256: publish.stage.stagedDraftSha256,
                              expectedCutoverEpoch: publish.ownership.cutoverEpoch,
                              expectedOwnershipVersion: publish.ownership.version,
                            });
                          }}
                        >
                          {requestEditorialPublish.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Publish (Controlled)
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </Card>

            <details className="rounded-lg border bg-background">
              <summary className="cursor-pointer select-none px-5 py-4">
                <span className="font-semibold">Operations / Advanced</span>
                <span className="ml-2 text-xs text-muted-foreground">fingerprints · Checker/AI jobs · source bindings · publish runs/outbox · ownership evidence</span>
              </summary>
              <div className="space-y-5 border-t p-5">
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
            </details>
          </div>
        ) : null}
      </section>
    </main>
  );
}
