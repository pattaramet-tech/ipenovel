import React, { useState } from "react";
import { Bell, CheckCheck, RefreshCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type NotificationCategory = "finance" | "novel" | "engagement";
export type NotificationFilter = "all" | NotificationCategory;

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  summary: string;
  createdAt: string;
  readAt: string | null;
}

export function unreadBadgeText(count: number | null): string | null {
  if (count === null || !Number.isSafeInteger(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}
export function filterNotifications(
  items: readonly NotificationItem[],
  filter: NotificationFilter,
): NotificationItem[] {
  return items.filter(item => filter === "all" || item.category === filter);
}
/** A failed authenticated list fetch must not display cached rows from a prior session. */
export function safeNotificationItems(items: readonly NotificationItem[], loadError: string | null): readonly NotificationItem[] {
  return loadError === null ? items : [];
}
export interface NotificationCenterProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  items: readonly NotificationItem[];
  /** Parent queries the complete server-side category, not just a locally loaded page. */
  activeFilter: NotificationFilter;
  onFilterChange: (next: NotificationFilter) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  unreadCount: number | null;
  loading: boolean;
  loadError: string | null;
  onRefresh: () => Promise<void>;
  onMarkRead: (id: string) => Promise<void>;
  /** Authenticated API must operate on all pages/categories under one fixed actor-bound cutoff. */
  onMarkAllRead: () => Promise<void>;
  /** Dismiss only self-owned recipients, never the shared event or financial ledger. */
  onDeleteAll: () => Promise<void>;
  onOpenItem: (id: string) => Promise<void>;
}
const filters: readonly { kind: NotificationFilter; label: string }[] = [
  {kind:"all",label:"ทั้งหมด"}, {kind:"finance",label:"การเงิน"},
  {kind:"novel",label:"นิยาย"}, {kind:"engagement",label:"กิจกรรม"},
];

/**
 * Controlled UI only: parent owns server auth, durable operation key,
 * foreground revalidation and multi-session cache synchronization.
 * No optimistic count/list mutation and no automatic success report.
 */
export function NotificationCenter({
  open, onOpenChange, items, activeFilter, onFilterChange, hasMore, loadingMore, onLoadMore,
  unreadCount, loading, loadError, onRefresh, onMarkRead, onMarkAllRead, onDeleteAll, onOpenItem,
}: NotificationCenterProps) {
  // Filter and cursor are owned by the authenticated server query.
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const visible = safeNotificationItems(items, loadError);
  const badge = unreadBadgeText(unreadCount);

  async function execute(action: () => Promise<void>, closeConfirmation = false): Promise<void> {
    if (busy) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    setBusy(true);
    setOperationError(null);
    try {
      await action();
      if (closeConfirmation) setConfirmDelete(false);
      // The acted-on row (e.g. an item's อ่านแล้ว button) can unmount on the
      // post-action refetch, dropping focus to <body>; a modal dialog whose
      // focus escapes its content closes. Pull focus back into the dialog.
      if (previousFocus && !previousFocus.isConnected) contentRef.current?.focus();
    } catch {
      setOperationError("ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="icon" variant="ghost" className="relative"
        aria-haspopup="dialog" aria-expanded={open}
        aria-label={unreadCount === null ? "เปิดการแจ้งเตือน" : `เปิดการแจ้งเตือน มี ${unreadCount} รายการยังไม่อ่าน`}
        onClick={() => onOpenChange(true)}>
        <Bell className="h-5 w-5" aria-hidden="true" />
        {badge && <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full bg-destructive px-1 text-xs text-destructive-foreground">{badge}</span>}
      </Button>
      <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className="max-h-[90dvh] w-[min(100%,36rem)] overflow-y-auto"
          aria-describedby="notification-description"
          onFocusOutside={event => {
            // An acted-on row can unmount and momentarily drop focus to
            // <body>; Radix reads that as a focus-outside dismissal and
            // would close the whole inbox mid-task. Pointer-down outside,
            // Escape and the X button still close it normally.
            event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>การแจ้งเตือน</DialogTitle>
            <DialogDescription id="notification-description">
              {unreadCount === null ? "กำลังตรวจสอบรายการที่ยังไม่อ่าน" : `ยังไม่อ่าน ${unreadCount} รายการ`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2" role="group" aria-label="หมวดการแจ้งเตือน">
            {filters.map(({kind,label}) => <Button key={kind} type="button" size="sm"
              variant={activeFilter === kind ? "default" : "outline"} aria-pressed={activeFilter === kind} disabled={busy || loading}
              onClick={() => onFilterChange(kind)}>{label}</Button>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy || loading}
              onClick={() => { void execute(onRefresh); }}>
              <RefreshCcw className="mr-1 h-4 w-4" aria-hidden="true" />รีเฟรช
            </Button>
            <Button type="button" size="sm" variant="outline"
              disabled={busy || loading || unreadCount === null || unreadCount === 0}
              onClick={() => { void execute(onMarkAllRead); }}>
              <CheckCheck className="mr-1 h-4 w-4" aria-hidden="true" />อ่านทั้งหมด
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || loading || Boolean(loadError)}
              onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />ลบทั้งหมด
            </Button>
          </div>
          {(loadError || operationError) && <p role="alert" className="text-sm text-destructive">
            {operationError || "โหลดการแจ้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง"}
          </p>}
          <div aria-live="polite" className="max-h-[45dvh] space-y-2 overflow-y-auto">
            {loading ? <p className="text-sm text-muted-foreground">กำลังโหลด…</p> :
              !loadError && visible.length === 0 && !hasMore ? <p className="text-sm text-muted-foreground">ไม่มีรายการในหมวดนี้</p> :
              visible.map(item => <div key={item.id} className="flex items-start gap-2 rounded-lg border p-3">
                <button type="button" disabled={busy} className="min-w-0 flex-1 text-left focus-visible:outline-2"
                  onClick={() => { void execute(() => onOpenItem(item.id)); }}>
                  <span className={item.readAt ? "font-normal" : "font-semibold"}>{item.title}</span>
                  {!item.readAt && <span className="ml-2 text-xs text-primary">ยังไม่อ่าน</span>}
                  <p className="text-sm text-muted-foreground">{item.summary}</p>
                  <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"})}
                  </time>
                </button>
                {!item.readAt && <Button type="button" size="sm" variant="ghost" disabled={busy}
                  aria-label={`ทำเครื่องหมายอ่านแล้ว: ${item.title}`}
                  onClick={event => {
                    // the post-action refetch removes this button; blur first
                    // so focus never lands on <body> (a modal dialog whose
                    // focus escapes its content closes)
                    (event.currentTarget as HTMLElement).blur();
                    contentRef.current?.focus();
                    void execute(() => onMarkRead(item.id));
                  }}>อ่านแล้ว</Button>}
              </div>)}
          </div>
          {hasMore && !loadError && (
            <Button type="button" size="sm" variant="outline" disabled={busy || loading || loadingMore}
              onClick={() => { void execute(onLoadMore); }}>
              {loadingMore ? "กำลังโหลดเพิ่มเติม…" : "โหลดการแจ้งเตือนเพิ่มเติม"}
            </Button>
          )}

          <AlertDialog open={confirmDelete} onOpenChange={next => { if (!busy) setConfirmDelete(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ยืนยันลบการแจ้งเตือนทั้งหมด</AlertDialogTitle>
            <AlertDialogDescription>
              ลบรายการที่อ่านแล้วและยังไม่อ่านทุกหน้า ทุกหมวด ณ เวลายืนยัน
              ออกจากกล่องของคุณ โดยไม่ลบประวัติการเงิน ออเดอร์ หรือสิทธิ์การซื้อ
            </AlertDialogDescription>
          </AlertDialogHeader>
          {operationError && <p role="alert" className="text-sm text-destructive">{operationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>ยกเลิก</AlertDialogCancel>
            <AlertDialogAction disabled={busy}
              onClick={event => { event.preventDefault(); void execute(onDeleteAll,true); }}>
              ยืนยันลบทั้งหมด
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>

    </>
  );
}
