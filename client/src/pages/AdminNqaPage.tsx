import React, { useMemo, useState } from "react";
import { toast } from "sonner";

import AdminLayout from "@/components/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FlaskConical,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";

type Tab = "overview" | "fullqa" | "qc" | "autolink" | "history";
type RunMode = "FULL_QA" | "QC";
type SampleMode = "5" | "10" | "FULL";

type ChapterResult = {
  row: number;
  chapter: number;
  displayDecision: "PASS" | "REVIEW" | "MISMATCH" | "INSUFFICIENT";
  coreDecision: "PASS" | "REVIEW" | "FAIL";
  reasonCodes: string[];
  confidence: number | null;
  policyVersion: string | null;
  modelSetVersion: string | null;
  evidence: Array<{ kind: string; boundedSummary: string }>;
  sourceExcerpt: string | null;
  translationExcerpt: string | null;
  qcFindings: Array<{
    type: string;
    severity: "INFO" | "REVIEW" | "FAIL";
    summary: string;
  }>;
  requestId: string;
  correlationId: string;
  auditRef: string;
  resultFingerprint: string;
  completedAt: string;
};

const TAB_ITEMS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "fullqa", label: "Full QA" },
  { id: "qc", label: "QC" },
  { id: "autolink", label: "Novel ID Auto-Link" },
  { id: "history", label: "Runs / History" },
];

function readinessBadge(ready: boolean) {
  return ready ? (
    <Badge className="bg-emerald-100 text-emerald-800">READY</Badge>
  ) : (
    <Badge className="bg-amber-100 text-amber-800">BLOCKED</Badge>
  );
}

function decisionBadge(decision: ChapterResult["displayDecision"]) {
  const classes: Record<ChapterResult["displayDecision"], string> = {
    PASS: "bg-emerald-100 text-emerald-800",
    REVIEW: "bg-amber-100 text-amber-800",
    MISMATCH: "bg-red-100 text-red-800",
    INSUFFICIENT: "bg-slate-100 text-slate-700",
  };
  return <Badge className={classes[decision]}>{decision}</Badge>;
}

function BlockerList({ blockers }: { blockers: readonly string[] }) {
  if (blockers.length === 0) {
    return <p className="text-sm text-emerald-700">No blockers.</p>;
  }
  return (
    <div className="space-y-1">
      {blockers.map(blocker => (
        <div key={blocker} className="text-xs text-amber-800">
          • {blocker}
        </div>
      ))}
    </div>
  );
}

export function ReadinessCard({
  title,
  ready,
  blockers,
  description,
}: {
  title: string;
  ready: boolean;
  blockers: readonly string[];
  description: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          {readinessBadge(ready)}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-slate-600">{description}</p>
        <BlockerList blockers={blockers} />
      </CardContent>
    </Card>
  );
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resultForAutoLink(value: unknown): any {
  if (!value || typeof value !== "object") return null;
  const response = value as { result?: unknown };
  return response.result && typeof response.result === "object"
    ? response.result
    : null;
}

export default function AdminNqaPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [selectedResult, setSelectedResult] = useState<ChapterResult | null>(
    null
  );
  const utils = trpc.useUtils();

  const status = trpc.admin.nqa.status.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const history = trpc.admin.nqa.history.useQuery(
    { limit: 30 },
    { retry: false, refetchOnWindowFocus: false }
  );
  const runQuery = trpc.admin.nqa.run.useQuery(
    {
      runId: selectedRunId || "nqa-admin-00000000-0000-0000-0000-000000000000",
    },
    {
      enabled: Boolean(selectedRunId),
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  async function refreshRun(runId: string) {
    setSelectedRunId(runId);
    await utils.admin.nqa.run.invalidate({ runId });
    await utils.admin.nqa.history.invalidate();
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="h-7 w-7 text-indigo-600" />
              <h1 className="text-2xl font-bold">NQA Admin Tool</h1>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Translation fidelity, QC, Novel ID Auto-Link, checkpointed runs
              and preview-first Sheet writeback.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              await Promise.all([status.refetch(), history.refetch()]);
            }}
            disabled={status.isFetching || history.isFetching}
          >
            <RefreshCw
              className={
                "mr-2 h-4 w-4 " +
                (status.isFetching || history.isFetching ? "animate-spin" : "")
              }
            />
            Refresh status
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 border-b pb-3">
          {TAB_ITEMS.map(item => (
            <Button
              key={item.id}
              size="sm"
              variant={tab === item.id ? "default" : "outline"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab
            data={status.data}
            loading={status.isLoading}
            error={status.error?.message ?? null}
          />
        )}

        {tab === "fullqa" && (
          <RunTab
            mode="FULL_QA"
            status={status.data}
            currentRun={runQuery.data}
            selectedRunId={selectedRunId}
            onSelectRun={refreshRun}
            onResult={setSelectedResult}
          />
        )}

        {tab === "qc" && (
          <RunTab
            mode="QC"
            status={status.data}
            currentRun={runQuery.data}
            selectedRunId={selectedRunId}
            onSelectRun={refreshRun}
            onResult={setSelectedResult}
          />
        )}

        {tab === "autolink" && <AutoLinkTab />}

        {tab === "history" && (
          <HistoryTab
            runs={history.data ?? []}
            loading={history.isLoading}
            onOpen={async runId => {
              await refreshRun(runId);
              const run = (history.data ?? []).find(
                candidate => candidate.runId === runId
              );
              setTab(run?.mode === "QC" ? "qc" : "fullqa");
            }}
          />
        )}

        <ChapterDetailDialog
          result={selectedResult}
          onClose={() => setSelectedResult(null)}
        />
      </div>
    </AdminLayout>
  );
}

function OverviewTab({
  data,
  loading,
  error,
}: {
  data: any;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <Card className="p-8 text-center text-slate-600">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />
        Checking NQA runtime readiness...
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className="border-red-200 p-6">
        <div className="flex gap-3 text-red-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Unable to read NQA status.</p>
            <p className="text-sm">{error ?? "Unknown status error"}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <ReadinessCard
          title="Full QA"
          ready={data.fullQa.ready}
          blockers={data.fullQa.blockers}
          description="Semantic fidelity pipeline: deterministic, embeddings, reranker, adjudication and structured verification."
        />
        <ReadinessCard
          title="QC"
          ready={data.qc.ready}
          blockers={data.qc.blockers}
          description="Foreign script, Unicode anomaly, footer and empty-chapter checks. Latin proper names are allowed."
        />
        <ReadinessCard
          title="Novel ID Auto-Link"
          ready={data.autolink.previewReady}
          blockers={data.autolink.previewBlockers}
          description="Read-only preview is separate from remediation-backed Column A confirmation."
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-slate-500">Sheet Intake</p>
          <p className="mt-1 font-semibold">
            {data.google.sheetReadReady ? "Ready" : "Blocked"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Workspace Google Docs</p>
          <p className="mt-1 font-semibold">
            {data.google.docsReady ? "Ready" : "Blocked"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.google.connections.length} connection(s)
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Semantic Sidecars</p>
          <p className="mt-1 font-semibold">
            {data.semantic.embeddingReady &&
            data.semantic.rerankerReady &&
            data.semantic.qwenReady
              ? "3/3 Ready"
              : "Incomplete"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">L/M Writeback</p>
          <p className="mt-1 font-semibold">
            {data.writeback.ready ? "Ready" : "Read-only"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Explicit confirmation required
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live target</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <span className="text-slate-500">Spreadsheet:</span>{" "}
            {data.target.spreadsheetTitle}
          </div>
          <div>
            <span className="text-slate-500">Sheet:</span>{" "}
            {data.target.sheetName}
          </div>
          <div className="md:col-span-2 break-all">
            <span className="text-slate-500">Spreadsheet ID:</span>{" "}
            {data.target.spreadsheetId}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RunTab({
  mode,
  status,
  currentRun,
  selectedRunId,
  onSelectRun,
  onResult,
}: {
  mode: RunMode;
  status: any;
  currentRun: any;
  selectedRunId: string;
  onSelectRun: (runId: string) => Promise<void>;
  onResult: (result: ChapterResult) => void;
}) {
  const [startRow, setStartRow] = useState("");
  const [endRow, setEndRow] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [sample, setSample] = useState<SampleMode>("10");
  const [isProcessing, setIsProcessing] = useState(false);
  const [writebackPreview, setWritebackPreview] = useState<any>(null);
  const [writebackConfirmation, setWritebackConfirmation] = useState("");
  const [writebackRow, setWritebackRow] = useState("");
  const utils = trpc.useUtils();

  const startMutation = trpc.admin.nqa.startRun.useMutation();
  const nextMutation = trpc.admin.nqa.processNext.useMutation();
  const previewWriteback = trpc.admin.nqa.previewWriteback.useMutation();
  const confirmWriteback = trpc.admin.nqa.confirmWriteback.useMutation();

  const readiness = mode === "FULL_QA" ? status?.fullQa : status?.qc;
  const connections = status?.google?.connections ?? [];

  const progress =
    currentRun?.summary?.totalChapters > 0
      ? Math.round(
          (currentRun.summary.processedChapters /
            currentRun.summary.totalChapters) *
            100
        )
      : 0;

  async function start() {
    const start = parsePositiveInt(startRow);
    const end = parsePositiveInt(endRow || startRow);
    const connection = parsePositiveInt(connectionId);
    if (!start || !end || end < start || !connection) {
      toast.error("กรอก Row range และ Google connection ให้ถูกต้อง");
      return;
    }

    try {
      const created = await startMutation.mutateAsync({
        mode,
        startRow: start,
        endRow: end,
        googleConnectionId: connection,
        sampleParagraphs:
          mode === "QC"
            ? "FULL"
            : sample === "FULL"
              ? "FULL"
              : Number(sample) === 5
                ? 5
                : 10,
        qcEligibilityOnly: mode === "QC",
      });
      await onSelectRun(created.runId);
      toast.success("NQA run created. กด Run / Resume เพื่อเริ่มประมวลผล");
    } catch (error: any) {
      toast.error(error?.message ?? "Unable to start NQA run");
    }
  }

  async function runOrResume() {
    if (!selectedRunId) {
      toast.error("Start or select a run first");
      return;
    }
    setIsProcessing(true);
    try {
      let latest = currentRun;
      let safety = 0;
      while (latest?.status !== "COMPLETED" && safety < 5_000) {
        latest = await nextMutation.mutateAsync({
          runId: selectedRunId,
        });
        safety += 1;
        utils.admin.nqa.run.setData({ runId: selectedRunId }, latest);
      }
      await utils.admin.nqa.history.invalidate();
      if (latest?.status === "COMPLETED") {
        toast.success("NQA run completed");
      }
    } catch (error: any) {
      toast.error(
        error?.message ??
          "Run paused. Progress is checkpointed and can be resumed."
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function makeWritebackPreview(column: "L" | "M") {
    const row = parsePositiveInt(writebackRow);
    if (!selectedRunId || !row) {
      toast.error("Select a completed run and row first");
      return;
    }
    try {
      const response = await previewWriteback.mutateAsync({
        runId: selectedRunId,
        row,
        column,
      });
      setWritebackPreview(response);
      setWritebackConfirmation("");
    } catch (error: any) {
      toast.error(error?.message ?? "Writeback preview failed");
    }
  }

  async function confirmWritebackNow() {
    const preview = writebackPreview?.preview;
    if (!preview || writebackConfirmation !== preview.confirmation) {
      toast.error("Confirmation phrase does not match");
      return;
    }
    try {
      await confirmWriteback.mutateAsync({
        runId: preview.runId,
        row: preview.row,
        column: preview.column,
        previewFingerprint: preview.fingerprint,
        confirmation: writebackConfirmation,
      });
      toast.success("Column " + preview.column + " writeback verified");
      setWritebackPreview(null);
      setWritebackConfirmation("");
      await Promise.all([
        utils.admin.nqa.run.invalidate({ runId: preview.runId }),
        utils.admin.nqa.history.invalidate(),
      ]);
    } catch (error: any) {
      toast.error(error?.message ?? "Writeback confirmation failed");
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              {mode === "FULL_QA"
                ? "Full QA — Translation Fidelity"
                : "QC — Marker / Unicode / Footer"}
            </CardTitle>
            {readiness && readinessBadge(readiness.ready)}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {readiness && !readiness.ready && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3">
              <BlockerList blockers={readiness.blockers} />
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2">
              <Label>Start row</Label>
              <Input
                placeholder="1761"
                value={startRow}
                onChange={event => setStartRow(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>End row</Label>
              <Input
                placeholder="1765"
                value={endRow}
                onChange={event => setEndRow(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Workspace Google Docs connection</Label>
              <select
                className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                value={connectionId}
                onChange={event => setConnectionId(event.target.value)}
              >
                <option value="">Select connection</option>
                {connections.map((connection: any) => (
                  <option
                    key={connection.id}
                    value={connection.id}
                    disabled={
                      connection.status !== "active" || !connection.scopeReady
                    }
                  >
                    #{connection.id} — {connection.status}
                    {connection.scopeReady ? "" : " (scope blocked)"}
                  </option>
                ))}
              </select>
            </div>
            {mode === "FULL_QA" ? (
              <div className="space-y-2">
                <Label>Sampling</Label>
                <select
                  className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  value={sample}
                  onChange={event =>
                    setSample(event.target.value as SampleMode)
                  }
                >
                  <option value="5">5 paragraphs / chapter</option>
                  <option value="10">10 paragraphs / chapter</option>
                  <option value="FULL">Full chapter</option>
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>QC eligibility</Label>
                <div className="flex h-10 items-center rounded-md border bg-slate-50 px-3 text-sm">
                  F=True and G=False · Full chapter
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={start}
              disabled={startMutation.isPending || readiness?.ready === false}
            >
              {startMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="mr-2 h-4 w-4" />
              )}
              Create run
            </Button>
            <Button
              variant="outline"
              onClick={runOrResume}
              disabled={!selectedRunId || isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run / Resume
            </Button>
          </div>
        </CardContent>
      </Card>

      {currentRun && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Run {currentRun.runId}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">{currentRun.status}</Badge>
                <Badge variant="outline">
                  rows {currentRun.startRow}-{currentRun.endRow}
                </Badge>
                <Badge variant="outline">
                  sample={String(currentRun.sampleParagraphs)}
                </Badge>
              </div>
              <Progress value={progress} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div>
                  <p className="text-xs text-slate-500">Progress</p>
                  <p className="font-semibold">
                    {currentRun.summary.processedChapters}/
                    {currentRun.summary.totalChapters}
                  </p>
                </div>
                {(["PASS", "REVIEW", "MISMATCH", "INSUFFICIENT"] as const).map(
                  decision => (
                    <div key={decision}>
                      <p className="text-xs text-slate-500">{decision}</p>
                      <p className="font-semibold">
                        {currentRun.summary.decisions[decision]}
                      </p>
                    </div>
                  )
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Chapter results</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Chapter</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Reasons</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(currentRun.results as ChapterResult[]).map(result => (
                      <TableRow
                        key={
                          result.row +
                          ":" +
                          result.chapter +
                          ":" +
                          result.completedAt
                        }
                      >
                        <TableCell>{result.row}</TableCell>
                        <TableCell>{result.chapter}</TableCell>
                        <TableCell>
                          {decisionBadge(result.displayDecision)}
                        </TableCell>
                        <TableCell className="max-w-[360px] truncate text-xs">
                          {result.reasonCodes.join(", ") || "—"}
                        </TableCell>
                        <TableCell>
                          {result.confidence === null
                            ? "—"
                            : result.confidence.toFixed(3)}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onResult(result)}
                          >
                            Evidence
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {currentRun.results.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center text-slate-500"
                        >
                          No chapter has been processed yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Preview-first Result Writeback
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-600">
                Nothing is written while running QA. Select a completed row,
                preview the exact value, then type the exact confirmation
                phrase. Column L and M are separate mutations.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="max-w-[180px]"
                  placeholder="Sheet row"
                  value={writebackRow}
                  onChange={event => {
                    setWritebackRow(event.target.value);
                    setWritebackPreview(null);
                    setWritebackConfirmation("");
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => makeWritebackPreview("L")}
                  disabled={previewWriteback.isPending}
                >
                  Preview Column L
                </Button>
                <Button
                  variant="outline"
                  onClick={() => makeWritebackPreview("M")}
                  disabled={previewWriteback.isPending}
                >
                  Preview Column M
                </Button>
              </div>

              {writebackPreview?.preview && (
                <div className="space-y-3 rounded border p-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">
                      Row {writebackPreview.preview.row}
                    </Badge>
                    <Badge variant="outline">
                      Column {writebackPreview.preview.column}
                    </Badge>
                  </div>
                  <div>
                    <Label>Exact value to write</Label>
                    <Textarea
                      readOnly
                      value={writebackPreview.preview.value}
                      className="mt-2 min-h-24"
                    />
                  </div>
                  <p className="text-sm">
                    Type exactly:{" "}
                    <code className="rounded bg-slate-100 px-1">
                      {writebackPreview.preview.confirmation}
                    </code>
                  </p>
                  <Input
                    value={writebackConfirmation}
                    onChange={event =>
                      setWritebackConfirmation(event.target.value)
                    }
                    placeholder="Confirmation phrase"
                  />
                  <Button
                    onClick={confirmWritebackNow}
                    disabled={
                      confirmWriteback.isPending ||
                      writebackConfirmation !==
                        writebackPreview.preview.confirmation
                    }
                  >
                    <Save className="mr-2 h-4 w-4" />
                    Confirm writeback
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function AutoLinkTab() {
  const [row, setRow] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const rowNumber = parsePositiveInt(row) ?? 2;

  const status = trpc.workspace.nqaNovelLink.status.useQuery(undefined, {
    retry: false,
  });
  const preview = trpc.workspace.nqaNovelLink.preview.useQuery(
    { row: rowNumber },
    { enabled: false, retry: false }
  );
  const confirm = trpc.workspace.nqaNovelLink.confirmBackfill.useMutation();
  const previewResult = resultForAutoLink(preview.data);
  const canConfirm =
    previewResult?.status === "MATCH" &&
    typeof previewResult?.matchedNovelId === "number" &&
    typeof previewResult?.previewFingerprint === "string";

  async function runPreview() {
    if (!parsePositiveInt(row)) {
      toast.error("Enter a valid Sheet row");
      return;
    }
    setConfirmPhrase("");
    const response = await preview.refetch();
    if (response.error) {
      toast.error(response.error.message);
    }
  }

  async function confirmMatch() {
    if (!canConfirm || confirmPhrase !== "I_CONFIRM_NQA_NOVEL_ID_BACKFILL") {
      toast.error("Fresh MATCH preview and exact human confirmation required");
      return;
    }
    try {
      await confirm.mutateAsync({
        row: rowNumber,
        novelId: previewResult.matchedNovelId,
        previewFingerprint: previewResult.previewFingerprint,
      });
      toast.success("Novel ID Column A backfill verified");
      setConfirmPhrase("");
      await Promise.all([status.refetch(), preview.refetch()]);
    } catch (error: any) {
      toast.error(error?.message ?? "Auto-Link confirmation failed");
    }
  }

  return (
    <div className="space-y-6">
      <ReadinessCard
        title="Novel ID Auto-Link Runtime"
        ready={Boolean(status.data?.previewReady)}
        blockers={status.data?.previewBlockers ?? ["STATUS_LOADING"]}
        description="Existing Workspace Auto-Link runtime. Preview is read-only; Column A confirmation remains behind the existing remediation gate."
      />

      <Card>
        <CardHeader>
          <CardTitle>Preview one Sheet row</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-[200px]"
              placeholder="Row e.g. 1584"
              value={row}
              onChange={event => {
                setRow(event.target.value);
                setConfirmPhrase("");
              }}
            />
            <Button
              onClick={runPreview}
              disabled={preview.isFetching || !status.data?.previewReady}
            >
              {preview.isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Preview
            </Button>
          </div>

          {previewResult && (
            <div className="space-y-4 rounded border p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-xs text-slate-500">Status</p>
                  <p className="font-semibold">{previewResult.status}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Matched novelId</p>
                  <p className="font-semibold">
                    {previewResult.matchedNovelId ?? "—"}
                  </p>
                </div>
                <div className="md:col-span-2">
                  <p className="text-xs text-slate-500">Title</p>
                  <p className="font-semibold">
                    {previewResult.novelTitle ?? "—"}
                  </p>
                </div>
                <div className="md:col-span-2 break-all">
                  <p className="text-xs text-slate-500">Preview fingerprint</p>
                  <code className="text-xs">
                    {previewResult.previewFingerprint}
                  </code>
                </div>
              </div>

              {canConfirm && (
                <div className="space-y-3 border-t pt-4">
                  {!status.data?.confirmReady && (
                    <div className="rounded border border-amber-200 bg-amber-50 p-3">
                      <p className="mb-2 text-sm font-medium text-amber-900">
                        Confirm is currently fail-closed.
                      </p>
                      <BlockerList
                        blockers={status.data?.confirmBlockers ?? []}
                      />
                    </div>
                  )}
                  <p className="text-sm">
                    Type exactly: <code>I_CONFIRM_NQA_NOVEL_ID_BACKFILL</code>
                  </p>
                  <Input
                    value={confirmPhrase}
                    onChange={event => setConfirmPhrase(event.target.value)}
                    placeholder="Human confirmation"
                  />
                  <Button
                    onClick={confirmMatch}
                    disabled={
                      confirm.isPending ||
                      !status.data?.confirmReady ||
                      confirmPhrase !== "I_CONFIRM_NQA_NOVEL_ID_BACKFILL"
                    }
                  >
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Confirm Column A Backfill
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryTab({
  runs,
  loading,
  onOpen,
}: {
  runs: any[];
  loading: boolean;
  onOpen: (runId: string) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runs / History</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-slate-500">Loading run history...</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map(run => (
                  <TableRow key={run.runId}>
                    <TableCell className="max-w-[260px] truncate font-mono text-xs">
                      {run.runId}
                    </TableCell>
                    <TableCell>{run.mode}</TableCell>
                    <TableCell>
                      {run.startRow}-{run.endRow}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{run.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {run.summary.processedChapters}/
                      {run.summary.totalChapters}
                    </TableCell>
                    <TableCell className="text-xs">
                      {new Date(run.updatedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpen(run.runId)}
                      >
                        {run.status === "COMPLETED" ? "View" : "Resume"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-slate-500"
                    >
                      No NQA Admin runs yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChapterDetailDialog({
  result,
  onClose,
}: {
  result: ChapterResult | null;
  onClose: () => void;
}) {
  const evidence = useMemo(() => result?.evidence ?? [], [result]);

  return (
    <Dialog
      open={Boolean(result)}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        {result && (
          <>
            <DialogHeader>
              <DialogTitle>
                Row {result.row} · Chapter {result.chapter}
              </DialogTitle>
              <DialogDescription>
                Bounded NQA evidence only. Full Google document bodies are not
                persisted in run history.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                {decisionBadge(result.displayDecision)}
                {result.policyVersion && (
                  <Badge variant="outline">{result.policyVersion}</Badge>
                )}
                {result.confidence !== null && (
                  <Badge variant="outline">
                    confidence={result.confidence.toFixed(3)}
                  </Badge>
                )}
              </div>

              {result.qcFindings.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold">QC findings</h3>
                  {result.qcFindings.map((finding, index) => (
                    <div
                      key={finding.type + index}
                      className="rounded border p-3 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        {finding.severity === "FAIL" ? (
                          <AlertTriangle className="h-4 w-4 text-red-600" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-amber-600" />
                        )}
                        <strong>{finding.type}</strong>
                      </div>
                      <p className="mt-1 text-slate-600">{finding.summary}</p>
                    </div>
                  ))}
                </div>
              )}

              {(result.sourceExcerpt || result.translationExcerpt) && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 font-semibold">Source excerpt</h3>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
                      {result.sourceExcerpt ?? "Not retained for this mode"}
                    </pre>
                  </div>
                  <div>
                    <h3 className="mb-2 font-semibold">Translation excerpt</h3>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
                      {result.translationExcerpt ?? "Not available"}
                    </pre>
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-2 font-semibold">Evidence</h3>
                <div className="space-y-2">
                  {evidence.map((item, index) => (
                    <div
                      key={item.kind + index}
                      className="rounded border p-3 text-sm"
                    >
                      <Badge variant="outline">{item.kind}</Badge>
                      <p className="mt-2 text-slate-600">
                        {item.boundedSummary}
                      </p>
                    </div>
                  ))}
                  {evidence.length === 0 && (
                    <p className="text-sm text-slate-500">
                      No bounded evidence available.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid gap-2 rounded bg-slate-50 p-3 font-mono text-xs">
                <div>requestId={result.requestId}</div>
                <div>correlationId={result.correlationId}</div>
                <div>auditRef={result.auditRef}</div>
                <div>resultFingerprint={result.resultFingerprint}</div>
                <div>modelSet={result.modelSetVersion ?? "n/a"}</div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
