import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import {
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  ShoppingCart,
  History,
  Copy,
  Pencil,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { computePaginationClamp } from "./adminUsersPagination";

type SortColumn = "id" | "name" | "email" | "createdAt" | "lastSignedIn";
type SortOrder = "asc" | "desc";
type RoleFilter = "user" | "admin";
type GoogleFilter = "connected" | "not_connected";

type AdminUserRow = {
  id: number;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "user" | "admin";
  googleConnected: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
  lastSignedIn: string | Date;
};

const SEARCH_DEBOUNCE_MS = 350;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** th-TH, Asia/Bangkok - never the browser's local timezone, since an admin
 *  may be reviewing from anywhere. */
function formatBangkokDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function roleBadge(role: "user" | "admin") {
  return role === "admin" ? (
    <Badge className="bg-purple-100 text-purple-800">Admin</Badge>
  ) : (
    <Badge className="bg-slate-100 text-slate-700">User</Badge>
  );
}

function googleBadge(connected: boolean) {
  return connected ? (
    <Badge className="bg-green-100 text-green-800">Connected</Badge>
  ) : (
    <Badge className="bg-slate-100 text-slate-500">Not connected</Badge>
  );
}

export default function AdminUsersPage() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // ---- List state ----
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter | "">("");
  const [googleFilter, setGoogleFilter] = useState<GoogleFilter | "">("");
  const [sortBy, setSortBy] = useState<SortColumn>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, roleFilter, googleFilter, sortBy, sortOrder, pageSize]);

  const queryInput = useMemo(
    () => ({
      page,
      pageSize,
      search: debouncedSearch || undefined,
      role: roleFilter || undefined,
      googleConnection: googleFilter || undefined,
      sortBy,
      sortOrder,
    }),
    [page, pageSize, debouncedSearch, roleFilter, googleFilter, sortBy, sortOrder]
  );

  const { data, isLoading, isError, refetch } = trpc.admin.users.list.useQuery(queryInput);
  const rows: AdminUserRow[] = data?.users ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // PR #45 review finding "Reset pages that become out of range": an edit
  // (e.g. a role change) can shrink the filtered result set enough that
  // `page` - state the admin was already viewing - is no longer valid for
  // the freshly-invalidated query's own totalPages (most commonly: the
  // sole row on the last page is edited off the current filter, leaving
  // an empty page with no way back to page 1 without touching another
  // filter). This clamps `page` back into range whenever the server's
  // totalPages changes under it - see computePaginationClamp's own
  // docstring for why this can never loop (it only ever calls setPage
  // when the page actually needs to change, never redundantly). Waits
  // for a real response (`data !== undefined`) so it never fires against
  // the initial loading state.
  useEffect(() => {
    if (data === undefined) return;
    const decision = computePaginationClamp(page, data.totalPages);
    if (decision.shouldUpdate) {
      setPage(decision.nextPage);
    }
  }, [data?.totalPages, page]);

  const handleSort = (column: SortColumn) => {
    if (sortBy === column) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
  };

  const sortIndicator = (column: SortColumn) => {
    if (sortBy !== column) return "↕";
    return sortOrder === "asc" ? "↑" : "↓";
  };

  const handleCopyId = async (userId: number) => {
    try {
      await navigator.clipboard.writeText(String(userId));
      toast.success(`Copied User ID ${userId}`);
    } catch {
      toast.error("Failed to copy User ID");
    }
  };

  // ---- Edit dialog ----
  const [editingUser, setEditingUser] = useState<AdminUserRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<"user" | "admin">("user");
  const [editReason, setEditReason] = useState("");
  const [editConfirmText, setEditConfirmText] = useState("");

  const openEditDialog = (row: AdminUserRow) => {
    setEditingUser(row);
    setEditName(row.name ?? "");
    setEditRole(row.role);
    setEditReason("");
    setEditConfirmText("");
  };

  const closeEditDialog = () => setEditingUser(null);

  const updateMutation = trpc.admin.users.update.useMutation({
    onSuccess: () => {
      toast.success("บันทึกการแก้ไขสำเร็จ");
      closeEditDialog();
      utils.admin.users.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "แก้ไขข้อมูลไม่สำเร็จ");
    },
  });

  const editNameChanged = editingUser !== null && editName.trim() !== (editingUser.name ?? "").trim();
  const editRoleChanged = editingUser !== null && editRole !== editingUser.role;
  const editHasChanges = editNameChanged || editRoleChanged;
  const editExpectedConfirmText = editingUser ? `CHANGE ROLE ${editingUser.id}` : "";

  const handleSubmitEdit = () => {
    if (!editingUser) return;
    if (!editHasChanges) {
      toast.error("ไม่มีการเปลี่ยนแปลงข้อมูล");
      return;
    }
    if (editReason.trim().length < 5) {
      toast.error("กรุณากรอกเหตุผล (อย่างน้อย 5 ตัวอักษร)");
      return;
    }
    if (editRoleChanged && editConfirmText !== editExpectedConfirmText) {
      toast.error(`กรุณาพิมพ์ "${editExpectedConfirmText}" เพื่อยืนยัน`);
      return;
    }

    updateMutation.mutate({
      userId: editingUser.id,
      name: editNameChanged ? (editName.trim() === "" ? null : editName.trim()) : undefined,
      role: editRoleChanged ? editRole : undefined,
      reason: editReason.trim(),
      confirmText: editRoleChanged ? editConfirmText : undefined,
    });
  };

  // Hard delete is DELIBERATELY NOT offered on this page yet - PR #45
  // security review finding: the server-side transaction only locks the
  // target `users` row, which cannot stop a concurrent write to any of the
  // (mostly foreign-key-free) business tables it checks from racing past
  // the safety assessment. See server/routers.ts's admin.users router for
  // the full rationale. admin.users.delete / .deleteAssessment do not exist
  // as callable procedures right now - there is no button here to remove
  // this comment for; when the concurrency gap is closed, the delete flow
  // is added back deliberately, not restored by uncommenting old code.

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-slate-600">Total: {total} users</p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by ID, name, or email..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={roleFilter === "admin" ? "default" : "outline"}
              onClick={() => setRoleFilter(roleFilter === "admin" ? "" : "admin")}
              className="text-xs"
            >
              Admin
            </Button>
            <Button
              size="sm"
              variant={roleFilter === "user" ? "default" : "outline"}
              onClick={() => setRoleFilter(roleFilter === "user" ? "" : "user")}
              className="text-xs"
            >
              User
            </Button>
          </div>

          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={googleFilter === "connected" ? "default" : "outline"}
              onClick={() => setGoogleFilter(googleFilter === "connected" ? "" : "connected")}
              className="text-xs"
            >
              Google Connected
            </Button>
            <Button
              size="sm"
              variant={googleFilter === "not_connected" ? "default" : "outline"}
              onClick={() => setGoogleFilter(googleFilter === "not_connected" ? "" : "not_connected")}
              className="text-xs"
            >
              Not Connected
            </Button>
          </div>

          {(roleFilter || googleFilter) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              onClick={() => {
                setRoleFilter("");
                setGoogleFilter("");
              }}
            >
              Clear Filters
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-600">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v) as 20 | 50 | 100)}>
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Loading / Error / Empty / Table */}
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : isError ? (
          <Card className="p-8 text-center">
            <p className="text-red-600 mb-3">โหลดข้อมูลผู้ใช้ไม่สำเร็จ</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              ลองใหม่
            </Button>
          </Card>
        ) : rows.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No users found</p>
          </Card>
        ) : (
          <>
            <div
              className="max-w-full overflow-x-auto rounded-lg border border-slate-200"
              role="region"
              aria-label="Users table"
              tabIndex={0}
            >
              <table className="w-full min-w-[64rem] text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th
                      className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100"
                      onClick={() => handleSort("id")}
                    >
                      ID {sortIndicator("id")}
                    </th>
                    <th
                      className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100"
                      onClick={() => handleSort("name")}
                    >
                      Name / Email {sortIndicator("name")}
                    </th>
                    <th className="text-left p-3 font-semibold">Role</th>
                    <th className="text-left p-3 font-semibold">Login Method</th>
                    <th className="text-left p-3 font-semibold">Google</th>
                    <th
                      className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100"
                      onClick={() => handleSort("createdAt")}
                    >
                      Registered {sortIndicator("createdAt")}
                    </th>
                    <th
                      className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100"
                      onClick={() => handleSort("lastSignedIn")}
                    >
                      Last Sign-in {sortIndicator("lastSignedIn")}
                    </th>
                    <th className="text-left p-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b hover:bg-slate-50">
                      <td className="p-3 text-slate-600">{row.id}</td>
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{row.name || "—"}</div>
                        <div className="text-xs text-slate-500">{row.email || "—"}</div>
                      </td>
                      <td className="p-3">{roleBadge(row.role)}</td>
                      <td className="p-3 text-slate-600 text-xs">{row.loginMethod || "—"}</td>
                      <td className="p-3">{googleBadge(row.googleConnected)}</td>
                      <td className="p-3 text-slate-600 text-xs">{formatBangkokDate(row.createdAt)}</td>
                      <td className="p-3 text-slate-600 text-xs">{formatBangkokDate(row.lastSignedIn)}</td>
                      <td className="p-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/admin/orders?userId=${row.id}`)}>
                              <ShoppingCart className="w-4 h-4 mr-2" />
                              ดูออเดอร์
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/admin/topup-logs?userId=${row.id}`)}>
                              <History className="w-4 h-4 mr-2" />
                              ดูประวัติเติมเงิน
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleCopyId(row.id)}>
                              <Copy className="w-4 h-4 mr-2" />
                              คัดลอก User ID
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEditDialog(row)}>
                              <Pencil className="w-4 h-4 mr-2" />
                              แก้ไข
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-slate-600">
                Page {page} of {totalPages} ({total} total users)
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={editingUser !== null} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>แก้ไขผู้ใช้ #{editingUser?.id}</DialogTitle>
          </DialogHeader>
          {editingUser && (
            <div className="space-y-4">
              <div>
                <Label>User ID</Label>
                <p className="text-sm text-slate-700 mt-1">{editingUser.id}</p>
              </div>
              <div>
                <Label>Email (read-only)</Label>
                <p className="text-sm text-slate-700 mt-1">{editingUser.email || "—"}</p>
              </div>
              <div>
                <Label>Google Connection (read-only)</Label>
                <div className="mt-1">{googleBadge(editingUser.googleConnected)}</div>
              </div>
              <div>
                <Label htmlFor="edit-name">Name</Label>
                <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="edit-role">Role</Label>
                <Select value={editRole} onValueChange={(v) => setEditRole(v as "user" | "admin")}>
                  <SelectTrigger id="edit-role" className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editRoleChanged && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <p className="mb-2">
                    กำลังเปลี่ยน Role จาก <strong>{editingUser.role}</strong> เป็น <strong>{editRole}</strong>
                  </p>
                  <Label htmlFor="edit-confirm" className="text-amber-900">
                    พิมพ์ "{editExpectedConfirmText}" เพื่อยืนยัน
                  </Label>
                  <Input
                    id="edit-confirm"
                    value={editConfirmText}
                    onChange={(e) => setEditConfirmText(e.target.value)}
                    className="mt-1 bg-white"
                    placeholder={editExpectedConfirmText}
                  />
                </div>
              )}

              <div>
                <Label htmlFor="edit-reason">เหตุผล (Reason)</Label>
                <Textarea
                  id="edit-reason"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  className="mt-1"
                  rows={3}
                  placeholder="ระบุเหตุผลในการแก้ไข (5-500 ตัวอักษร)"
                />
              </div>

              {editHasChanges && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <p className="font-semibold mb-1">สรุปการเปลี่ยนแปลง:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {editNameChanged && <li>Name: "{editingUser.name || "—"}" → "{editName.trim() || "—"}"</li>}
                    {editRoleChanged && (
                      <li>
                        Role: {editingUser.role} → {editRole}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeEditDialog} disabled={updateMutation.isPending}>
              ยกเลิก
            </Button>
            <Button onClick={handleSubmitEdit} disabled={!editHasChanges || updateMutation.isPending}>
              {updateMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              บันทึก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
