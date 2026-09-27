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
  chapterEditorFindingRanges,
  chapterEditorIssues,
  chapterEditorMatchesFilter,
  chapterEditorStructuralRepairGuidance,
  chapterEditorTabStatus,
  parseChapterEditorPasteText,
  serializeChapterEditorParagraphs,
} from "./workspaceChapterEditor";
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

function groupBulkCheckerParagraphs(findings: any[]) {
  const groups = new Map<string, any>();
  for (const finding of findings ?? []) {
    const key = `${finding.paragraphKey}:${finding.paragraphFingerprint}`;
    const current = groups.get(key);
    if (current) {
      current.findings.push(finding);
    } else {
      groups.set(key, {
        paragraphKey: finding.paragraphKey,
        paragraphFingerprint: finding.paragraphFingerprint,
        paragraphOrder: finding.paragraphOrder,
        contextText: finding.contextText,
        findings: [finding],
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => Number(a.paragraphOrder ?? 0) - Number(b.paragraphOrder ?? 0));
}

function parseEpisodeRangeFromFileName(fileName: string) {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const match = base.match(/^(\d{1,6})(?:\s*[-–—]\s*(\d{1,6}))?(?:\s+|[_-]+)?(.*)$/);
  if (!match) return { episodeNumber: "", episodeTitle: base };
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    return { episodeNumber: "", episodeTitle: base };
  }
  const episodeNumber = match[2] ? `${match[1]} - ${match[2]}` : match[1];
  return { episodeNumber, episodeTitle: String(match[3] ?? "").replace(/[_-]+/g, " ").trim() };
}

function StatusPill({ value }: { value: unknown }) {
  return (
    <span className="inline-flex rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
      {String(value ?? "unknown")}
    </span>
  );
}

function formatCompactNumberRanges(values: number[]) {
  const numbers = Array.from(
    new Set(values.filter(value => Number.isInteger(value)))
  ).sort((a, b) => a - b);
  if (!numbers.length) return "";
  const ranges: string[] = [];
  let start = numbers[0]!;
  let previous = start;
  for (const value of numbers.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(", ");
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{children}</p>;
}

function editorialTabText(tab: any) {
  return (tab?.paragraphs ?? []).map((paragraph: any) => String(paragraph.text ?? "")).join("\n\n");
}

type ChapterEditorParagraphState = {
  id: string;
  paragraphKey?: string;
  text: string;
};

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

function ChapterEditorParagraphBlock({
  paragraphId,
  value,
  findings,
  highlight,
  disabled,
  placeholder,
  onChange,
  onSplit,
  onMergePrevious,
  onPasteParagraphs,
}: {
  paragraphId: string;
  value: string;
  findings: any[];
  highlight: boolean;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onSplit: (start: number, end: number) => void;
  onMergePrevious: () => void;
  onPasteParagraphs: (paragraphs: string[], start: number, end: number) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ranges = useMemo(
    () => (highlight ? chapterEditorFindingRanges(value, findings) : []),
    [highlight, value, findings]
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

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(40, textarea.scrollHeight)}px`;
  }, [value]);

  return (
    <div className="relative">
      <pre
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-1 py-1 font-sans text-base leading-8 text-transparent"
      >
        {parts}
        {"\n"}
      </pre>
      <textarea
        ref={textareaRef}
        id={`chapter-editor-paragraph-${paragraphId}`}
        aria-label="Chapter editor paragraph"
        rows={1}
        spellCheck={false}
        className="relative z-10 block w-full resize-none overflow-hidden bg-transparent px-1 py-1 font-sans text-base leading-8 outline-none focus:bg-muted/20"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSplit(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
            return;
          }
          if (
            event.key === "Backspace" &&
            event.currentTarget.selectionStart === 0 &&
            event.currentTarget.selectionEnd === 0
          ) {
            onMergePrevious();
          }
        }}
        onPaste={event => {
          const paragraphs = chapterEditorClipboardParagraphs(event.clipboardData);
          if (!paragraphs.length) return;
          event.preventDefault();
          onPasteParagraphs(
            paragraphs,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd
          );
        }}
      />
    </div>
  );
}


export default function WorkspacePage() {
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number>();
  const [novelId, setNovelId] = useState("");
  const [existingNovelSearch, setExistingNovelSearch] = useState("");
  const [newNovelTitle, setNewNovelTitle] = useState("");
  const [episodeWorkspaceNovelId, setEpisodeWorkspaceNovelId] = useState("");
  const [episodeNumber, setEpisodeNumber] = useState("");
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [episodePrice, setEpisodePrice] = useState("");
  const [episodeFreeState, setEpisodeFreeState] = useState<"" | "free" | "paid">("");
  const [episodeAssigneeUserId, setEpisodeAssigneeUserId] = useState("");
  const [editorialTypeFilter, setEditorialTypeFilter] = useState("all");
  const [editorialAssigneeFilter, setEditorialAssigneeFilter] = useState("all");
  const [editorialColumnFilter, setEditorialColumnFilter] = useState("all");
  const [editorialSearch, setEditorialSearch] = useState("");
  const [editorialQuickFilter, setEditorialQuickFilter] = useState("all");
  const [editorialView, setEditorialView] = useState<"table" | "kanban">("table");
  const [episodeNovelSearch, setEpisodeNovelSearch] = useState("");
  const [selectedSourceWorkItemId, setSelectedSourceWorkItemId] = useState<number>();
  const [selectedEditorialWorkItemIds, setSelectedEditorialWorkItemIds] = useState<number[]>([]);
  const [bulkCheckerSummary, setBulkCheckerSummary] = useState<Array<any>>([]);
  const [bulkCleanupPreviewResult, setBulkCleanupPreviewResult] = useState<any>();
  const [bulkEditorTarget, setBulkEditorTarget] = useState<{
    workItemId: number;
    paragraphKey: string;
    paragraphFingerprint: string;
    expectedText: string;
    draftId: number;
    draftVersion: number;
    draftSha256: string;
    findingId: number;
    findingKey: string;
  }>();
  const [bulkEditorText, setBulkEditorText] = useState("");
  const [googleConnectionId, setGoogleConnectionId] = useState("");
  const [masterIntakeStartRow, setMasterIntakeStartRow] = useState("");
  const [masterIntakeEndRow, setMasterIntakeEndRow] = useState("");
  const [masterIntakePreviewResult, setMasterIntakePreviewResult] = useState<any>();
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [episodeGoogleDocUrl, setEpisodeGoogleDocUrl] = useState("");
  const [episodeIntakeMode, setEpisodeIntakeMode] = useState<"single" | "bulk_docs" | "bulk_files">("bulk_docs");
  const [episodeGoogleBatchRows, setEpisodeGoogleBatchRows] = useState<Array<{
    episodeNumber: string;
    episodeTitle: string;
    documentUrlOrId: string;
  }>>([
    { episodeNumber: "", episodeTitle: "", documentUrlOrId: "" },
    { episodeNumber: "", episodeTitle: "", documentUrlOrId: "" },
  ]);
  const [episodeBatchFiles, setEpisodeBatchFiles] = useState<Array<{
    name: string;
    mimeType: string;
    paragraphs: string[];
    episodeNumber: string;
    episodeTitle: string;
  }>>([]);
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
  const [chapterEditorIssueIndex, setChapterEditorIssueIndex] = useState(0);
  const [chapterEditorTabFilter, setChapterEditorTabFilter] = useState<
    "all" | "issue" | "unedited" | "edited"
  >("all");
  const chapterEditorScrollByTab = useRef(new Map<string, number>());
  const chapterEditorText = useMemo(
    () => serializeChapterEditorParagraphs(chapterEditorParagraphs.map(paragraph => paragraph.text)),
    [chapterEditorParagraphs]
  );
  const chapterEditorDirty = Boolean(
    chapterEditorTarget && chapterEditorText !== chapterEditorTarget.expectedText
  );
  const [chapterEditorHighlight, setChapterEditorHighlight] = useState(true);
  const [selectedCheckerRunId, setSelectedCheckerRunId] = useState<number>();
  const [selectedAiJobId, setSelectedAiJobId] = useState<number>();
  const [selectedPublishRunId, setSelectedPublishRunId] = useState<number>();
  const [checkerSnapshotId, setCheckerSnapshotId] = useState("");
  const [checkerRuleSetId, setCheckerRuleSetId] = useState("");
  const [aiSnapshotId, setAiSnapshotId] = useState("");
  const ensuredEditorialWorkspaces = useRef(new Set<number>());
  const { isAdmin, loading: adminLoading } = useAdminGuard();

  useEffect(() => {
    setBulkCleanupPreviewResult(undefined);
  }, [selectedWorkspaceId, selectedEditorialWorkItemIds.join(",")]);

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
  const bulkCleanupPreviewQuery = trpc.workspace.editorial.bulkFindingCleanupPreview.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      workItemIds: selectedEditorialWorkItemIds,
    },
    { enabled: false, retry: false }
  );
  const editorialGoogleConnections = trpc.workspace.editorial.googleConnections.useQuery(
    undefined,
    { enabled: isAdmin }
  );
  const masterIntakeHistory = trpc.workspace.editorial.masterIntakeHistory.useQuery(
    { workspaceId: selectedWorkspaceId ?? 0, limit: 10 },
    { enabled: isAdmin && Boolean(selectedWorkspaceId), retry: false }
  );
  const masterIntakePreviewQuery = trpc.workspace.editorial.masterIntakePreview.useQuery(
    {
      workspaceId: selectedWorkspaceId ?? 0,
      googleConnectionId: Number(googleConnectionId) || 0,
      startRow: Number(masterIntakeStartRow) || 0,
      endRow: Number(masterIntakeEndRow || masterIntakeStartRow) || 0,
    },
    { enabled: false, retry: false }
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
    setEpisodePrice("");
    setEpisodeFreeState("");
    setEpisodeAssigneeUserId("");
    setEditorialTypeFilter("all");
    setEditorialAssigneeFilter("all");
    setEditorialColumnFilter("all");
    setSelectedSourceWorkItemId(undefined);
    setBulkCheckerSummary([]);
    setGoogleConnectionId("");
    setMasterIntakeStartRow("");
    setMasterIntakeEndRow("");
    setMasterIntakePreviewResult(undefined);
    setGoogleDocUrl("");
    setUploadedSource(undefined);
    setEditorTarget(undefined);
    setEditorText("");
    setChapterEditorTarget(undefined);
    setChapterEditorParagraphs([]);
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
  const refreshBulkEditorial = async () => {
    await Promise.all([editorialBoard.refetch(), editorialEvidenceStatuses.refetch(), editorialApproval.refetch(), editorialPublish.refetch(), publishOverview.refetch()]);
  };
  const bulkApproveEditorialDrafts = trpc.workspace.editorial.bulkApproveDrafts.useMutation({
    onSuccess: async (results) => {
      await refreshBulkEditorial();
      const failed = results.filter((result) => !result.ok);
      const firstError = failed.find((result: any) => result.error)?.error;
      toast[failed.length ? "error" : "success"](
        `ยืนยัน ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่ผ่าน ${failed.length}${firstError ? ` · ${firstError}` : ""}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkStageEditorialDrafts = trpc.workspace.editorial.bulkStageDrafts.useMutation({
    onSuccess: async (results) => { await refreshBulkEditorial(); const failed = results.filter((result) => !result.ok); toast[failed.length ? "error" : "success"](`Stage ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่ผ่าน ${failed.length}` : ""}`); },
    onError: (error) => toast.error(error.message),
  });
  const bulkRunEditorialChecker = trpc.workspace.editorial.bulkRunChecker.useMutation({
    onMutate: () => {
      setBulkCheckerSummary([]);
      setBulkEditorTarget(undefined);
      setBulkEditorText("");
    },
    onSuccess: async (results) => {
      setBulkCheckerSummary(results as any[]);
      await refreshBulkEditorial();
      const technicalFailed = results.filter((result) => !result.ok);
      const needsFix = results.filter((result: any) => result.ok && result.effectiveStatus === "failed");
      toast[technicalFailed.length || needsFix.length ? "error" : "success"](
        `ตรวจ ${results.length} ตอน · ผ่าน ${results.length - technicalFailed.length - needsFix.length} · ต้องแก้ ${needsFix.length}${technicalFailed.length ? ` · ผิดพลาด ${technicalFailed.length}` : ""}`
      );
    },
    onError: (error) => {
      setBulkCheckerSummary([]);
      toast.error(error.message);
    },
  });
  const refreshBulkAfterCleanup = trpc.workspace.editorial.bulkRunChecker.useMutation({
    onSuccess: async (results) => {
      setBulkCheckerSummary(results as any[]);
      await refreshBulkEditorial();
    },
  });
  const bulkCleanupApply = trpc.workspace.editorial.bulkFindingCleanupApply.useMutation({
    onSuccess: async (result, variables) => {
      setBulkCleanupPreviewResult(undefined);
      const failed = result.results.filter((row: any) => !row.ok);
      toast[failed.length ? "error" : "success"](
        `ลบพร้อมกันแล้ว ${result.summary.removedFindings} จุด · ${result.summary.changed} Episode Pack${failed.length ? ` · ผิดพลาด ${failed.length}` : ""}`
      );
      try {
        const refreshed = await refreshBulkAfterCleanup.mutateAsync({
          workspaceId: variables.workspaceId,
          workItemIds: variables.workItemIds,
        });
        setBulkCheckerSummary(refreshed as any[]);
      } catch (error) {
        await refreshBulkEditorial();
        toast.error(
          `ลบสำเร็จ แต่โหลดผลตรวจล่าสุดไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const rerunBulkEditedChecker = trpc.workspace.editorial.foreignCheckerRun.useMutation();
  const rerunBulkAfterAllow = trpc.workspace.editorial.bulkRunChecker.useMutation();
  const bulkAllowEditorialFinding = trpc.workspace.editorial.foreignCheckerAllow.useMutation({
    onSuccess: async (result, variables) => {
      const workItemIds = bulkCheckerSummary
        .map((item: any) => Number(item.workItemId))
        .filter((workItemId) => Number.isInteger(workItemId) && workItemId > 0);
      try {
        if (workItemIds.length) {
          const rerun = await rerunBulkAfterAllow.mutateAsync({
            workspaceId: variables.workspaceId,
            workItemIds,
          });
          setBulkCheckerSummary(rerun as any[]);
        }
        await refreshBulkEditorial();
        toast.success(`ยกเว้นคำ “${result.normalizedWord}” แล้ว · ตรวจซ้ำ ${workItemIds.length} ตอน`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await refreshBulkEditorial();
        toast.error(`ยกเว้นคำแล้ว แต่ตรวจซ้ำไม่สำเร็จ: ${message}`);
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkEditEditorialFinding = trpc.workspace.editorial.editorEdit.useMutation({
    onSuccess: async (result, variables) => {
      setBulkEditorTarget(undefined);
      setBulkEditorText("");
      if (!result.draft?.id || result.isCurrent === false) {
        setBulkCheckerSummary((current) => current.map((item: any) =>
          item.workItemId === variables.workItemId
            ? { ...item, ok: false, error: "บันทึกแล้ว แต่ Draft ปัจจุบันเปลี่ยนก่อนตรวจซ้ำ" }
            : item
        ));
        await refreshBulkEditorial();
        toast.error("บันทึกแล้ว แต่ Draft ปัจจุบันเปลี่ยนก่อนตรวจซ้ำ");
        return;
      }
      try {
        const checker = await rerunBulkEditedChecker.mutateAsync({
          workspaceId: variables.workspaceId,
          workItemId: variables.workItemId,
          expectedDraftId: result.draft.id,
        });
        const openFindings = (checker.findings ?? [])
          .filter((finding: any) => finding.disposition === "open")
          .map((finding: any) => ({
            id: finding.id,
            findingKey: finding.findingKey,
            ruleKey: finding.ruleKey,
            token: finding.token,
            paragraphKey: finding.paragraphKey,
            paragraphFingerprint: finding.paragraphFingerprint,
            paragraphOrder: finding.paragraphOrder,
            sentenceText: finding.sentenceText,
            contextText: finding.contextText,
            resolutionVersion: finding.resolutionVersion ?? 0,
          }));
        setBulkCheckerSummary((current) => current.map((item: any) =>
          item.workItemId === variables.workItemId
            ? {
                workItemId: variables.workItemId,
                ok: true,
                runId: checker.run?.id ?? null,
                effectiveStatus: checker.effectiveStatus,
                findingCount: checker.findings?.length ?? 0,
                unresolvedCount: checker.unresolvedCount ?? 0,
                latestDraft: checker.latestDraft
                  ? {
                      id: checker.latestDraft.id,
                      version: checker.latestDraft.version,
                      draftSha256: checker.latestDraft.draftSha256,
                    }
                  : null,
                openFindings,
                sampleFindings: openFindings.slice(0, 5).map((finding: any) => ({ token: finding.token, ruleKey: finding.ruleKey })),
              }
            : item
        ));
        await refreshBulkEditorial();
        toast.success(checker.unresolvedCount ? `บันทึกแล้ว · ยังเหลือ ${checker.unresolvedCount} จุด` : "บันทึกแล้ว · ผ่านการตรวจ");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBulkCheckerSummary((current) => current.map((item: any) =>
          item.workItemId === variables.workItemId
            ? { ...item, ok: false, error: `บันทึกแล้ว แต่ตรวจซ้ำไม่สำเร็จ: ${message}` }
            : item
        ));
        await refreshBulkEditorial();
        toast.error(`บันทึกแล้ว แต่ตรวจซ้ำไม่สำเร็จ: ${message}`);
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkRequestEditorialPublish = trpc.workspace.editorial.bulkRequestPublish.useMutation({
    onSuccess: async (results) => {
      await refreshBulkEditorial();
      const failed = results.filter((result) => !result.ok);
      const firstError = failed.find((result: any) => result.error)?.error;
      toast[failed.length ? "error" : "success"](
        `ส่งเผยแพร่ ${results.length - failed.length}/${results.length} ตอน${failed.length ? ` · ไม่พร้อม ${failed.length}${firstError ? ` · ${firstError}` : ""}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
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
  const removeWorkspaceNovel = trpc.workspace.bindings.removePublicationNovel.useMutation({
    onSuccess: async () => {
      setEpisodeWorkspaceNovelId("");
      setSelectedSourceWorkItemId(undefined);
      await Promise.all([detail.refetch(), availableNovels.refetch(), editorialBoard.refetch()]);
      toast.success("นำเรื่องออกจาก Workspace แล้ว — ตัวนิยายต้นฉบับยังอยู่");
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteWorkspace = trpc.workspace.delete.useMutation({
    onSuccess: async () => {
      setSelectedWorkspaceId(undefined);
      setSelectedSourceWorkItemId(undefined);
      await workspaces.refetch();
      toast.success("ลบ Workspace แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const masterIntakeSync = trpc.workspace.editorial.masterIntakeSync.useMutation({
    onSuccess: async (result) => {
      setMasterIntakePreviewResult(undefined);
      const firstSuccess = result.results.find((row: any) => row.ok && row.workItemId);
      if (firstSuccess?.workItemId) setSelectedSourceWorkItemId(firstSuccess.workItemId);
      await Promise.all([
        detail.refetch(),
        bindings.refetch(),
        ownership.refetch(),
        availableNovels.refetch(),
        editorialBoard.refetch(),
        masterIntakeHistory.refetch(),
      ]);
      toast[result.summary.failed ? "error" : "success"](
        `Sync สำเร็จ ${result.summary.succeeded}/${result.summary.attempted} แถว${result.summary.failed ? ` · มีปัญหา ${result.summary.failed} แถว` : ""}`
      );
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
  const updateEditorialEpisode = trpc.workspace.editorial.updateEpisode.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
      toast.success("แก้ไข Episode Pack แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const updateEditorialEpisodeSale = trpc.workspace.editorial.updateEpisodeSale.useMutation({
    onSuccess: async () => {
      await editorialBoard.refetch();
      toast.success("อัปเดตการขายของ Episode Pack แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const removeEditorialEpisode = trpc.workspace.editorial.removeEpisode.useMutation({
    onSuccess: async (_result, variables) => {
      if (selectedSourceWorkItemId === variables.workItemId) setSelectedSourceWorkItemId(undefined);
      await editorialBoard.refetch();
      toast.success("นำ Episode Pack ออกจาก Workspace แล้ว");
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkImportGoogleDocs = trpc.workspace.editorial.bulkImportGoogleDocs.useMutation({
    onSuccess: async (results, variables) => {
      await Promise.all([editorialBoard.refetch(), editorialEvidenceStatuses.refetch()]);
      const failed = results.filter((result) => !result.ok);
      const firstSuccess = results.find((result) => result.ok && result.workItemId);
      if (firstSuccess?.workItemId) setSelectedSourceWorkItemId(firstSuccess.workItemId);
      if (!failed.length) {
        setEpisodeGoogleBatchRows([
          { episodeNumber: "", episodeTitle: "", documentUrlOrId: "" },
          { episodeNumber: "", episodeTitle: "", documentUrlOrId: "" },
        ]);
        setEpisodePrice("");
        setEpisodeFreeState("");
      } else {
        const failedIndexes = new Set(failed.map((result) => result.rowIndex));
        setEpisodeGoogleBatchRows(
          variables.rows
            .filter((_row, index) => failedIndexes.has(index))
            .map((row) => ({ ...row, episodeTitle: row.episodeTitle ?? "" }))
        );
      }
      const firstError = failed[0]?.error;
      toast[failed.length ? "error" : "success"](
        failed.length
          ? `นำเข้า Google Docs สำเร็จ ${results.length - failed.length}/${results.length} แพ็ก · ${firstError ?? `ไม่ผ่าน ${failed.length}`}`
          : `นำเข้า Google Docs ${results.length} แพ็กแล้ว`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkImportEpisodeFiles = trpc.workspace.editorial.bulkImportEpisodeFiles.useMutation({
    onSuccess: async (results) => {
      await Promise.all([editorialBoard.refetch(), editorialEvidenceStatuses.refetch()]);
      const failed = results.filter((result) => !result.ok);
      const firstSuccess = results.find((result) => result.ok && result.workItemId);
      if (firstSuccess?.workItemId) setSelectedSourceWorkItemId(firstSuccess.workItemId);
      if (!failed.length) {
        setEpisodeBatchFiles([]);
        setEpisodeNumber("");
        setEpisodeTitle("");
        setEpisodePrice("");
        setEpisodeFreeState("");
        setEpisodeGoogleDocUrl("");
      }
      toast[failed.length ? "error" : "success"](
        `นำเข้าไฟล์ ${results.length - failed.length}/${results.length} แพ็ก${failed.length ? ` · ไม่ผ่าน ${failed.length}` : ""}`
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const createEditorialEpisode = trpc.workspace.editorial.createEpisode.useMutation({
    onSuccess: async (result, variables) => {
      const quickDocUrl = episodeGoogleDocUrl.trim();
      let quickImportSucceeded = false;
      setEpisodeNumber("");
      setEpisodeTitle("");
      setEpisodePrice("");
      setEpisodeFreeState("");
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
    onSuccess: async (result, variables) => {
      const savedChapterTarget =
        variables.command.kind === "replace_tab" ? chapterEditorTarget : undefined;
      setEditorTarget(undefined);
      setEditorText("");
      if (!savedChapterTarget) {
        setChapterEditorTarget(undefined);
        setChapterEditorParagraphs([]);
      }
      const [sourceDraftResult] = await Promise.all([
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
          : "บันทึก Draft เวอร์ชันใหม่และตรวจซ้ำแล้ว"
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const refreshAfterTabRevision = async () => {
    await Promise.all([
      editorialSourceDraft.refetch(), editorialEditor.refetch(), editorialForeignChecker.refetch(),
      editorialApproval.refetch(), editorialBoard.refetch(),
    ]);
  };
  const excludeEditorialTab = trpc.workspace.editorial.editorExcludeTab.useMutation({
    onSuccess: async () => { await refreshAfterTabRevision(); toast.success("นำแท็บออกจาก Draft แล้ว — กรุณารัน Checker และ Confirm ใหม่"); },
    onError: (error) => toast.error(error.message),
  });
  const restoreEditorialTab = trpc.workspace.editorial.editorRestoreTab.useMutation({
    onSuccess: async () => { await refreshAfterTabRevision(); toast.success("คืนแท็บเข้า Draft แล้ว — กรุณารัน Checker และ Confirm ใหม่"); },
    onError: (error) => toast.error(error.message),
  });
  const undoEditorialEdit = trpc.workspace.editorial.editorUndo.useMutation({
    onSuccess: async (result) => {
      setEditorTarget(undefined);
      setEditorText("");
      setChapterEditorTarget(undefined);
      setChapterEditorParagraphs([]);
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
  const setStructuralConfirmation = trpc.workspace.editorial.structuralConfirmation.useMutation({
    onSuccess: async () => {
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

  const submitChapterEditorEdit = () => {
    if (
      !selectedWorkspaceId ||
      !selectedSourceWorkItemId ||
      !chapterEditorTarget ||
      editEditorialDraft.isPending ||
      chapterEditorText === chapterEditorTarget.expectedText
    ) {
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
        replacementText: chapterEditorText,
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
  const selectableEditorialWorkItemIds = editorialCards.map((card: any) => card.workItemId).filter((id: any): id is number => Number.isInteger(id));
  const selectedEditorialSet = new Set(selectedEditorialWorkItemIds);
  const allEditorialSelected = selectableEditorialWorkItemIds.length > 0 && selectableEditorialWorkItemIds.every((id) => selectedEditorialSet.has(id));
  const toggleEditorialSelection = (workItemId: number) => setSelectedEditorialWorkItemIds((current) => current.includes(workItemId) ? current.filter((id) => id !== workItemId) : [...current, workItemId]);
  const editorialDraftData = editorialSourceDraft.data as any;
  const latestEditorialDraft = editorialDraftData?.latestDraft;
  const editorialEditorData = editorialEditor.data as any;
  const editorialApprovalData = editorialApproval.data as any;
  const editorialCheckerData = editorialForeignChecker.data as any;
  const editorialCheckerRunStale = Boolean(
    editorialCheckerData?.run &&
      (
        editorialCheckerData?.isCurrent === false ||
        !editorialCheckerData?.latestDraft ||
        editorialCheckerData.run.draftId !== editorialCheckerData.latestDraft.id ||
        editorialCheckerData.run.engineVersion !== editorialCheckerData.engineVersion
      )
  );
  const chapterEditorTabs = (editorialDraftData?.tabs ?? []) as any[];
  const editorialCheckerCurrent = Boolean(
    editorialCheckerData?.run &&
      !editorialCheckerRunStale &&
      editorialCheckerData?.isCurrent !== false
  );
  const currentCheckerFindings = editorialCheckerCurrent
    ? ((editorialCheckerData?.findings ?? []) as any[])
    : [];
  const currentCheckerAnomalies = editorialCheckerCurrent
    ? ((editorialCheckerData?.anomalies ?? []) as any[])
    : [];
  const chapterEditorStatusByTab = new Map(
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
  const filteredChapterEditorTabs = chapterEditorTabs.filter((tab: any) => {
    const status = chapterEditorStatusByTab.get(tab.sourceTabId);
    return status
      ? chapterEditorMatchesFilter(chapterEditorTabFilter, status)
      : chapterEditorTabFilter === "all";
  });
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
  const focusChapterEditorParagraph = (paragraphId: string, offset: number) => {
    window.requestAnimationFrame(() => {
      const textarea = document.getElementById(
        `chapter-editor-paragraph-${paragraphId}`
      ) as HTMLTextAreaElement | null;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
    });
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
        id: String(paragraph.paragraphKey ?? `source-${tab.sourceTabId}-${index}`),
        paragraphKey: paragraph.paragraphKey ? String(paragraph.paragraphKey) : undefined,
        text: String(paragraph.text ?? ""),
      })
    );
    if (!paragraphs.length) {
      paragraphs.push({ id: nextChapterEditorParagraphId(), text: "" });
    }
    setEditorTarget(undefined);
    setEditorText("");
    setChapterEditorIssueIndex(0);
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
    setChapterEditorTarget(undefined);
    setChapterEditorParagraphs([]);
  };
  const updateChapterEditorParagraph = (index: number, text: string) => {
    setChapterEditorParagraphs(current =>
      current.map((paragraph, paragraphIndex) =>
        paragraphIndex === index ? { ...paragraph, text } : paragraph
      )
    );
  };
  const splitChapterEditorParagraph = (index: number, start: number, end: number) => {
    const paragraph = chapterEditorParagraphs[index];
    if (!paragraph) return;
    const nextId = nextChapterEditorParagraphId();
    setChapterEditorParagraphs([
      ...chapterEditorParagraphs.slice(0, index),
      { ...paragraph, text: paragraph.text.slice(0, start) },
      { id: nextId, text: paragraph.text.slice(end) },
      ...chapterEditorParagraphs.slice(index + 1),
    ]);
    focusChapterEditorParagraph(nextId, 0);
  };
  const mergeChapterEditorParagraphWithPrevious = (index: number) => {
    if (index <= 0) return;
    const previous = chapterEditorParagraphs[index - 1];
    const paragraph = chapterEditorParagraphs[index];
    if (!previous || !paragraph) return;
    const previousLength = previous.text.length;
    setChapterEditorParagraphs([
      ...chapterEditorParagraphs.slice(0, index - 1),
      { ...previous, text: `${previous.text}${paragraph.text}` },
      ...chapterEditorParagraphs.slice(index + 1),
    ]);
    focusChapterEditorParagraph(previous.id, previousLength);
  };
  const pasteChapterEditorParagraphs = (
    index: number,
    paragraphs: string[],
    start: number,
    end: number
  ) => {
    const target = chapterEditorParagraphs[index];
    if (!target || !paragraphs.length) return;
    const before = target.text.slice(0, start);
    const after = target.text.slice(end);
    if (paragraphs.length === 1) {
      setChapterEditorParagraphs(
        chapterEditorParagraphs.map((paragraph, paragraphIndex) =>
          paragraphIndex === index
            ? { ...paragraph, text: `${before}${paragraphs[0]}${after}` }
            : paragraph
        )
      );
      focusChapterEditorParagraph(target.id, before.length + paragraphs[0]!.length);
      return;
    }
    const inserted: ChapterEditorParagraphState[] = [
      { ...target, text: `${before}${paragraphs[0]}` },
      ...paragraphs.slice(1).map((text, paragraphIndex) => ({
        id: nextChapterEditorParagraphId(),
        text:
          paragraphIndex === paragraphs.length - 2
            ? `${text}${after}`
            : text,
      })),
    ];
    setChapterEditorParagraphs([
      ...chapterEditorParagraphs.slice(0, index),
      ...inserted,
      ...chapterEditorParagraphs.slice(index + 1),
    ]);
    const lastInserted = inserted[inserted.length - 1]!;
    focusChapterEditorParagraph(
      lastInserted.id,
      paragraphs[paragraphs.length - 1]!.length
    );
  };
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
  const chapterEditorFindingsByParagraphKey = new Map<string, any[]>();
  for (const finding of chapterEditorFindings) {
    const paragraphKey = String(finding.paragraphKey ?? "");
    if (!paragraphKey) continue;
    const bucket = chapterEditorFindingsByParagraphKey.get(paragraphKey) ?? [];
    bucket.push(finding);
    chapterEditorFindingsByParagraphKey.set(paragraphKey, bucket);
  }
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
      const paragraph = chapterEditorParagraphs.find(
        candidate => candidate.paragraphKey === finding.paragraphKey
      );
      if (!paragraph) {
        toast.error("หา paragraph ของ finding นี้ใน Draft ปัจจุบันไม่พบ");
        return;
      }
      window.requestAnimationFrame(() => {
        const textarea = document.getElementById(
          `chapter-editor-paragraph-${paragraph.id}`
        ) as HTMLTextAreaElement | null;
        if (!textarea) return;
        textarea.scrollIntoView({ behavior: "smooth", block: "center" });
        textarea.focus();
        const start = Math.max(0, Math.min(Number(finding.startOffset ?? 0), textarea.value.length));
        const end = Math.max(
          start,
          Math.min(Number(finding.endOffset ?? start), textarea.value.length)
        );
        textarea.setSelectionRange(start, end);
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
      const paragraph =
        anomaly.anomalyType === "end_only_tab"
          ? chapterEditorParagraphs[chapterEditorParagraphs.length - 1]
          : chapterEditorParagraphs[0];
      if (paragraph) {
        focusChapterEditorParagraph(
          paragraph.id,
          anomaly.anomalyType === "end_only_tab" ? paragraph.text.length : 0
        );
        return;
      }
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

  const googleConnections = (
    (editorialGoogleConnections.data as any[] | undefined) ?? []
  ).filter((connection: any) => connection.status === "active" && connection.scopeReady);
  const googleDocsConnectStatus = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("googleDocsConnect");
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
  const normalizedExistingNovelSearch = existingNovelSearch.trim().toLocaleLowerCase("th");
  const searchableUnboundNovelOptions = unboundNovelOptions.filter((novel: any) =>
    !normalizedExistingNovelSearch ||
    [novel.title, novel.id].join(" ").toLocaleLowerCase("th").includes(normalizedExistingNovelSearch)
  );
  const normalizedNewNovelTitle = newNovelTitle.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("th");
  const duplicateNovel = normalizedNewNovelTitle
    ? novelOptions.find((novel: any) => String(novel.title ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("th") === normalizedNewNovelTitle)
    : null;
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
  const visibleEditorialWorkItemIds = visibleEditorialCards.map((card: any) => card.workItemId).filter((id: any): id is number => Number.isInteger(id));
  const uncheckedEditorialWorkItemIds = visibleEditorialCards.filter((card: any) => !card.evidence?.checker).map((card: any) => card.workItemId);
  const readyEditorialWorkItemIds = visibleEditorialCards.filter((card: any) => card.evidence?.readyToPublish && !card.evidence?.published).map((card: any) => card.workItemId);
  const bulkBusy = Boolean(bulkEditorTarget) || bulkRunEditorialChecker.isPending || bulkEditEditorialFinding.isPending || rerunBulkEditedChecker.isPending || bulkAllowEditorialFinding.isPending || rerunBulkAfterAllow.isPending || bulkApproveEditorialDrafts.isPending || bulkStageEditorialDrafts.isPending || bulkRequestEditorialPublish.isPending || bulkCleanupPreviewQuery.isFetching || bulkCleanupApply.isPending || refreshBulkAfterCleanup.isPending;
  const selectedEditorialCards = editorialCards.filter((card: any) => selectedEditorialSet.has(card.workItemId));
  const bulkSelectionLabel = selectedEditorialCards.map((card: any) => `${card.novel?.title ?? "ไม่ทราบเรื่อง"} ${card.episodeNumber ? `ตอน ${card.episodeNumber}` : ""}`.trim()).join("\n");
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
        </div>
        <Link href="/novels" className="text-sm text-primary underline">Back to IpeNovel</Link>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Workspace</span>
        <select aria-label="Workspace" className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm" value={selectedWorkspaceId ?? ""} onChange={(event) => setSelectedWorkspaceId(Number(event.target.value) || undefined)}>
          <option value="">เลือก Workspace</option>
          {(workspaces.data as any[] | undefined)?.map(({ workspace }: any) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        {selectedWorkspaceId && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleteWorkspace.isPending}
            onClick={() => {
              if (window.confirm("ลบ Workspace นี้หรือไม่? ระบบจะไม่ยอมลบหากยังมีนิยายอยู่ใน Workspace")) {
                deleteWorkspace.mutate({ workspaceId: selectedWorkspaceId });
              }
            }}
          >
            ลบ Workspace
          </Button>
        )}
      </div>

      <section className="space-y-6">
        <Card className={workspaces.data?.length ? "hidden" : "space-y-4 p-5"}>
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
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => window.location.assign("/api/workspace/google/start")}
                >
                  เชื่อม Google Docs
                </Button>
                {googleDocsConnectStatus === "success" && (
                  <span className="text-xs text-emerald-700">เชื่อม Google Docs แล้ว</span>
                )}
                {googleDocsConnectStatus === "error" && (
                  <span className="text-xs text-destructive">เชื่อม Google Docs ไม่สำเร็จ กรุณาลองใหม่</span>
                )}
              </div>

              <div className="space-y-3 rounded-md border bg-muted/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 font-semibold">
                      <Database className="h-4 w-4" />
                      Google Sheets Master Intake
                    </div>
                    <p className="text-xs text-muted-foreground">
                      รวมนิยาย / นิยายยังไม่จบ/ยังไม่ยื่น · อ่าน B/C/E/K (K ไม่บังคับ) · สูงสุด 100 แถวต่อครั้ง
                    </p>
                  </div>
                  <span className="rounded-full border bg-background px-2 py-1 text-xs">
                    Preview ก่อน Sync · ไม่ Publish · ไม่เขียน L/M
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <Input
                    inputMode="numeric"
                    value={masterIntakeStartRow}
                    onChange={(event) => {
                      setMasterIntakeStartRow(event.target.value);
                      setMasterIntakePreviewResult(undefined);
                    }}
                    placeholder="Start row เช่น 1584"
                  />
                  <Input
                    inputMode="numeric"
                    value={masterIntakeEndRow}
                    onChange={(event) => {
                      setMasterIntakeEndRow(event.target.value);
                      setMasterIntakePreviewResult(undefined);
                    }}
                    placeholder="End row เช่น 1600"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={masterIntakePreviewQuery.isFetching}
                    onClick={async () => {
                      const startRow = Number(masterIntakeStartRow);
                      const endRow = Number(masterIntakeEndRow || masterIntakeStartRow);
                      const connectionId = Number(googleConnectionId);
                      if (!Number.isInteger(connectionId) || connectionId <= 0) {
                        toast.error("เลือก Google connection ก่อน");
                        return;
                      }
                      if (
                        !Number.isInteger(startRow) ||
                        !Number.isInteger(endRow) ||
                        startRow < 2 ||
                        endRow < startRow ||
                        endRow - startRow + 1 > 100
                      ) {
                        toast.error("ช่วง Sync ต้องเป็น 1-100 แถว และเริ่มตั้งแต่แถว 2");
                        return;
                      }
                      try {
                        const response = await masterIntakePreviewQuery.refetch();
                        if (response.data) setMasterIntakePreviewResult(response.data);
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Preview Sync ไม่สำเร็จ");
                      }
                    }}
                  >
                    {masterIntakePreviewQuery.isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Preview Sync
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      !masterIntakePreviewResult ||
                      masterIntakeSync.isPending ||
                      masterIntakePreviewResult.rows.every((row: any) =>
                        row.status === "CONFLICT" || row.status === "UNCHANGED"
                      )
                    }
                    onClick={() => {
                      if (!masterIntakePreviewResult || !selectedWorkspaceId) return;
                      masterIntakeSync.mutate({
                        workspaceId: selectedWorkspaceId,
                        googleConnectionId: Number(googleConnectionId),
                        startRow: masterIntakePreviewResult.startRow,
                        endRow: masterIntakePreviewResult.endRow,
                        expectedPreviewFingerprint: masterIntakePreviewResult.previewFingerprint,
                      });
                    }}
                  >
                    {masterIntakeSync.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sync
                  </Button>
                </div>

                {masterIntakePreviewResult && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(["NEW", "MATCH", "UNCHANGED", "UPDATED", "CONFLICT"] as const).map((status) => (
                        <span key={status} className="rounded border bg-background px-2 py-1">
                          {status}: {masterIntakePreviewResult.summary?.[status] ?? 0}
                        </span>
                      ))}
                    </div>
                    <div className="overflow-x-auto rounded border bg-background">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b bg-muted/30">
                          <tr>
                            <th className="px-2 py-2">Row</th>
                            <th className="px-2 py-2">เรื่อง</th>
                            <th className="px-2 py-2">ตอน</th>
                            <th className="px-2 py-2">สถานะ</th>
                            <th className="px-2 py-2">Links</th>
                            <th className="px-2 py-2">หมายเหตุ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {masterIntakePreviewResult.rows.map((row: any) => (
                            <tr key={row.rowNumber} className="border-b last:border-0">
                              <td className="px-2 py-2">{row.rowNumber}</td>
                              <td className="max-w-72 px-2 py-2">{row.novelTitle ?? row.rawTitle}</td>
                              <td className="whitespace-nowrap px-2 py-2">{row.episodeNumber ?? "—"}</td>
                              <td className="px-2 py-2"><StatusPill value={row.status} /></td>
                              <td className="whitespace-nowrap px-2 py-2">
                                {row.translationDocUrl && <a className="mr-2 text-primary underline" href={row.translationDocUrl} target="_blank" rel="noreferrer">C</a>}
                                {row.webSourceUrl && <a className="mr-2 text-primary underline" href={row.webSourceUrl} target="_blank" rel="noreferrer">E</a>}
                                {row.preparedSourceDocUrl && <a className="text-primary underline" href={row.preparedSourceDocUrl} target="_blank" rel="noreferrer">K</a>}
                              </td>
                              <td className="px-2 py-2 text-muted-foreground">
                                {row.blockers?.length ? row.blockers.join(", ") : row.existingNovelId ? `Novel #${row.existingNovelId}` : "พร้อมสร้างฉบับซ่อน"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {((masterIntakeHistory.data as any[]) ?? []).length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer font-medium">Sync History</summary>
                    <div className="mt-2 space-y-1">
                      {((masterIntakeHistory.data as any[]) ?? []).slice(0, 10).map((entry: any) => (
                        <div key={entry.id} className="rounded border bg-background px-2 py-1">
                          {formatDate(entry.createdAt)} · rows {entry.metadata?.startRow ?? "?"}-{entry.metadata?.endRow ?? "?"}
                          {" · "}{entry.metadata?.summary?.succeeded ?? 0}/{entry.metadata?.summary?.attempted ?? 0} สำเร็จ
                          {" · "}{shortHash(entry.correlationId)}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
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
                  <Input
                    value={existingNovelSearch}
                    onChange={(event) => setExistingNovelSearch(event.target.value)}
                    placeholder="ค้นหาชื่อเรื่อง / Novel ID"
                  />
                  <select
                    aria-label="Existing publication novel"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={novelId}
                    onChange={(event) => setNovelId(event.target.value)}
                    disabled={bindNovel.isPending || availableNovels.isLoading}
                  >
                    <option value="">เลือกนิยาย</option>
                    {searchableUnboundNovelOptions.map((novel: any) => (
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

                {workspaceNovelOptions.length > 0 && (
                  <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                    <div className="text-sm font-medium">เรื่องใน Workspace</div>
                    {workspaceNovelOptions.map(({ workspaceNovel, novel }: any) => (
                      <div key={workspaceNovel.id} className="flex items-center justify-between gap-2 rounded-md border bg-background p-2">
                        <div className="min-w-0 text-sm">
                          <div className="truncate font-medium">{novel.title}</div>
                          <div className="text-xs text-muted-foreground">Novel #{novel.id}</div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={removeWorkspaceNovel.isPending}
                          onClick={() => {
                            if (window.confirm(`นำ “${novel.title}” ออกจาก Workspace หรือไม่? ตัวนิยายต้นฉบับจะไม่ถูกลบ`)) {
                              removeWorkspaceNovel.mutate({ workspaceId: selectedWorkspaceId, workspaceNovelId: workspaceNovel.id });
                            }
                          }}
                        >
                          นำออก
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

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
                  <div className="text-sm font-medium">1. สร้างเรื่องใหม่</div>
                  <Input
                    value={newNovelTitle}
                    onChange={(event) => setNewNovelTitle(event.target.value)}
                    maxLength={500}
                    placeholder="ชื่อเรื่อง"
                  />
                  {duplicateNovel && (
                    <div className="text-xs font-medium text-destructive">
                      มีเรื่องนี้แล้ว: {duplicateNovel.title} · Novel #{duplicateNovel.id}
                    </div>
                  )}
                  <Button type="submit" className="w-full" disabled={!newNovelTitle.trim() || Boolean(duplicateNovel) || createEditorialNovel.isPending}>
                    {createEditorialNovel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    สร้างเป็นฉบับซ่อน
                  </Button>
                </form>

                <form
                  className="space-y-2 rounded-md border bg-muted/20 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const workspaceNovelId = Number(episodeWorkspaceNovelId);
                    if (!Number.isInteger(workspaceNovelId) || workspaceNovelId <= 0) {
                      toast.error("เลือกเรื่องก่อน");
                      return;
                    }
                    if (!episodeFreeState || (episodeFreeState === "paid" && !episodePrice.trim())) {
                      toast.error("เลือก ฟรี/ขาย และระบุราคาสำหรับแพ็กที่ขาย");
                      return;
                    }
                    if (episodeIntakeMode === "bulk_docs") {
                      const rows = episodeGoogleBatchRows.filter((row) =>
                        row.episodeNumber.trim() || row.episodeTitle.trim() || row.documentUrlOrId.trim()
                      );
                      if (!rows.length) {
                        toast.error("เพิ่มช่วงตอนและลิงก์ Google Docs อย่างน้อย 1 แถว");
                        return;
                      }
                      const incomplete = rows.find((row) => !row.episodeNumber.trim() || !row.documentUrlOrId.trim());
                      if (incomplete) {
                        toast.error("ทุกแถวต้องมีช่วงตอนและลิงก์ Google Docs");
                        return;
                      }
                      const connectionId = Number(googleConnectionId) || Number(googleConnections[0]?.id);
                      if (!connectionId) {
                        toast.error("ยังไม่มี Google Docs connection");
                        return;
                      }
                      bulkImportGoogleDocs.mutate({
                        workspaceId: selectedWorkspaceId,
                        workspaceNovelId,
                        connectionId,
                        price: episodeFreeState === "free" ? "0.00" : episodePrice.trim(),
                        isFree: episodeFreeState === "free",
                        assigneeUserId: episodeAssigneeUserId ? Number(episodeAssigneeUserId) : null,
                        rows: rows.map((row) => ({
                          episodeNumber: row.episodeNumber.trim(),
                          episodeTitle: row.episodeTitle.trim() || undefined,
                          documentUrlOrId: row.documentUrlOrId.trim(),
                        })),
                      });
                      return;
                    }
                    if (episodeIntakeMode === "bulk_files") {
                      if (!episodeBatchFiles.length) {
                        toast.error("เลือกไฟล์ก่อน");
                        return;
                      }
                      const incomplete = episodeBatchFiles.find((file) => !file.episodeNumber.trim());
                      if (incomplete) {
                        toast.error(`ระบุช่วงตอนให้ไฟล์ ${incomplete.name}`);
                        return;
                      }
                      bulkImportEpisodeFiles.mutate({
                        workspaceId: selectedWorkspaceId,
                        workspaceNovelId,
                        price: episodeFreeState === "free" ? "0.00" : episodePrice.trim(),
                        isFree: episodeFreeState === "free",
                        assigneeUserId: episodeAssigneeUserId ? Number(episodeAssigneeUserId) : null,
                        files: episodeBatchFiles.map((file) => ({
                          episodeNumber: file.episodeNumber.trim(),
                          episodeTitle: file.episodeTitle.trim() || undefined,
                          fileName: file.name,
                          mimeType: file.mimeType,
                          paragraphs: file.paragraphs,
                        })),
                      });
                      return;
                    }
                    if (!episodeNumber.trim()) {
                      toast.error("ระบุตอน / ช่วงตอน");
                      return;
                    }
                    createEditorialEpisode.mutate({
                      workspaceId: selectedWorkspaceId,
                      workspaceNovelId,
                      episodeNumber: episodeNumber.trim(),
                      episodeTitle: episodeTitle.trim() || undefined,
                      saleMode: "package",
                      price: episodeFreeState === "free" ? "0.00" : episodePrice.trim(),
                      isFree: episodeFreeState === "free",
                      assigneeUserId: episodeAssigneeUserId ? Number(episodeAssigneeUserId) : null,
                    });
                  }}
                >
                  <div className="text-sm font-medium">2. เพิ่มตอนใหม่</div>
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
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant={episodeIntakeMode === "bulk_docs" ? "default" : "outline"} onClick={() => setEpisodeIntakeMode("bulk_docs")}>Google Docs หลายตอน</Button>
                    <Button type="button" size="sm" variant={episodeIntakeMode === "single" ? "default" : "outline"} onClick={() => setEpisodeIntakeMode("single")}>ตอนเดียว</Button>
                    <Button type="button" size="sm" variant={episodeIntakeMode === "bulk_files" ? "default" : "outline"} onClick={() => setEpisodeIntakeMode("bulk_files")}>ไฟล์หลายตอน</Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex h-10 items-center rounded-md border bg-violet-50 px-3 text-sm font-medium text-violet-700">Episode Pack</div>
                    <select aria-label="Episode free or paid" className="h-10 rounded-md border bg-background px-3 text-sm" value={episodeFreeState} onChange={(event) => setEpisodeFreeState(event.target.value as "" | "free" | "paid")}>
                      <option value="">ฟรี / ขาย</option>
                      <option value="free">ฟรี</option>
                      <option value="paid">ขาย</option>
                    </select>
                    <Input value={episodeFreeState === "free" ? "0.00" : episodePrice} onChange={(event) => setEpisodePrice(event.target.value)} placeholder={episodeFreeState === "paid" ? "ราคาแพ็ก" : "ราคา"} disabled={episodeFreeState === "free"} />
                  </div>
                  {episodeIntakeMode === "single" && (
                    <div className="space-y-2">
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
                    </div>
                  )}
                  {episodeIntakeMode === "bulk_docs" && (
                    <div className="space-y-2 rounded-md border bg-background p-2">
                      <div className="text-sm font-medium">Bulk Google Docs</div>
                      {episodeGoogleBatchRows.map((row, index) => (
                        <div key={index} className="grid gap-2 md:grid-cols-[120px_minmax(0,0.7fr)_minmax(0,1.5fr)_auto]">
                          <Input
                            value={row.episodeNumber}
                            onChange={(event) => setEpisodeGoogleBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, episodeNumber: event.target.value } : item))}
                            placeholder="ช่วงตอน"
                            maxLength={100}
                            aria-label={`Bulk episode range ${index + 1}`}
                          />
                          <Input
                            value={row.episodeTitle}
                            onChange={(event) => setEpisodeGoogleBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, episodeTitle: event.target.value } : item))}
                            placeholder="ชื่อตอน (ถ้ามี)"
                            maxLength={500}
                            aria-label={`Bulk episode title ${index + 1}`}
                          />
                          <Input
                            value={row.documentUrlOrId}
                            onChange={(event) => setEpisodeGoogleBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, documentUrlOrId: event.target.value } : item))}
                            placeholder="วางลิงก์ Google Docs"
                            maxLength={1000}
                            aria-label={`Bulk Google Docs link ${index + 1}`}
                          />
                          <Button type="button" size="sm" variant="ghost" disabled={episodeGoogleBatchRows.length <= 1} onClick={() => setEpisodeGoogleBatchRows((current) => current.filter((_item, rowIndex) => rowIndex !== index))}>ลบ</Button>
                        </div>
                      ))}
                      <Button type="button" size="sm" variant="outline" disabled={episodeGoogleBatchRows.length >= 30} onClick={() => setEpisodeGoogleBatchRows((current) => [...current, { episodeNumber: "", episodeTitle: "", documentUrlOrId: "" }])}>
                        <Plus className="mr-1 h-4 w-4" /> เพิ่มแถว
                      </Button>
                    </div>
                  )}
                  {episodeIntakeMode === "bulk_files" && (
                    <div className="space-y-2">
                      <input
                        type="file"
                        multiple
                        accept=".txt,.md,text/plain,text/markdown"
                        aria-label="Import multiple Episode Pack files"
                        className="block w-full text-sm"
                        disabled={bulkImportEpisodeFiles.isPending || createEditorialEpisode.isPending}
                        onChange={async (event) => {
                          const files = Array.from(event.target.files ?? []);
                          if (!files.length) {
                            setEpisodeBatchFiles([]);
                            return;
                          }
                          if (files.length > 50) {
                            toast.error("เลือกได้สูงสุด 50 ไฟล์ต่อครั้ง");
                            event.target.value = "";
                            return;
                          }
                          if (files.some((file) => file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) {
                            toast.error("แต่ละไฟล์ต้องไม่เกิน 10 MB และรวมไม่เกิน 40 MB");
                            event.target.value = "";
                            return;
                          }
                          const rows = await Promise.all(files.map(async (file) => {
                            const content = await file.text();
                            const paragraphs = content.replace(/\r\n?/g, "\n").split("\n");
                            const parsed = parseEpisodeRangeFromFileName(file.name);
                            return {
                              name: file.name,
                              mimeType: file.type || "text/plain",
                              paragraphs,
                              episodeNumber: parsed.episodeNumber,
                              episodeTitle: parsed.episodeTitle,
                            };
                          }));
                          if (rows.some((row) => row.paragraphs.length > 10000)) {
                            toast.error("ไฟล์ต้องมีไม่เกิน 10,000 บรรทัด");
                            event.target.value = "";
                            return;
                          }
                          setEpisodeBatchFiles(rows);
                        }}
                      />
                      {episodeBatchFiles.length > 0 && (
                        <div className="max-h-64 space-y-2 overflow-auto rounded-md border bg-background p-2">
                          {episodeBatchFiles.map((file, index) => (
                            <div key={`${file.name}:${index}`} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)]">
                              <div className="truncate self-center text-xs font-medium" title={file.name}>{file.name}</div>
                              <Input
                                value={file.episodeNumber}
                                onChange={(event) => setEpisodeBatchFiles((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, episodeNumber: event.target.value } : row))}
                                placeholder="ช่วงตอน"
                                maxLength={100}
                              />
                              <Input
                                value={file.episodeTitle}
                                onChange={(event) => setEpisodeBatchFiles((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, episodeTitle: event.target.value } : row))}
                                placeholder="ชื่อตอน"
                                maxLength={500}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!episodeWorkspaceNovelId || createEditorialEpisode.isPending || bulkImportGoogleDocs.isPending || bulkImportEpisodeFiles.isPending}
                  >
                    {(createEditorialEpisode.isPending || bulkImportGoogleDocs.isPending || bulkImportEpisodeFiles.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {episodeIntakeMode === "bulk_docs"
                      ? `นำเข้า Google Docs ${episodeGoogleBatchRows.filter((row) => row.episodeNumber.trim() || row.documentUrlOrId.trim()).length} แพ็ก`
                      : episodeIntakeMode === "bulk_files"
                        ? `นำเข้า ${episodeBatchFiles.length} ไฟล์`
                        : "เพิ่มงานตอน"}
                  </Button>
                </form>
              </div>

              <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">Editorial Workspace</div>
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
              {editorialView === "table" && editorialEvidenceStatuses.isError && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">โหลดสถานะตารางไม่สำเร็จ: {editorialEvidenceStatuses.error.message}</div>}
              {editorialView === "table" && <div className="space-y-2 rounded-lg border bg-muted/10 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" aria-label="เลือก Episode Pack ที่มองเห็นทั้งหมด" checked={visibleEditorialWorkItemIds.length > 0 && visibleEditorialWorkItemIds.every((id) => selectedEditorialSet.has(id))} disabled={bulkBusy} onChange={(event) => setSelectedEditorialWorkItemIds(event.target.checked ? visibleEditorialWorkItemIds : [])} /> เลือกที่มองเห็น</label>
                  <Button type="button" size="sm" variant="ghost" disabled={bulkBusy || !uncheckedEditorialWorkItemIds.length} onClick={() => setSelectedEditorialWorkItemIds(uncheckedEditorialWorkItemIds)}>เลือกยังไม่ตรวจ</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={bulkBusy || !readyEditorialWorkItemIds.length} onClick={() => setSelectedEditorialWorkItemIds(readyEditorialWorkItemIds)}>เลือกพร้อมลง</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={bulkBusy || !selectedEditorialWorkItemIds.length} onClick={() => setSelectedEditorialWorkItemIds([])}>ล้างที่เลือก</Button>
                  <span className="text-xs text-muted-foreground">เลือกแล้ว {selectedEditorialWorkItemIds.length} ตอน · ที่มองเห็น {visibleEditorialWorkItemIds.length}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={!selectedEditorialWorkItemIds.length || bulkBusy} onClick={() => bulkRunEditorialChecker.mutate({ workspaceId: selectedWorkspaceId!, workItemIds: selectedEditorialWorkItemIds })}>{bulkRunEditorialChecker.isPending ? "กำลังตรวจ…" : "3. ตรวจ / ตรวจซ้ำ"}</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selectedEditorialWorkItemIds.length || bulkBusy}
                    onClick={async () => {
                      try {
                        const response = await bulkCleanupPreviewQuery.refetch();
                        if (response.error) {
                          toast.error(response.error.message);
                          return;
                        }
                        if (response.data) {
                          setBulkCleanupPreviewResult(response.data);
                          const duplicateGroups = response.data.groups.filter((group: any) => group.occurrenceCount > 1).length;
                          toast.success(`จัดกลุ่มแล้ว · คำ/ข้อความซ้ำ ${duplicateGroups} กลุ่ม · ค้าง ${response.data.summary.openFindingCount} จุด`);
                        }
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "จัดกลุ่ม finding ไม่สำเร็จ");
                      }
                    }}
                  >
                    {bulkCleanupPreviewQuery.isFetching ? "กำลังจัดกลุ่ม…" : "3.1 จัดกลุ่ม / ลบซ้ำ"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={!selectedEditorialWorkItemIds.length || bulkBusy} onClick={() => bulkApproveEditorialDrafts.mutate({ workspaceId: selectedWorkspaceId!, workItemIds: selectedEditorialWorkItemIds })}>{bulkApproveEditorialDrafts.isPending ? "กำลังยืนยัน…" : "4. ยืนยัน Draft ปัจจุบัน"}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!selectedEditorialWorkItemIds.length || bulkBusy} onClick={() => bulkStageEditorialDrafts.mutate({ workspaceId: selectedWorkspaceId!, workItemIds: selectedEditorialWorkItemIds })}>{bulkStageEditorialDrafts.isPending ? "กำลัง Stage…" : "5. Stage"}</Button>
                  <Button type="button" size="sm" disabled={!selectedEditorialWorkItemIds.length || bulkBusy} onClick={() => { const readyCount = selectedEditorialCards.filter((card: any) => card.evidence?.readyToPublish && !card.evidence?.published).length; const blockedCount = selectedEditorialCards.length - readyCount; if (window.confirm(`Controlled Publish\n\nพร้อมลง ${readyCount} ตอน · ยังไม่พร้อม ${blockedCount} ตอน\n\n${bulkSelectionLabel}\n\nรายการที่ไม่ผ่าน readiness / ownership / evidence จะไม่ถูกเผยแพร่`)) bulkRequestEditorialPublish.mutate({ workspaceId: selectedWorkspaceId!, workItemIds: selectedEditorialWorkItemIds }); }}>{bulkRequestEditorialPublish.isPending ? "กำลังเผยแพร่…" : "6. Publish"}</Button>
                </div>
                {bulkCleanupPreviewResult && (
                  <div className="space-y-2 rounded-md border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">Bulk Finding Cleanup</div>
                        <div className="text-xs text-muted-foreground">
                          Preview เท่านั้น · ลบใน Workspace Draft · สร้าง Draft ใหม่ 1 version ต่อ Episode Pack · ตรวจซ้ำอัตโนมัติ
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        พร้อม {bulkCleanupPreviewResult.summary.readyWorkItems}/{bulkCleanupPreviewResult.summary.selectedWorkItems} Pack · ค้าง {bulkCleanupPreviewResult.summary.openFindingCount} จุด
                      </span>
                    </div>
                    {bulkCleanupPreviewResult.sourceJunk?.occurrenceCount > 0 && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2">
                        <div className="text-sm">
                          <span className="font-semibold">SOURCE JUNK ทั้งชุด</span>
                          {" · "}{bulkCleanupPreviewResult.sourceJunk.occurrenceCount} จุด
                          {" · "}{bulkCleanupPreviewResult.sourceJunk.paragraphCount} ย่อหน้า
                          {" · "}{bulkCleanupPreviewResult.sourceJunk.workItemCount} Pack
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={bulkBusy}
                          onClick={() => {
                            if (!window.confirm(
                              `ลบ Source Junk ทั้งชุด ${bulkCleanupPreviewResult.sourceJunk.occurrenceCount} จุด จาก ${bulkCleanupPreviewResult.sourceJunk.workItemCount} Episode Pack?\n\nระบบจะสร้าง Draft ใหม่ 1 version ต่อ Pack และตรวจซ้ำอัตโนมัติ`
                            )) return;
                            bulkCleanupApply.mutate({
                              workspaceId: selectedWorkspaceId!,
                              workItemIds: bulkCleanupPreviewResult.workItemIds,
                              expectedPreviewFingerprint: bulkCleanupPreviewResult.previewFingerprint,
                              action: { kind: "source_junk" },
                            });
                          }}
                        >
                          ลบ Source Junk ทั้งหมด
                        </Button>
                      </div>
                    )}
                    <div className="space-y-1">
                      {bulkCleanupPreviewResult.groups
                        .filter((group: any) => group.occurrenceCount > 1)
                        .slice(0, 60)
                        .map((group: any) => (
                          <div key={group.groupKey} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
                            <div className="min-w-0">
                              <span className="font-medium break-all">{group.displayToken}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {group.ruleKey} · {group.occurrenceCount} จุด · {group.paragraphCount} ย่อหน้า · {group.workItemCount} Pack
                              </span>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={bulkBusy}
                              onClick={() => {
                                if (!window.confirm(
                                  `ลบ “${group.displayToken}” ทั้งหมด ${group.occurrenceCount} จุด?\n\nลบเฉพาะ exact finding ที่อยู่ใน Preview นี้ และตรวจซ้ำอัตโนมัติ`
                                )) return;
                                bulkCleanupApply.mutate({
                                  workspaceId: selectedWorkspaceId!,
                                  workItemIds: bulkCleanupPreviewResult.workItemIds,
                                  expectedPreviewFingerprint: bulkCleanupPreviewResult.previewFingerprint,
                                  action: { kind: "group", groupKey: group.groupKey },
                                });
                              }}
                            >
                              ลบทั้งหมด {group.occurrenceCount} จุด
                            </Button>
                          </div>
                        ))}
                      {bulkCleanupPreviewResult.groups.filter((group: any) => group.occurrenceCount > 1).length === 0 && (
                        <div className="text-xs text-muted-foreground">ไม่พบ exact finding ที่ซ้ำมากกว่า 1 จุด</div>
                      )}
                    </div>
                  </div>
                )}
                {bulkCheckerSummary.length > 0 && (() => {
                  const passed = bulkCheckerSummary.filter((result: any) => result.ok && result.effectiveStatus === "passed").length;
                  const needsFix = bulkCheckerSummary.filter((result: any) => result.ok && result.effectiveStatus === "failed").length;
                  const technicalFailed = bulkCheckerSummary.filter((result: any) => !result.ok).length;
                  const openFindings = bulkCheckerSummary.reduce((sum: number, result: any) => sum + (result.ok ? Number(result.unresolvedCount ?? 0) : 0), 0);
                  const structuralAnomalies = bulkCheckerSummary.reduce((sum: number, result: any) => sum + (result.ok ? Number(result.structuralSummary?.anomalyCount ?? 0) : 0), 0);
                  const totalTabs = bulkCheckerSummary.reduce((sum: number, result: any) => sum + (result.ok ? Number(result.structuralSummary?.tabCount ?? 0) : 0), 0);
                  return <div className="space-y-2 rounded-md border bg-background p-3">
                    <div className="flex flex-wrap items-center gap-3 text-sm font-medium">
                      <span>สรุปผลตรวจ {bulkCheckerSummary.length} ไฟล์</span>
                      <span>รวม {totalTabs} แท็บ</span>
                      <span className="text-emerald-700">ผ่าน {passed}</span>
                      <span className="text-amber-700">ต้องแก้ {needsFix}</span>
                      <span className="text-orange-700">ผิดปกติ {structuralAnomalies}</span>
                      <span className="text-red-700">ผิดพลาด {technicalFailed}</span>
                      <span>ค้างแก้คำ {openFindings}</span>
                    </div>
                    <div className="space-y-1">
                      {bulkCheckerSummary.map((result: any) => {
                        const card = editorialCards.find((candidate: any) => candidate.workItemId === result.workItemId);
                        const label = `${card?.novel?.title ?? "ไม่ทราบเรื่อง"} · ${card?.episodeNumber ?? `Work item #${result.workItemId}`}`;
                        const paragraphs = result.ok ? groupBulkCheckerParagraphs(result.openFindings ?? []) : [];
                        const anomalies = result.ok ? (result.anomalies ?? []) : [];
                        const missingChapters = anomalies
                          .filter((anomaly: any) => anomaly.anomalyType === "missing_expected_chapter")
                          .map((anomaly: any) => Number(anomaly.chapterNumber))
                          .filter((value: number) => Number.isInteger(value));
                        const endOnlyCount = anomalies.filter((anomaly: any) => anomaly.anomalyType === "end_only_tab").length;
                        const emptyCount = anomalies.filter((anomaly: any) => anomaly.anomalyType === "empty_tab").length;
                        const headingOnlyCount = anomalies.filter((anomaly: any) => anomaly.anomalyType === "heading_only_tab").length;
                        const sourceNoteCount = anomalies.filter((anomaly: any) => anomaly.anomalyType === "source_note_only").length;
                        const duplicateAnomalies = anomalies.filter((anomaly: any) =>
                          anomaly.anomalyType === "duplicate_content_exact" ||
                          anomaly.anomalyType === "duplicate_content_near"
                        );
                        const duplicatePairs = duplicateAnomalies.map((anomaly: any) => {
                          const left = anomaly.details?.leftChapterNumber ?? anomaly.chapterNumber ?? anomaly.tabTitle ?? "?";
                          const right = anomaly.details?.rightChapterNumber ?? "?";
                          const score = anomaly.anomalyType === "duplicate_content_near"
                            ? ` · similarity ${Math.round(Math.max(Number(anomaly.details?.dice ?? 0), Number(anomaly.details?.containment ?? 0)) * 100)}%`
                            : "";
                          return `${left} ↔ ${right}${score}`;
                        });
                        const structuralSummary = result.structuralSummary;
                        return <div key={result.workItemId} className="rounded border px-3 py-2 text-xs">
                          <div className="grid gap-1 md:grid-cols-[minmax(0,1fr)_auto]">
                            <div>
                              <div className="font-medium">{label}</div>
                              {result.ok && (
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                                  <span>
                                    แท็บ {structuralSummary?.tabCount ?? 0}
                                    {structuralSummary?.expectedTabCount ? `/${structuralSummary.expectedTabCount}` : ""}
                                  </span>
                                  <span>คำ/อักษรค้าง {result.unresolvedCount ?? 0}</span>
                                  <span className={Number(structuralSummary?.anomalyCount ?? 0) ? "text-orange-700" : "text-emerald-700"}>
                                    ผิดปกติ {structuralSummary?.anomalyCount ?? 0}
                                  </span>
                                  {Number(structuralSummary?.blockingAnomalyCount ?? 0) > 0 && (
                                    <span className="text-red-700">บล็อก {structuralSummary.blockingAnomalyCount}</span>
                                  )}
                                </div>
                              )}
                              {result.ok && result.effectiveStatus === "failed" && <div className="text-amber-700">ต้องแก้ก่อนยืนยัน Draft · {paragraphs.length} ย่อหน้าที่มี finding</div>}
                              {result.ok && result.effectiveStatus === "passed" && Number(structuralSummary?.anomalyCount ?? 0) === 0 && <div className="text-emerald-700">ผ่าน · ไม่พบคำต่างประเทศหรือโครงสร้างผิดปกติ</div>}
                              {result.ok && result.effectiveStatus === "passed" && Number(structuralSummary?.anomalyCount ?? 0) > 0 && <div className="text-orange-700">ผ่านด้าน blocking QC แต่มี anomaly ที่ควรตรวจทาน</div>}
                              {!result.ok && <div className="text-red-700">ตรวจไม่สำเร็จ: {result.error}</div>}
                            </div>
                            <div className={result.ok ? (result.effectiveStatus === "passed" ? "text-emerald-700" : "text-amber-700") : "text-red-700"}>
                              {result.ok ? (result.effectiveStatus === "passed" ? "ผ่าน" : "ต้องแก้") : "ผิดพลาด"}
                            </div>
                          </div>
                          {result.ok && anomalies.length > 0 && (
                            <div className="mt-2 space-y-1 rounded-md border border-orange-200 bg-orange-50/40 p-3 text-xs">
                              <div className="font-semibold text-orange-800">ค่าผิดปกติของไฟล์</div>
                              {missingChapters.length > 0 && (
                                <div>บทที่หาย: <span className="font-medium">{formatCompactNumberRanges(missingChapters)}</span></div>
                              )}
                              {endOnlyCount > 0 && <div>แท็บมีเฉพาะ “จบตอน”: <span className="font-medium">{endOnlyCount} แท็บ</span></div>}
                              {emptyCount > 0 && <div>แท็บไม่มีเนื้อหา: <span className="font-medium">{emptyCount} แท็บ</span></div>}
                              {headingOnlyCount > 0 && <div>แท็บมีเฉพาะชื่อบท: <span className="font-medium">{headingOnlyCount} แท็บ</span></div>}
                              {sourceNoteCount > 0 && <div>หมายเหตุจากต้นฉบับ: <span className="font-medium">{sourceNoteCount} แท็บ</span></div>}
                              {duplicatePairs.length > 0 && (
                                <div className="space-y-1">
                                  <div>เนื้อหาซ้ำ/คล้ายซ้ำ: <span className="font-medium">{duplicatePairs.length} คู่</span></div>
                                  {duplicatePairs.slice(0, 12).map((pair: string, index: number) => (
                                    <div key={`${result.workItemId}:duplicate:${index}`} className="pl-3">• {pair}</div>
                                  ))}
                                  {duplicatePairs.length > 12 && <div className="pl-3 text-muted-foreground">…และอีก {duplicatePairs.length - 12} คู่</div>}
                                </div>
                              )}
                              {anomalies
                                .filter((anomaly: any) => ![
                                  "missing_expected_chapter",
                                  "end_only_tab",
                                  "empty_tab",
                                  "heading_only_tab",
                                  "source_note_only",
                                  "duplicate_content_exact",
                                  "duplicate_content_near",
                                ].includes(anomaly.anomalyType))
                                .slice(0, 10)
                                .map((anomaly: any) => (
                                  <div key={anomaly.anomalyKey}>• {anomaly.message}</div>
                                ))}
                            </div>
                          )}
                          {result.ok && result.effectiveStatus === "failed" && paragraphs.length > 0 && (
                            <div className="mt-2 space-y-2">
                              {paragraphs.map((paragraph: any) => {
                                const anchorFinding = paragraph.findings[0];
                                const tokens = Array.from(new Set(paragraph.findings.map((finding: any) => finding.token).filter(Boolean)));
                                const editing = bulkEditorTarget?.workItemId === result.workItemId && bulkEditorTarget?.paragraphKey === paragraph.paragraphKey;
                                return <div key={`${result.workItemId}:${paragraph.paragraphKey}:${paragraph.paragraphFingerprint}`} className="rounded-md border bg-muted/10 p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="font-medium">ย่อหน้า {paragraph.paragraphOrder} · พบ {paragraph.findings.length} จุด{tokens.length ? ` · ${tokens.join(", ")}` : ""}</div>
                                    {!editing && <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={!result.latestDraft || !anchorFinding || bulkBusy}
                                      onClick={() => {
                                        if (!result.latestDraft || !anchorFinding) return;
                                        setBulkEditorTarget({
                                          workItemId: result.workItemId,
                                          paragraphKey: paragraph.paragraphKey,
                                          paragraphFingerprint: paragraph.paragraphFingerprint,
                                          expectedText: paragraph.contextText,
                                          draftId: result.latestDraft.id,
                                          draftVersion: result.latestDraft.version,
                                          draftSha256: result.latestDraft.draftSha256,
                                          findingId: anchorFinding.id,
                                          findingKey: anchorFinding.findingKey,
                                        });
                                        setBulkEditorText(paragraph.contextText);
                                      }}
                                    >แก้ย่อหน้านี้</Button>}
                                  </div>
                                  <div className="mt-2 whitespace-pre-wrap rounded bg-background p-2 text-sm leading-6">{paragraph.contextText}</div>
                                  {!editing && (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {Array.from(new Map(paragraph.findings.map((finding: any) => [finding.token, finding])).values()).map((finding: any) => (
                                        <Button
                                          key={`${finding.id}:${finding.token}`}
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          disabled={(finding.ruleKey === "long_english" || finding.ruleKey === "source_junk") || bulkBusy}
                                          onClick={() => {
                                            if (!window.confirm(`ยกเว้นคำ “${finding.token}” สำหรับ Checker ทั้ง Workspace?`)) return;
                                            bulkAllowEditorialFinding.mutate({
                                              workspaceId: selectedWorkspaceId!,
                                              workItemId: result.workItemId,
                                              findingId: finding.id,
                                              expectedVersion: finding.resolutionVersion ?? 0,
                                              idempotencyKey: `bulk-allow:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                            });
                                          }}
                                        >
                                          ยกเว้นคำ “{finding.token}”
                                        </Button>
                                      ))}
                                    </div>
                                  )}
                                  {editing && bulkEditorTarget && (
                                    <div className="mt-2 space-y-2">
                                      <textarea
                                        className="min-h-32 w-full rounded-md border bg-background p-3 text-sm leading-6"
                                        value={bulkEditorText}
                                        maxLength={200000}
                                        disabled={bulkEditEditorialFinding.isPending || rerunBulkEditedChecker.isPending}
                                        onChange={(event) => setBulkEditorText(event.target.value)}
                                        autoFocus
                                      />
                                      <div className="flex flex-wrap justify-end gap-2">
                                        <Button type="button" size="sm" variant="ghost" disabled={bulkEditEditorialFinding.isPending || rerunBulkEditedChecker.isPending} onClick={() => { setBulkEditorTarget(undefined); setBulkEditorText(""); }}>ยกเลิก</Button>
                                        <Button
                                          type="button"
                                          size="sm"
                                          disabled={bulkEditEditorialFinding.isPending || rerunBulkEditedChecker.isPending || bulkEditorText === bulkEditorTarget.expectedText}
                                          onClick={() => bulkEditEditorialFinding.mutate({
                                            workspaceId: selectedWorkspaceId!,
                                            workItemId: bulkEditorTarget.workItemId,
                                            expectedDraftId: bulkEditorTarget.draftId,
                                            expectedDraftVersion: bulkEditorTarget.draftVersion,
                                            expectedDraftSha256: bulkEditorTarget.draftSha256,
                                            findingId: bulkEditorTarget.findingId,
                                            findingKey: bulkEditorTarget.findingKey,
                                            command: {
                                              kind: "replace_paragraph",
                                              paragraphKey: bulkEditorTarget.paragraphKey,
                                              expectedParagraphFingerprint: bulkEditorTarget.paragraphFingerprint,
                                              expectedText: bulkEditorTarget.expectedText,
                                              replacementText: bulkEditorText,
                                            },
                                            idempotencyKey: `bulk-editor:${bulkEditorTarget.draftId}:${bulkEditorTarget.findingId}:${Date.now()}`,
                                          })}
                                        >
                                          {(bulkEditEditorialFinding.isPending || rerunBulkEditedChecker.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                          บันทึก + ตรวจซ้ำ
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>;
                              })}
                            </div>
                          )}
                        </div>;
                      })}
                    </div>
                  </div>;
                })()}
              </div>}
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
                    <div className="overflow-x-auto"><table className="w-full min-w-[1240px] border-collapse text-sm">
                      <thead><tr className="border-y bg-muted/10 text-left text-xs text-muted-foreground"><th className="w-10 px-3 py-2"><span className="sr-only">เลือก</span></th><th className="px-3 py-2 font-medium">เรื่อง / ช่วงตอน</th><th className="px-3 py-2 font-medium">การขาย</th><th className="px-3 py-2 text-center font-medium">3. ตรวจ</th><th className="px-3 py-2 text-center font-medium">ผลตรวจ</th><th className="px-3 py-2 text-center font-medium">4. ยืนยัน</th><th className="px-3 py-2 text-center font-medium">5. Stage</th><th className="px-3 py-2 text-center font-medium">พร้อมลง</th><th className="px-3 py-2 text-center font-medium">6. เผยแพร่</th><th className="min-w-72 px-3 py-2 font-medium">หมายเหตุ</th></tr></thead>
                      <tbody>{group.cards.slice().sort((a: any,b: any)=>String(a.episodeNumber??"").localeCompare(String(b.episodeNumber??""),"th",{numeric:true})).map((card:any)=>(
                        <tr key={card.id} className={`border-b last:border-b-0 hover:bg-muted/10 ${selectedEditorialSet.has(card.workItemId) ? "bg-primary/5" : ""}`}>
                          <td className="px-3 py-3 align-top"><input type="checkbox" aria-label={`เลือก Episode Pack ${card.episodeNumber || card.workItemId}`} checked={selectedEditorialSet.has(card.workItemId)} disabled={!card.workItemId || bulkBusy} onChange={() => card.workItemId && toggleEditorialSelection(card.workItemId)} /></td>
                          <td className="px-3 py-3"><button type="button" className="text-left font-medium text-primary hover:underline" disabled={!card.workItemId} onClick={()=>setSelectedSourceWorkItemId(card.workItemId)}>{card.workItemType==="NEW_EPISODE" ? card.episodeNumber||"ตอนใหม่" : "เรื่องใหม่ / Draft แรก"}</button>{card.episodeTitle&&<div className="mt-0.5 text-xs text-muted-foreground">{card.episodeTitle}</div>}<div className="mt-1"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${card.evidence?.published ? "border-emerald-300 bg-emerald-50 text-emerald-700" : card.evidence?.readyToPublish ? "border-blue-300 bg-blue-50 text-blue-700" : card.evidence?.stage ? "border-violet-300 bg-violet-50 text-violet-700" : card.evidence?.approval ? "border-amber-300 bg-amber-50 text-amber-700" : card.evidence?.checker ? "border-cyan-300 bg-cyan-50 text-cyan-700" : "border-slate-300 bg-slate-50 text-slate-600"}`}>{card.evidence?.published ? "เผยแพร่แล้ว" : card.evidence?.readyToPublish ? "พร้อมลง" : card.evidence?.stage ? "Stage แล้ว" : card.evidence?.approval ? "ยืนยันแล้ว" : card.evidence?.checker ? "ตรวจแล้ว" : card.columnName}</span></div>{card.columnKey==="new"&&card.workItemId&&<div className="mt-2 flex gap-2"><Button type="button" size="sm" variant="outline" onClick={()=>{const next=window.prompt("แก้ช่วงตอน",card.episodeNumber||"");if(next&&next.trim()&&next.trim()!==String(card.episodeNumber||"").trim())updateEditorialEpisode.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId,episodeNumber:next.trim(),episodeTitle:card.episodeTitle||undefined});}}>แก้ไข</Button><Button type="button" size="sm" variant="outline" onClick={()=>{if(window.confirm(`นำ Episode Pack ${card.episodeNumber||""} ออกจาก Workspace หรือไม่?`))removeEditorialEpisode.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId});}}>นำออก</Button></div>}</td>
                          <td className="px-3 py-3">
                            {card.isFree === true ? (
                              <span className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">ฟรี</span>
                            ) : card.saleMode === "chapter" ? (
                              <span className="inline-flex rounded-full border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">ขายรายตอน · ฿{card.price ?? "—"}</span>
                            ) : card.saleMode === "package" ? (
                              <span className="inline-flex rounded-full border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-700">แพ็กเกจ · ฿{card.price ?? "—"}</span>
                            ) : (
                              <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">ยังไม่กำหนดการขาย</span>
                            )}
                            {card.saleMetadataSource === "published_episode" && <div className="mt-1 text-[10px] text-muted-foreground">ข้อมูลจากตอนที่เผยแพร่</div>}
                            {card.workItemId && !card.evidence?.stage && !card.evidence?.published && (
                              <div className="mt-2">
                                <Button type="button" size="sm" variant="outline" disabled={updateEditorialEpisodeSale.isPending} onClick={()=>{const current=card.isFree===true?"free":"paid";const mode=window.prompt("การขาย Episode Pack: พิมพ์ free = ฟรี หรือ paid = ขาย",current)?.trim().toLowerCase();if(mode!=="free"&&mode!=="paid")return;if(mode==="free"){updateEditorialEpisodeSale.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId,price:"0.00",isFree:true});return;}const price=window.prompt("ราคาแพ็ก (บาท)",card.price&&Number(card.price)>0?String(card.price):"100.00")?.trim();if(price)updateEditorialEpisodeSale.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId,price,isFree:false});}}>แก้การขาย</Button>
                              </div>
                            )}
                          </td>
                          {[
                            ["checkerRan", card.evidence?.checkerRan, "รัน Deterministic Checker แล้ว"],
                            ["checker", card.evidence?.checker, "Deterministic Checker ผ่านบน Draft ปัจจุบัน"],
                            ["approval", card.evidence?.approval, "Approval ตรงกับ Draft/QC ปัจจุบัน"],
                            ["stage", card.evidence?.stage, "Episode staging ครบและยัง valid"],
                            ["ready", card.evidence?.readyToPublish, "Publish readiness ผ่าน stage + ownership + anchor"],
                            ["published", card.evidence?.published, card.evidence?.publishedSource === "published_episode" ? "พบ Episode ที่เผยแพร่จริงตรงกับ Novel + ช่วงตอน (historical/legacy publication)" : "Publish run + receipt + outbox + reader visibility ครบ"],
                          ].map(([key, passed, label]) => {
                            const passedClass = key === "checkerRan" ? "bg-cyan-50 text-cyan-800" : key === "checker" ? "bg-teal-50 text-teal-800" : key === "approval" ? "bg-amber-50 text-amber-800" : key === "stage" ? "bg-violet-50 text-violet-800" : key === "ready" ? "bg-blue-50 text-blue-800" : "bg-emerald-50 text-emerald-800";
                            const tickClass = key === "checkerRan" ? "border-cyan-500 bg-cyan-600 text-white" : key === "checker" ? "border-teal-500 bg-teal-600 text-white" : key === "approval" ? "border-amber-500 bg-amber-500 text-white" : key === "stage" ? "border-violet-500 bg-violet-600 text-white" : key === "ready" ? "border-blue-500 bg-blue-600 text-white" : "border-emerald-500 bg-emerald-600 text-white";
                            const available = card.evidence?.available !== false;
                            return <td key={String(key)} className={`px-3 py-3 text-center ${card.evidence ? (available ? (passed ? passedClass : "bg-slate-50 text-slate-500") : "bg-red-50 text-red-700") : ""}`} title={available ? String(label) : String(card.evidence?.error ?? "โหลดสถานะไม่สำเร็จ")}>
                              {card.evidence ? available ? (
                                <span aria-label={passed ? "ผ่าน" : "ยังไม่ผ่าน"} className={`inline-flex h-6 w-6 items-center justify-center rounded-md border text-sm font-bold ${passed ? tickClass : "border-slate-300 bg-white text-slate-300"}`}>{passed ? "✓" : "—"}</span>
                              ) : <span aria-label="โหลดสถานะไม่สำเร็จ" className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-red-300 bg-red-100 text-xs font-bold text-red-700">!</span> : <span className="text-muted-foreground">…</span>}
                            </td>;
                          })}
                          <td className="px-3 py-2"><Input key={String(card.workItemId) + ":" + String(card.workItemVersion) + ":" + String(card.note ?? "")} defaultValue={card.note??""} maxLength={1000} placeholder="บันทึกหมายเหตุ" disabled={!card.workItemId||!card.workItemVersion||updateEditorialWorkItemNote.isPending} onBlur={(event)=>{const next=event.currentTarget.value.trim();if(next===(card.note??""))return;updateEditorialWorkItemNote.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId,note:next||null,expectedVersion:card.workItemVersion});}} /></td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  </details>
                ))}</div>
              ) : <EmptyState>Editorial board is being prepared for this Workspace.</EmptyState>}

            </Card>

            <Card className="space-y-5 p-5">
              <div>
                <div className="flex items-center gap-2">
                  <FileCheck2 className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">Episode Pack Detail</h2>
                </div>
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
                          : "—"}
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
                        <div className="font-medium">3. ตรวจ / ตรวจซ้ำ</div>
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
                        ผลตรวจนี้เก่าแล้ว — Draft หรือ Checker engine เปลี่ยน ให้กด “ตรวจ / ตรวจซ้ำ” ก่อนแก้สถานะ finding
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
                                (finding.ruleKey === "long_english" || finding.ruleKey === "source_junk") ||
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


                  <details
                    id="workspace-chapter-editor"
                    className="rounded-md border bg-muted/10"
                    open={chapterEditorTarget ? true : undefined}
                  >
                    <summary className="cursor-pointer list-none p-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">
                            Workspace Editor · {draftStructureSummary.totalTabs} แท็บ
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>Draft v{latestEditorialDraft?.version ?? "—"}</span>
                            <span>SHA {shortHash(latestEditorialDraft?.draftSha256)}</span>
                            <span>แก้ไข {editorialEditorData?.history?.length ?? 0}</span>
                          </div>
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
                    </summary>
                    <div className="space-y-3 border-t p-3">
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
                        </div>
                      </div>

                      {!!chapterEditorTabs.length ? (
                        filteredChapterEditorTabs.length ? (
                        <div className="space-y-2">
                          {filteredChapterEditorTabs.map((tab: any) => (
                            <div key={tab.id} className="rounded-md border bg-background p-3 text-sm">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div>{tab.title}</div>
                                  {(() => {
                                    const status = chapterEditorStatusByTab.get(tab.sourceTabId);
                                    return (
                                      <div className="mt-1 flex flex-wrap gap-1 text-xs">
                                        <span
                                          className={
                                            status?.edited
                                              ? "rounded-full bg-blue-100 px-2 py-0.5 text-blue-800"
                                              : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                                          }
                                        >
                                          {status?.edited ? "แก้แล้ว" : "ยังไม่แก้"}
                                        </span>
                                        {(status?.foreignFindingCount ?? 0) > 0 && (
                                          <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-yellow-900">
                                            คำต่างประเทศ {status?.foreignFindingCount}
                                          </span>
                                        )}
                                        {(status?.structuralIssueCount ?? 0) > 0 && (
                                          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-900">
                                            structural issue {status?.structuralIssueCount}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })()}
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    {tab.paragraphs.length} paragraphs · {shortHash(tab.structuralSha256)}
                                    {tab.chapterNumber
                                      ? ` · บทที่ ${tab.chapterNumber}${tab.chapterTitle ? ` · ${tab.chapterTitle}` : ""}`
                                      : ""}
                                    {tab.warnings?.length ? ` · ${tab.warnings.join(", ")}` : ""}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant={tab.paragraphs.length ? "outline" : "default"}
                                    disabled={!latestEditorialDraft || editEditorialDraft.isPending}
                                    onClick={() => openChapterEditor(tab)}
                                  >
                                    {tab.paragraphs.length ? "เปิด Editor" : "เติมเนื้อหา"}
                                  </Button>
                                  {editorialEditorData?.latestDraft && (() => {
                                    const draftTab = (editorialEditorData.tabs ?? []).find(
                                      (candidate: any) => candidate.sourceTabId === tab.sourceTabId
                                    );
                                    if (!draftTab) return null;
                                    return (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          excludeEditorialTab.isPending ||
                                          editorialEditorData.tabs.length <= 1
                                        }
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              `นำแท็บ ${tab.title} ออกจาก Draft นี้หรือไม่? ระบบจะสร้าง Draft revision ใหม่ และต้องตรวจ QC/ยืนยันใหม่`
                                            )
                                          ) {
                                            excludeEditorialTab.mutate({
                                              workspaceId: selectedWorkspaceId!,
                                              workItemId: selectedSourceWorkItemId!,
                                              expectedDraftId: editorialEditorData.latestDraft.id,
                                              expectedDraftSha256:
                                                editorialEditorData.latestDraft.draftSha256,
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
                            </div>
                          ))}
                        </div>
                        ) : (
                          <EmptyState>ไม่พบแท็บตามตัวกรอง</EmptyState>
                        )
                      ) : (
                        <EmptyState>ยังไม่มีแท็บใน Draft</EmptyState>
                      )}

                      {(editorialEditorData?.excludedTabs ?? []).length > 0 && (
                        <details className="rounded-md border bg-background">
                          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                            แท็บที่นำออก {editorialEditorData.excludedTabs.length}
                          </summary>
                          <div className="space-y-2 border-t p-3">
                            {editorialEditorData.excludedTabs.map((tab: any) => (
                              <div
                                key={tab.sourceTabId}
                                className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
                              >
                                <span>{tab.title}</span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={restoreEditorialTab.isPending}
                                  onClick={() =>
                                    restoreEditorialTab.mutate({
                                      workspaceId: selectedWorkspaceId!,
                                      workItemId: selectedSourceWorkItemId!,
                                      expectedDraftId: editorialEditorData.latestDraft.id,
                                      expectedDraftSha256:
                                        editorialEditorData.latestDraft.draftSha256,
                                      sourceTabId: tab.sourceTabId,
                                    })
                                  }
                                >
                                  คืนแท็บ
                                </Button>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}

                    {chapterEditorTarget && (
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

                        <details open className="rounded-lg border bg-background">
                          <summary className="cursor-pointer list-none px-3 py-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="font-medium">
                                  Issue Queue · {chapterEditorIssueItems.length}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  คำต่างประเทศ {chapterEditorIssueCounts.findings} · structural {chapterEditorIssueCounts.structural}
                                </div>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                {chapterEditorIssueItems.length > 0
                                  ? `${Math.min(
                                      chapterEditorIssueIndex + 1,
                                      chapterEditorIssueItems.length
                                    )}/${chapterEditorIssueItems.length}`
                                  : "ไม่มี issue"}
                              </div>
                            </div>
                          </summary>
                          <div className="space-y-2 border-t p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs text-muted-foreground">
                                ใช้ Previous/Next หรือปุ่ม action เพื่อไปยังจุดตรวจ · foreign finding และ structural issue อยู่ในคิวเดียวกัน
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    !chapterEditorIssueItems.length ||
                                    chapterEditorIssueIndex <= 0
                                  }
                                  onClick={() => navigateRelativeChapterEditorIssue(-1)}
                                >
                                  <ChevronLeft className="mr-1 h-4 w-4" />
                                  Previous finding
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    !chapterEditorIssueItems.length ||
                                    chapterEditorIssueIndex >=
                                      chapterEditorIssueItems.length - 1
                                  }
                                  onClick={() => navigateRelativeChapterEditorIssue(1)}
                                >
                                  Next finding
                                  <ChevronRight className="ml-1 h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            {chapterEditorIssueItems.length ? (
                              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                                {chapterEditorIssueItems.map((issue, issueIndex) => {
                                  const selected =
                                    selectedChapterEditorIssue?.key === issue.key;
                                  if (issue.kind === "finding") {
                                    const finding = issue.finding as any;
                                    const canAccept =
                                      finding.disposition !== "accepted" &&
                                      finding.ruleKey !== "long_english" &&
                                      finding.ruleKey !== "source_junk";
                                    return (
                                      <div
                                        key={issue.key}
                                        className={
                                          selected
                                            ? "rounded-md border border-primary bg-primary/5 p-2 text-sm"
                                            : "rounded-md border p-2 text-sm"
                                        }
                                      >
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                          <div className="min-w-0 flex-1">
                                            <div className="font-medium">
                                              {finding.token}
                                            </div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                              {finding.ruleKey} · paragraph{" "}
                                              {finding.paragraphOrder} ·{" "}
                                              {finding.startOffset}-
                                              {finding.endOffset}
                                            </div>
                                          </div>
                                          <StatusPill
                                            value={finding.disposition ?? "open"}
                                          />
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                              navigateChapterEditorIssue(
                                                issue,
                                                issueIndex
                                              )
                                            }
                                          >
                                            ไปยังจุด
                                          </Button>
                                          {finding.disposition === "open" && (
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
                                                  workspaceId:
                                                    selectedWorkspaceId!,
                                                  workItemId:
                                                    selectedSourceWorkItemId!,
                                                  findingId: finding.id,
                                                  disposition: "fixed",
                                                  expectedVersion:
                                                    finding.resolutionVersion ?? 0,
                                                  idempotencyKey: `editorial-inline-fixed:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                                })
                                              }
                                            >
                                              Mark fixed
                                            </Button>
                                          )}
                                          {(finding.disposition === "fixed" ||
                                            finding.disposition === "ignored") && (
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
                                                  workspaceId:
                                                    selectedWorkspaceId!,
                                                  workItemId:
                                                    selectedSourceWorkItemId!,
                                                  findingId: finding.id,
                                                  disposition: "open",
                                                  expectedVersion:
                                                    finding.resolutionVersion ?? 0,
                                                  idempotencyKey: `editorial-inline-reopen:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                                })
                                              }
                                            >
                                              Reopen
                                            </Button>
                                          )}
                                          {canAccept && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              disabled={
                                                editorialCheckerRunStale ||
                                                allowEditorialFinding.isPending
                                              }
                                              onClick={() =>
                                                allowEditorialFinding.mutate({
                                                  workspaceId:
                                                    selectedWorkspaceId!,
                                                  workItemId:
                                                    selectedSourceWorkItemId!,
                                                  findingId: finding.id,
                                                  expectedVersion:
                                                    finding.resolutionVersion ?? 0,
                                                  idempotencyKey: `editorial-inline-allow:${finding.id}:${finding.resolutionVersion ?? 0}`,
                                                })
                                              }
                                            >
                                              ยอมรับคำนี้
                                            </Button>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  }
                                  const anomaly = issue.anomaly as any;
                                  const relatedTabs =
                                    structuralNavigationTabs(anomaly);
                                  const confirmedSourceNote =
                                    anomaly.disposition ===
                                    "confirmed_source_note";
                                  const repairLabel =
                                    anomaly.anomalyType === "empty_tab"
                                      ? "เติมเนื้อหา"
                                      : anomaly.anomalyType ===
                                            "heading_only_tab" ||
                                          anomaly.anomalyType === "end_only_tab"
                                        ? "เปิดจุดซ่อม"
                                        : "ไปยัง structural issue";
                                  return (
                                    <div
                                      key={issue.key}
                                      className={
                                        selected
                                          ? "rounded-md border border-orange-500 bg-orange-50 p-2 text-sm"
                                          : "rounded-md border p-2 text-sm"
                                      }
                                    >
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                          <div className="font-medium">
                                            Structural · {anomaly.anomalyType}
                                          </div>
                                          <div className="mt-1 text-xs text-muted-foreground">
                                            {anomaly.message}
                                          </div>
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                          {confirmedSourceNote && (
                                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                                              confirmed source note
                                            </span>
                                          )}
                                          <span
                                            className={
                                              anomaly.severity === "error"
                                                ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800"
                                                : "rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-900"
                                            }
                                          >
                                            {anomaly.severity}
                                          </span>
                                        </div>
                                      </div>
                                      <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                                        {chapterEditorStructuralRepairGuidance(
                                          anomaly.anomalyType
                                        )}
                                      </div>
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            navigateChapterEditorIssue(
                                              issue,
                                              issueIndex
                                            )
                                          }
                                        >
                                          {repairLabel}
                                        </Button>
                                        {relatedTabs.map((tab: any) => (
                                          <Button
                                            key={tab.sourceTabId}
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            disabled={
                                              editEditorialDraft.isPending
                                            }
                                            onClick={() =>
                                              openChapterEditor(tab)
                                            }
                                          >
                                            {anomaly.anomalyType ===
                                            "missing_expected_chapter"
                                              ? "เปิดแท็บใกล้เคียง"
                                              : "เปิดแท็บ"}{" "}
                                            {tab.title}
                                          </Button>
                                        ))}
                                        {anomaly.anomalyType ===
                                          "source_note_only" && (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant={
                                              confirmedSourceNote
                                                ? "outline"
                                                : "default"
                                            }
                                            disabled={
                                              editorialCheckerRunStale ||
                                              setStructuralConfirmation.isPending
                                            }
                                            onClick={() =>
                                              setStructuralConfirmation.mutate({
                                                workspaceId:
                                                  selectedWorkspaceId!,
                                                workItemId:
                                                  selectedSourceWorkItemId!,
                                                anomalyId: anomaly.id,
                                                confirmed:
                                                  !confirmedSourceNote,
                                                expectedVersion:
                                                  anomaly.confirmationVersion ??
                                                  0,
                                              })
                                            }
                                          >
                                            {confirmedSourceNote
                                              ? "ยกเลิกยืนยันหมายเหตุต้นฉบับ"
                                              : "ยืนยันว่าเป็นหมายเหตุต้นฉบับ"}
                                          </Button>
                                        )}
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="ghost"
                                          disabled={
                                            !latestEditorialDraft ||
                                            runEditorialForeignChecker.isPending
                                          }
                                          onClick={() => {
                                            if (!latestEditorialDraft) return;
                                            runEditorialForeignChecker.mutate({
                                              workspaceId:
                                                selectedWorkspaceId!,
                                              workItemId:
                                                selectedSourceWorkItemId!,
                                              expectedDraftId:
                                                latestEditorialDraft.id,
                                            });
                                          }}
                                        >
                                          ตรวจ structural ซ้ำ
                                        </Button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                                ไม่พบ foreign finding หรือ structural issue ในบทนี้
                              </div>
                            )}
                          </div>
                        </details>

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
                          <div className="space-y-1">
                            {chapterEditorParagraphs.map((paragraph, index) => (
                              <ChapterEditorParagraphBlock
                                key={paragraph.id}
                                paragraphId={paragraph.id}
                                value={paragraph.text}
                                findings={
                                  paragraph.paragraphKey
                                    ? (chapterEditorFindingsByParagraphKey.get(paragraph.paragraphKey) ?? [])
                                    : []
                                }
                                highlight={chapterEditorHighlight}
                                disabled={editEditorialDraft.isPending}
                                placeholder={
                                  chapterEditorParagraphs.length === 1 && !paragraph.text
                                    ? "เริ่มเขียนหรือวางเนื้อหาของบทนี้..."
                                    : undefined
                                }
                                onChange={value => updateChapterEditorParagraph(index, value)}
                                onSplit={(start, end) =>
                                  splitChapterEditorParagraph(index, start, end)
                                }
                                onMergePrevious={() =>
                                  mergeChapterEditorParagraphWithPrevious(index)
                                }
                                onPasteParagraphs={(paragraphs, start, end) =>
                                  pasteChapterEditorParagraphs(index, paragraphs, start, end)
                                }
                              />
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs text-muted-foreground">
                            Enter = ย่อหน้าใหม่ · Shift+Enter = ขึ้นบรรทัดในย่อหน้า · Ctrl/Cmd+S = บันทึก · วางจาก ChatGPT/Google Docs จะตัดบรรทัดว่างออกอัตโนมัติ · สีไฮไลต์เป็น UI เท่านั้น
                          </div>
                          <Button
                            type="button"
                            disabled={
                              editEditorialDraft.isPending ||
                              chapterEditorText === chapterEditorTarget.expectedText
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
                    )}

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

                    <details className="rounded-md border bg-background">
                      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                        เครื่องมือแก้ไขรายย่อหน้า
                      </summary>
                      <div className="space-y-2 border-t p-3">
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
                    </details>
                  </div>
                  </details>

                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">4. ยืนยัน Draft ปัจจุบัน</div>
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
                              ? `5. Stage · พร้อม 1 แพ็ก · ${editorialApprovalData.stagePlan.itemCount} บท`
                              : "5. Stage · ยังไม่พร้อม"}
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
                        {editorialApprovalData.stagePlan.commerce && (
                          <div className="rounded border bg-background px-3 py-2 text-xs">
                            ขายเป็นแพ็ก {editorialApprovalData.stagePlan.commerce.episodeNumber} ·{" "}
                            {editorialApprovalData.stagePlan.commerce.billableTabCount} บท · ฿{editorialApprovalData.stagePlan.commerce.price}
                            {(editorialApprovalData.stagePlan.commerce.excludedTabCount ?? 0) > 0
                              ? ` · ไม่นับ ${editorialApprovalData.stagePlan.commerce.excludedTabCount} แท็บ`
                              : ""}
                          </div>
                        )}

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
                        4. ยืนยัน Draft ปัจจุบัน
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
                          ? `5. Stage ${editorialApprovalData.stagePlan.itemCount} Episode Drafts`
                          : "5. Stage"}
                      </Button>
                    </div>

                    {editorialApprovalData?.readyToPublish && (
                      <div className="space-y-2 rounded-md border p-3 text-sm">
                        <div className="font-medium">6. Publish</div>
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
                          6. Publish
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
              </summary>
              <div className="space-y-5 border-t p-5">
            <Card className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-primary" />
                    <h2 className="text-xl font-semibold">{selected.workspace.name}</h2>
                  </div>
                </div>
                <StatusPill value={selected.workspace.status} />
              </div>

              <div className="grid gap-5 md:grid-cols-2">
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
                          {!canInspectFinalGate ? <span className="text-muted-foreground">Final gate package requires platform admin access.</span> : !readinessEligible ? <span className="text-muted-foreground">Final gate package is not applicable in the current ownership epoch.</span> : finalGate.isLoading ? <span>Loading final gate…</span> : finalGate.data ? <div className="space-y-1"><div>Gate ready: <strong>{(finalGate.data as any).gate.gateReady ? "yes" : "no"}</strong></div><div>Operator cutover eligible: <strong>{(finalGate.data as any).gate.operatorCutoverEligible ? "yes" : "no"}</strong></div><div className="text-xs text-muted-foreground">Blockers: {(finalGate.data as any).gate.blockers.join(", ") || "none"}</div></div> : finalGate.error ? <span className="text-destructive">Final gate unavailable: {finalGate.error.message}</span> : null}
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
            </Card>
              </div>
            </details>
          </div>
        ) : null}
      </section>
    </main>
  );
}
