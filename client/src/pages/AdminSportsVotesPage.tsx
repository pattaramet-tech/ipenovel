import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { useLanguage } from "@/contexts/LanguageContext";
import { getCountdownText } from "@/lib/utils";
import { toast } from "sonner";
import { useMemo, useState } from "react";
import { AlertTriangle, Clock, Download, Eye, Plus, Trophy, Upload, Users } from "lucide-react";
import * as XLSX from "xlsx";

type RewardKind = "coupon" | "points";
type MatchStatus = "draft" | "open" | "closed";

type MatchForm = {
  title: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  coverImageUrl: string;
  matchStartAt: string;
  voteDeadlineAt: string;
  voteCostPoints: string;
  rewardKind: RewardKind;
  rewardPointsAmount: string;
  rewardDiscountType: "flat" | "percentage";
  rewardDiscountValue: string;
  rewardMinPurchaseAmount: string;
  rewardCouponExpiresAt: string;
  status: MatchStatus;
  isActive: boolean;
  displayOrder: string;
};

const emptyForm: MatchForm = {
  title: "",
  competitionId: "",
  homeTeamId: "",
  awayTeamId: "",
  homeTeamName: "",
  awayTeamName: "",
  coverImageUrl: "",
  matchStartAt: "",
  voteDeadlineAt: "",
  voteCostPoints: "10",
  rewardKind: "coupon",
  rewardPointsAmount: "10",
  rewardDiscountType: "flat",
  rewardDiscountValue: "10",
  rewardMinPurchaseAmount: "50",
  rewardCouponExpiresAt: "",
  status: "draft",
  isActive: true,
  displayOrder: "0",
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toLocalDateTimeValue(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function readCell(row: Record<string, any>, names: string[]): any {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
  }
  return undefined;
}

function parseSpreadsheetDate(value: any): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S));
  }
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeStatus(value: any): MatchStatus {
  const normalized = String(value ?? "draft").trim().toLowerCase();
  if (normalized === "open" || normalized === "เปิด") return "open";
  if (normalized === "closed" || normalized === "ปิด") return "closed";
  return "draft";
}

function normalizeRewardKind(value: any): RewardKind {
  const normalized = String(value ?? "coupon").trim().toLowerCase();
  return normalized === "points" || normalized === "point" || normalized === "แต้ม" ? "points" : "coupon";
}

function rewardDescription(match: any): string {
  if (match.rewardKind === "points") return `${Number(match.rewardPointsAmount || 0).toFixed(2)} points`;
  const value = Number(match.rewardDiscountValue || 0);
  return match.rewardDiscountType === "percentage" ? `${value}% coupon` : `฿${value.toFixed(2)} coupon`;
}

export default function AdminSportsVotesPage() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const utils = trpc.useUtils();

  const [form, setForm] = useState<MatchForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [settleResultById, setSettleResultById] = useState<Record<number, "home_win" | "draw" | "away_win">>({});
  const [settleConfirmId, setSettleConfirmId] = useState<number | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<number | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<number | null>(null);

  const [competitionForm, setCompetitionForm] = useState({ code: "", name: "", competitionType: "league" as "league" | "cup" });
  const [teamForm, setTeamForm] = useState({ code: "", name: "", logoImageUrl: "" });
  const [membershipCompetitionId, setMembershipCompetitionId] = useState("");
  const [membershipTeamId, setMembershipTeamId] = useState("");

  const [bulkCompetitionId, setBulkCompetitionId] = useState("");
  const [bulkRows, setBulkRows] = useState<any[]>([]);
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkErrors, setBulkErrors] = useState<Array<{ rowNumber: number; field: string; message: string }>>([]);
  const [updateTeamAssets, setUpdateTeamAssets] = useState(false);

  const enabled = !!user && user.role === "admin";
  const { data: matches = [], isLoading } = trpc.admin.sportsMatches.list.useQuery(undefined, { enabled });
  const { data: competitions = [] } = trpc.admin.sportsCompetitions.list.useQuery(undefined, { enabled });
  const { data: teams = [] } = trpc.admin.sportsTeams.list.useQuery(undefined, { enabled });

  const selectedCompetition = useMemo(
    () => competitions.find((competition: any) => String(competition.id) === form.competitionId),
    [competitions, form.competitionId]
  );
  const selectedCompetitionTeams = selectedCompetition?.teams ?? [];
  const membershipCompetition = competitions.find((competition: any) => String(competition.id) === membershipCompetitionId);

  const invalidateSportsAdmin = () => {
    utils.admin.sportsMatches.list.invalidate();
    utils.admin.sportsCompetitions.list.invalidate();
    utils.admin.sportsTeams.list.invalidate();
  };

  const createMutation = trpc.admin.sportsMatches.create.useMutation({
    onSuccess: () => {
      toast.success(t("common.success"));
      setForm(emptyForm);
      setEditingId(null);
      invalidateSportsAdmin();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });
  const updateMutation = trpc.admin.sportsMatches.update.useMutation({
    onSuccess: () => {
      toast.success(t("common.success"));
      setForm(emptyForm);
      setEditingId(null);
      invalidateSportsAdmin();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });
  const uploadMutation = trpc.admin.sportsMatches.uploadImage.useMutation({
    onError: (error) => toast.error(error.message || t("common.error")),
  });
  const settleMutation = trpc.admin.sportsMatches.settle.useMutation({
    onSuccess: (result) => {
      toast.success(`Match settled. Winners: ${result.winnerCount}${result.idempotent ? " (already settled)" : ""}`);
      invalidateSportsAdmin();
      utils.points.balance.invalidate();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });
  const cancelMutation = trpc.admin.sportsMatches.cancel.useMutation({
    onSuccess: (result) => {
      toast.success(`Match cancelled. Refunded: ${result.refundedCount}`);
      invalidateSportsAdmin();
    },
    onError: (error) => toast.error(error.message || t("common.error")),
  });
  const createCompetitionMutation = trpc.admin.sportsCompetitions.create.useMutation({
    onSuccess: () => {
      toast.success("Competition created");
      setCompetitionForm({ code: "", name: "", competitionType: "league" });
      utils.admin.sportsCompetitions.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateCompetitionMutation = trpc.admin.sportsCompetitions.update.useMutation({
    onSuccess: () => utils.admin.sportsCompetitions.list.invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const createTeamMutation = trpc.admin.sportsTeams.create.useMutation({
    onSuccess: () => {
      toast.success("Team created");
      setTeamForm({ code: "", name: "", logoImageUrl: "" });
      utils.admin.sportsTeams.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateTeamMutation = trpc.admin.sportsTeams.update.useMutation({
    onSuccess: () => invalidateSportsAdmin(),
    onError: (error) => toast.error(error.message),
  });
  const membershipMutation = trpc.admin.sportsCompetitionTeams.setMembership.useMutation({
    onSuccess: () => {
      toast.success("Competition membership updated");
      setMembershipTeamId("");
      utils.admin.sportsCompetitions.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkMutation = trpc.admin.sportsMatches.bulkCreate.useMutation({
    onSuccess: (result) => {
      if (!result.success) {
        setBulkErrors(result.errors);
        toast.error(`Import has ${result.errors.length} row validation error(s). Nothing was created.`);
        return;
      }
      setBulkErrors([]);
      setBulkRows([]);
      setBulkFileName("");
      toast.success(`Created ${result.createdCount} fixtures`);
      invalidateSportsAdmin();
    },
    onError: (error) => toast.error(error.message),
  });

  if (!isAuthenticated || user?.role !== "admin") {
    return <div className="min-h-screen flex items-center justify-center">Admin access required</div>;
  }

  const uploadImage = async (file: File): Promise<string | undefined> => {
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
      toast.error("Only JPG, PNG, or WEBP images are allowed");
      return undefined;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be 2MB or smaller");
      return undefined;
    }
    const fileBase64 = await fileToBase64(file);
    const uploaded = await uploadMutation.mutateAsync({ fileName: file.name, mimeType: file.type as any, fileBase64 });
    return uploaded.url;
  };

  const saveMatch = () => {
    if (!form.title || !form.voteDeadlineAt) {
      toast.error("Title and vote deadline are required");
      return;
    }
    if (!editingId && (!form.competitionId || !form.homeTeamId || !form.awayTeamId)) {
      toast.error("New matches must select a competition, home team, and away team from the catalog");
      return;
    }
    if (form.competitionId && (!form.homeTeamId || !form.awayTeamId)) {
      toast.error("Select both teams from the selected competition");
      return;
    }
    if (form.homeTeamId && form.homeTeamId === form.awayTeamId) {
      toast.error("Home and away team must be different");
      return;
    }
    const voteDeadlineAt = new Date(form.voteDeadlineAt);
    if (form.status === "open" && voteDeadlineAt.getTime() <= Date.now()) {
      toast.error("Deadline must be in the future for open matches");
      return;
    }

    const payload: any = {
      title: form.title,
      coverImageUrl: form.coverImageUrl || undefined,
      matchStartAt: form.matchStartAt ? new Date(form.matchStartAt) : undefined,
      voteDeadlineAt,
      voteCostPoints: form.voteCostPoints,
      rewardKind: form.rewardKind,
      rewardPointsAmount: form.rewardKind === "points" ? form.rewardPointsAmount : null,
      rewardDiscountType: form.rewardKind === "coupon" ? form.rewardDiscountType : null,
      rewardDiscountValue: form.rewardKind === "coupon" ? form.rewardDiscountValue : null,
      rewardMinPurchaseAmount: form.rewardKind === "coupon" ? form.rewardMinPurchaseAmount || "0" : null,
      rewardCouponExpiresAt: form.rewardKind === "coupon" && form.rewardCouponExpiresAt ? new Date(form.rewardCouponExpiresAt) : null,
      status: form.status,
      isActive: form.isActive,
      displayOrder: Number(form.displayOrder) || 0,
    };
    if (form.competitionId) {
      payload.competitionId = Number(form.competitionId);
      payload.homeTeamId = Number(form.homeTeamId);
      payload.awayTeamId = Number(form.awayTeamId);
    } else {
      payload.homeTeamName = form.homeTeamName;
      payload.awayTeamName = form.awayTeamName;
    }

    if (editingId) updateMutation.mutate({ matchId: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const loadMatchForEdit = (match: any) => {
    setEditingId(match.id);
    setForm({
      ...emptyForm,
      title: match.title ?? "",
      competitionId: match.competitionId ? String(match.competitionId) : "",
      homeTeamId: match.homeTeamId ? String(match.homeTeamId) : "",
      awayTeamId: match.awayTeamId ? String(match.awayTeamId) : "",
      homeTeamName: match.homeTeamName ?? "",
      awayTeamName: match.awayTeamName ?? "",
      coverImageUrl: match.coverImageUrl ?? "",
      matchStartAt: toLocalDateTimeValue(match.matchStartAt),
      voteDeadlineAt: toLocalDateTimeValue(match.voteDeadlineAt),
      voteCostPoints: String(match.voteCostPoints ?? "0"),
      rewardKind: match.rewardKind === "points" ? "points" : "coupon",
      rewardPointsAmount: String(match.rewardPointsAmount ?? "10"),
      rewardDiscountType: match.rewardDiscountType === "percentage" ? "percentage" : "flat",
      rewardDiscountValue: String(match.rewardDiscountValue ?? "10"),
      rewardMinPurchaseAmount: String(match.rewardMinPurchaseAmount ?? "0"),
      rewardCouponExpiresAt: toLocalDateTimeValue(match.rewardCouponExpiresAt),
      status: ["draft", "open", "closed"].includes(match.status) ? match.status : "closed",
      isActive: !!match.isActive,
      displayOrder: String(match.displayOrder ?? "0"),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleBulkFile = async (file: File) => {
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) throw new Error("Workbook has no sheets");
      const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[firstSheet], { defval: "" });
      const parsedRows = rawRows.map((row, index) => {
        const deadlineRaw = readCell(row, ["vote_deadline", "voteDeadlineAt", "ปิดโหวต", "เวลาปิดรับโหวต"]);
        const deadline = parseSpreadsheetDate(deadlineRaw);
        const matchStart = parseSpreadsheetDate(readCell(row, ["match_start", "matchStartAt", "เริ่มแข่ง", "เวลาแข่งขัน"]));
        const couponExpires = parseSpreadsheetDate(readCell(row, ["reward_coupon_expires_at", "rewardCouponExpiresAt", "คูปองหมดอายุ"]));
        if (!deadline) throw new Error(`Row ${index + 2}: invalid vote_deadline`);
        return {
          rowNumber: index + 2,
          title: String(readCell(row, ["title", "ชื่อแมตช์"]) ?? "").trim(),
          homeTeamRef: String(readCell(row, ["home_team", "homeTeamRef", "ทีมเหย้า"]) ?? "").trim(),
          awayTeamRef: String(readCell(row, ["away_team", "awayTeamRef", "ทีมเยือน"]) ?? "").trim(),
          homeTeamLogoUrl: String(readCell(row, ["home_team_logo_url", "homeTeamLogoUrl", "โลโก้ทีมเหย้า"]) ?? "").trim() || null,
          awayTeamLogoUrl: String(readCell(row, ["away_team_logo_url", "awayTeamLogoUrl", "โลโก้ทีมเยือน"]) ?? "").trim() || null,
          matchStartAt: matchStart ?? null,
          voteDeadlineAt: deadline,
          voteCostPoints: String(readCell(row, ["vote_cost_points", "voteCostPoints", "ค่าโหวต"]) ?? "0").trim(),
          rewardKind: normalizeRewardKind(readCell(row, ["reward_kind", "rewardKind", "ประเภทรางวัล"])),
          rewardPointsAmount: String(readCell(row, ["reward_points_amount", "rewardPointsAmount", "แต้มรางวัล"]) ?? "").trim() || null,
          rewardDiscountType: String(readCell(row, ["reward_discount_type", "rewardDiscountType", "ประเภทส่วนลด"]) ?? "flat").trim().toLowerCase() === "percentage" ? "percentage" as const : "flat" as const,
          rewardDiscountValue: String(readCell(row, ["reward_discount_value", "rewardDiscountValue", "มูลค่าส่วนลด"]) ?? "").trim() || null,
          rewardMinPurchaseAmount: String(readCell(row, ["reward_min_purchase_amount", "rewardMinPurchaseAmount", "ยอดขั้นต่ำ"]) ?? "0").trim(),
          rewardCouponExpiresAt: couponExpires ?? null,
          status: normalizeStatus(readCell(row, ["status", "สถานะ"])),
          displayOrder: Number(readCell(row, ["display_order", "displayOrder", "ลำดับ"]) ?? 0) || 0,
        };
      });
      setBulkRows(parsedRows);
      setBulkFileName(file.name);
      setBulkErrors([]);
      toast.success(`Loaded ${parsedRows.length} fixture rows`);
    } catch (error: any) {
      setBulkRows([]);
      setBulkFileName("");
      toast.error(error?.message || "Cannot parse spreadsheet");
    }
  };

  const downloadBulkTemplate = () => {
    const sheet = XLSX.utils.json_to_sheet([
      {
        title: "Premier League MD1",
        home_team: "ARS",
        away_team: "LIV",
        match_start: "2026-09-01T20:00:00+07:00",
        vote_deadline: "2026-09-01T19:55:00+07:00",
        vote_cost_points: "10",
        reward_kind: "points",
        reward_points_amount: "20",
        reward_discount_type: "",
        reward_discount_value: "",
        reward_min_purchase_amount: "",
        reward_coupon_expires_at: "",
        status: "open",
        display_order: 1,
        home_team_logo_url: "",
        away_team_logo_url: "",
      },
      {
        title: "Premier League MD1",
        home_team: "CHE",
        away_team: "MCI",
        match_start: "2026-09-01T22:00:00+07:00",
        vote_deadline: "2026-09-01T21:55:00+07:00",
        vote_cost_points: "10",
        reward_kind: "coupon",
        reward_points_amount: "",
        reward_discount_type: "flat",
        reward_discount_value: "10",
        reward_min_purchase_amount: "50",
        reward_coupon_expires_at: "2026-10-01T23:59:00+07:00",
        status: "draft",
        display_order: 2,
        home_team_logo_url: "",
        away_team_logo_url: "",
      },
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Fixtures");
    XLSX.writeFile(workbook, "sports_vote_fixtures_template.xlsx");
  };

  const filteredMatches = statusFilter === "all" ? matches : matches.filter((match: any) => match.status === statusFilter);
  const openCount = matches.filter((match: any) => match.status === "open").length;
  const totalVotes = matches.reduce((sum: number, match: any) => sum + Number(match.voteCount || 0), 0);

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 space-y-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2"><Trophy className="w-7 h-7" /> Sports Vote Admin</h1>
          <p className="text-slate-600 mt-1">Competition + reusable Team Catalog + League/Cup bulk fixtures + coupon/points rewards</p>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <Card><CardContent className="pt-6"><p className="text-sm text-slate-500">Competitions</p><p className="text-2xl font-bold">{competitions.length}</p></CardContent></Card>
          <Card><CardContent className="pt-6"><p className="text-sm text-slate-500">Open Matches</p><p className="text-2xl font-bold">{openCount}</p></CardContent></Card>
          <Card><CardContent className="pt-6"><p className="text-sm text-slate-500">Total Votes</p><p className="text-2xl font-bold">{totalVotes}</p></CardContent></Card>
        </div>

        <div className="grid xl:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle>1. Competition Catalog</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-[160px_1fr_160px_auto] gap-2">
                <Input placeholder="Code e.g. EPL" value={competitionForm.code} onChange={(e) => setCompetitionForm({ ...competitionForm, code: e.target.value })} />
                <Input placeholder="Competition name" value={competitionForm.name} onChange={(e) => setCompetitionForm({ ...competitionForm, name: e.target.value })} />
                <Select value={competitionForm.competitionType} onValueChange={(value: "league" | "cup") => setCompetitionForm({ ...competitionForm, competitionType: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="league">League</SelectItem><SelectItem value="cup">Cup</SelectItem></SelectContent>
                </Select>
                <Button disabled={!competitionForm.code || !competitionForm.name || createCompetitionMutation.isPending} onClick={() => createCompetitionMutation.mutate({ ...competitionForm, isActive: true })}><Plus className="w-4 h-4" /></Button>
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {competitions.map((competition: any) => (
                  <div key={competition.id} className="border rounded-lg p-3 flex items-center justify-between gap-3">
                    <div><p className="font-semibold">{competition.name} <span className="text-xs text-slate-500">({competition.code})</span></p><p className="text-xs text-slate-500">{competition.competitionType} · {competition.teams?.length || 0} teams</p></div>
                    <Button size="sm" variant="outline" onClick={() => updateCompetitionMutation.mutate({ competitionId: competition.id, isActive: !competition.isActive })}>{competition.isActive ? "Active" : "Inactive"}</Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>2. Canonical Team Catalog</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-[150px_1fr] gap-2">
                <Input placeholder="Code e.g. ARS" value={teamForm.code} onChange={(e) => setTeamForm({ ...teamForm, code: e.target.value })} />
                <Input placeholder="Team name" value={teamForm.name} onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })} />
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <Input className="max-w-xs" type="file" accept="image/jpeg,image/png,image/webp" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const url = await uploadImage(file); if (url) setTeamForm((prev) => ({ ...prev, logoImageUrl: url })); }} />
                <Button disabled={!teamForm.code || !teamForm.name || createTeamMutation.isPending} onClick={() => createTeamMutation.mutate({ ...teamForm, logoImageUrl: teamForm.logoImageUrl || null, isActive: true })}><Plus className="w-4 h-4 mr-1" />Create Team</Button>
                {teamForm.logoImageUrl && <span className="text-xs text-green-700">Logo ready</span>}
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {teams.map((team: any) => (
                  <div key={team.id} className="border rounded-lg p-2 flex items-center gap-3">
                    <img src={team.logoImageUrl || "/placeholder.svg"} className="w-9 h-9 object-contain rounded bg-slate-100" />
                    <div className="flex-1"><p className="font-medium text-sm">{team.name}</p><p className="text-xs text-slate-500">{team.code}</p></div>
                    <label className="cursor-pointer text-xs border rounded px-2 py-1 hover:bg-slate-50">
                      Replace logo
                      <input className="hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const url = await uploadImage(file); if (url) updateTeamMutation.mutate({ teamId: team.id, logoImageUrl: url }); }} />
                    </label>
                    <Button size="sm" variant="outline" onClick={() => updateTeamMutation.mutate({ teamId: team.id, isActive: !team.isActive })}>{team.isActive ? "Active" : "Inactive"}</Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Users className="w-5 h-5" />3. Competition Membership</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-[1fr_1fr_auto] gap-2">
              <Select value={membershipCompetitionId} onValueChange={setMembershipCompetitionId}>
                <SelectTrigger><SelectValue placeholder="Select competition" /></SelectTrigger>
                <SelectContent>{competitions.map((competition: any) => <SelectItem key={competition.id} value={String(competition.id)}>{competition.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={membershipTeamId} onValueChange={setMembershipTeamId}>
                <SelectTrigger><SelectValue placeholder="Select existing team" /></SelectTrigger>
                <SelectContent>{teams.filter((team: any) => !membershipCompetition?.teams?.some((member: any) => member.id === team.id)).map((team: any) => <SelectItem key={team.id} value={String(team.id)}>{team.name} ({team.code})</SelectItem>)}</SelectContent>
              </Select>
              <Button disabled={!membershipCompetitionId || !membershipTeamId} onClick={() => membershipMutation.mutate({ competitionId: Number(membershipCompetitionId), teamId: Number(membershipTeamId), isMember: true })}>Add Existing Team</Button>
            </div>
            {membershipCompetition && <div className="flex flex-wrap gap-2">{membershipCompetition.teams?.map((team: any) => <div key={team.id} className="border rounded-full px-3 py-1 flex items-center gap-2 text-sm"><img src={team.logoImageUrl || "/placeholder.svg"} className="w-5 h-5 object-contain" />{team.name}<button className="text-red-600" onClick={() => membershipMutation.mutate({ competitionId: membershipCompetition.id, teamId: team.id, isMember: false })}>×</button></div>)}</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{editingId ? `Edit Match #${editingId}` : "4. Create Match"}</CardTitle></CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div><label className="text-xs font-semibold">Title *</label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div>
              <label className="text-xs font-semibold">Competition *</label>
              <Select value={form.competitionId || undefined} onValueChange={(value) => setForm({ ...form, competitionId: value, homeTeamId: "", awayTeamId: "" })}>
                <SelectTrigger><SelectValue placeholder={editingId && !form.competitionId ? "Legacy match (no catalog link)" : "Select competition"} /></SelectTrigger>
                <SelectContent>{competitions.filter((competition: any) => competition.isActive).map((competition: any) => <SelectItem key={competition.id} value={String(competition.id)}>{competition.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {form.competitionId ? <>
              <div><label className="text-xs font-semibold">Home Team *</label><Select value={form.homeTeamId || undefined} onValueChange={(value) => setForm({ ...form, homeTeamId: value })}><SelectTrigger><SelectValue placeholder="Select from competition" /></SelectTrigger><SelectContent>{selectedCompetitionTeams.filter((team: any) => team.isActive && String(team.id) !== form.awayTeamId).map((team: any) => <SelectItem key={team.id} value={String(team.id)}>{team.name} ({team.code})</SelectItem>)}</SelectContent></Select></div>
              <div><label className="text-xs font-semibold">Away Team *</label><Select value={form.awayTeamId || undefined} onValueChange={(value) => setForm({ ...form, awayTeamId: value })}><SelectTrigger><SelectValue placeholder="Select from competition" /></SelectTrigger><SelectContent>{selectedCompetitionTeams.filter((team: any) => team.isActive && String(team.id) !== form.homeTeamId).map((team: any) => <SelectItem key={team.id} value={String(team.id)}>{team.name} ({team.code})</SelectItem>)}</SelectContent></Select></div>
            </> : editingId ? <div className="md:col-span-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm">Legacy fallback: {form.homeTeamName} vs {form.awayTeamName}. Select a competition above to migrate this match to catalog teams, or leave unchanged.</div> : null}
            <div><label className="text-xs font-semibold">Match Start</label><Input type="datetime-local" value={form.matchStartAt} onChange={(e) => setForm({ ...form, matchStartAt: e.target.value })} /></div>
            <div><label className="text-xs font-semibold">Vote Deadline *</label><Input type="datetime-local" value={form.voteDeadlineAt} onChange={(e) => setForm({ ...form, voteDeadlineAt: e.target.value })} /></div>
            <div><label className="text-xs font-semibold">Vote Cost (points)</label><Input value={form.voteCostPoints} onChange={(e) => setForm({ ...form, voteCostPoints: e.target.value })} /></div>
            <div><label className="text-xs font-semibold">Status</label><Select value={form.status} onValueChange={(value: MatchStatus) => setForm({ ...form, status: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Draft</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem></SelectContent></Select></div>
            <div><label className="text-xs font-semibold">Reward Kind</label><Select value={form.rewardKind} onValueChange={(value: RewardKind) => setForm({ ...form, rewardKind: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="coupon">Coupon</SelectItem><SelectItem value="points">Points</SelectItem></SelectContent></Select></div>
            {form.rewardKind === "points" ? <div><label className="text-xs font-semibold">Winner Points *</label><Input value={form.rewardPointsAmount} onChange={(e) => setForm({ ...form, rewardPointsAmount: e.target.value })} /></div> : <>
              <div><label className="text-xs font-semibold">Coupon Type</label><Select value={form.rewardDiscountType} onValueChange={(value: "flat" | "percentage") => setForm({ ...form, rewardDiscountType: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="flat">Flat amount</SelectItem><SelectItem value="percentage">Percentage</SelectItem></SelectContent></Select></div>
              <div><label className="text-xs font-semibold">Coupon Value</label><Input value={form.rewardDiscountValue} onChange={(e) => setForm({ ...form, rewardDiscountValue: e.target.value })} /></div>
              <div><label className="text-xs font-semibold">Min Purchase</label><Input value={form.rewardMinPurchaseAmount} onChange={(e) => setForm({ ...form, rewardMinPurchaseAmount: e.target.value })} /></div>
              <div><label className="text-xs font-semibold">Coupon Expiration</label><Input type="datetime-local" value={form.rewardCouponExpiresAt} onChange={(e) => setForm({ ...form, rewardCouponExpiresAt: e.target.value })} /></div>
            </>}
            <div><label className="text-xs font-semibold">Display Order</label><Input value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} /></div>
            <div><label className="text-xs font-semibold">Cover Image (optional, match-specific)</label><Input type="file" accept="image/jpeg,image/png,image/webp" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const url = await uploadImage(file); if (url) setForm((prev) => ({ ...prev, coverImageUrl: url })); }} /></div>
            <div className="md:col-span-2 flex gap-2"><Button onClick={saveMatch}>{editingId ? "Update Match" : "Create Match"}</Button>{editingId && <Button variant="outline" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel Edit</Button>}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Upload className="w-5 h-5" />5. League / Cup Bulk Fixture Import</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-600">Team references may be canonical team ID, team code, or an unambiguous team name. Known teams need no image columns. Unknown/ambiguous/non-member teams reject the whole batch with row-level errors.</p>
            <div className="grid md:grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <Select value={bulkCompetitionId} onValueChange={setBulkCompetitionId}><SelectTrigger><SelectValue placeholder="Competition for all imported fixtures" /></SelectTrigger><SelectContent>{competitions.filter((competition: any) => competition.isActive).map((competition: any) => <SelectItem key={competition.id} value={String(competition.id)}>{competition.name}</SelectItem>)}</SelectContent></Select>
              <Input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && handleBulkFile(e.target.files[0])} />
              <Button variant="outline" onClick={downloadBulkTemplate}><Download className="w-4 h-4 mr-1" />Template</Button>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={updateTeamAssets} onChange={(e) => setUpdateTeamAssets(e.target.checked)} />Explicitly update canonical team logos from optional logo URL columns. Off by default.</label>
            {bulkFileName && <p className="text-sm">Loaded: <b>{bulkFileName}</b> · {bulkRows.length} rows</p>}
            <Button disabled={!bulkCompetitionId || !bulkRows.length || bulkMutation.isPending} onClick={() => bulkMutation.mutate({ competitionId: Number(bulkCompetitionId), rows: bulkRows, updateTeamAssets })}>Import {bulkRows.length || ""} Fixtures</Button>
            {bulkErrors.length > 0 && <div className="border border-red-200 bg-red-50 rounded p-3 max-h-56 overflow-y-auto"><p className="font-semibold text-red-800 mb-2">Import rejected — no fixtures were created</p>{bulkErrors.map((error, index) => <p key={`${error.rowNumber}-${error.field}-${index}`} className="text-xs text-red-700">Row {error.rowNumber} · {error.field}: {error.message}</p>)}</div>}
          </CardContent>
        </Card>

        <div className="flex items-center gap-2"><span className="text-sm font-semibold">Filter:</span><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem><SelectItem value="settled">Settled</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></SelectContent></Select></div>

        <div className="grid lg:grid-cols-2 gap-4">
          {filteredMatches.map((match: any) => (
            <Card key={match.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex gap-3">
                  <img src={match.coverImageUrl || match.homeTeamImageUrl || "/placeholder.svg"} className="w-20 h-20 rounded-lg object-contain bg-slate-100" />
                  <div className="flex-1 min-w-0"><h3 className="font-bold truncate">{match.title}</h3><p className="text-sm text-slate-600">{match.homeTeamName} vs {match.awayTeamName}</p><p className="text-xs text-slate-500">{match.competitionName || match.leagueName || "Legacy"} · {match.status} · Votes {match.voteCount}</p><p className="text-xs text-indigo-700">Reward: {rewardDescription(match)}</p>{match.voteDeadlineAt && <div className="text-xs text-slate-500 flex items-center gap-1 mt-1"><Clock className="w-3 h-3" />{new Date(match.voteDeadlineAt).getTime() > Date.now() ? getCountdownText(match.voteDeadlineAt) : "Voting deadline passed"}</div>}{match.status === "open" && new Date(match.voteDeadlineAt).getTime() <= Date.now() && <div className="text-xs text-orange-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Ready to close or settle</div>}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => loadMatchForEdit(match)}>Edit</Button>
                  {match.status === "open" && <Button size="sm" variant="outline" onClick={() => setCloseConfirmId(match.id)}><Eye className="w-3 h-3 mr-1" />Close Vote</Button>}
                  <Select value={settleResultById[match.id] || "home_win"} onValueChange={(value: any) => setSettleResultById({ ...settleResultById, [match.id]: value })}><SelectTrigger className="w-36 h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="home_win">Home Win</SelectItem><SelectItem value="draw">Draw</SelectItem><SelectItem value="away_win">Away Win</SelectItem></SelectContent></Select>
                  <Button size="sm" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => setSettleConfirmId(match.id)}>Settle</Button>
                  <Button size="sm" variant="destructive" disabled={match.status === "settled" || match.status === "cancelled"} onClick={() => setCancelConfirmId(match.id)}>Cancel</Button>
                </div>

                <AlertDialog open={settleConfirmId === match.id} onOpenChange={(open) => !open && setSettleConfirmId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Settle Match?</AlertDialogTitle><AlertDialogDescription>Finalize the result and issue {match.rewardKind === "points" ? "points" : "coupon"} rewards to winners. Retrying the same settlement is idempotent.</AlertDialogDescription></AlertDialogHeader><div className="bg-blue-50 p-3 rounded text-sm"><b>{match.homeTeamName} vs {match.awayTeamName}</b><br />Result: {settleResultById[match.id] || "home_win"}<br />Reward: {rewardDescription(match)}</div><div className="flex gap-2 justify-end"><AlertDialogCancel>Back</AlertDialogCancel><AlertDialogAction onClick={() => { settleMutation.mutate({ matchId: match.id, result: settleResultById[match.id] || "home_win" }); setSettleConfirmId(null); }}>Settle</AlertDialogAction></div></AlertDialogContent></AlertDialog>
                <AlertDialog open={cancelConfirmId === match.id} onOpenChange={(open) => !open && setCancelConfirmId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel Match?</AlertDialogTitle><AlertDialogDescription>All pending votes will be refunded.</AlertDialogDescription></AlertDialogHeader><div className="flex gap-2 justify-end"><AlertDialogCancel>Back</AlertDialogCancel><AlertDialogAction className="bg-red-600" onClick={() => { cancelMutation.mutate({ matchId: match.id }); setCancelConfirmId(null); }}>Cancel Match</AlertDialogAction></div></AlertDialogContent></AlertDialog>
                <AlertDialog open={closeConfirmId === match.id} onOpenChange={(open) => !open && setCloseConfirmId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Close Voting?</AlertDialogTitle><AlertDialogDescription>Users will no longer be able to submit a prediction.</AlertDialogDescription></AlertDialogHeader><div className="flex gap-2 justify-end"><AlertDialogCancel>Back</AlertDialogCancel><AlertDialogAction onClick={() => { updateMutation.mutate({ matchId: match.id, status: "closed" }); setCloseConfirmId(null); }}>Close Voting</AlertDialogAction></div></AlertDialogContent></AlertDialog>
              </CardContent>
            </Card>
          ))}
        </div>
        {isLoading && <p>Loading...</p>}
      </div>
    </div>
  );
}
