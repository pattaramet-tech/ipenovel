import React, { useState } from "react";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFERENCE_DESCRIPTIONS,
  type NotificationKind,
} from "@shared/notificationKindCatalog";
import { Button } from "@/components/ui/button";

export interface NotificationPreferencesProps {
  /** Null means not yet verified through authenticated API, not all false. */
  values: Partial<Record<NotificationKind, boolean>> | null;
  isLoading: boolean;
  error: string | null;
  onUpdate: (kind: NotificationKind, enabled: boolean) => Promise<void>;
  onReload: () => Promise<void>;
}

/** Display a preference only after the authenticated upstream query resolves. */
export function effectivePreference(
  values: Partial<Record<NotificationKind, boolean>> | null,
  kind: NotificationKind,
): boolean | null {
  if (values === null) return null;
  return typeof values[kind] === "boolean" ? values[kind]! : DEFAULT_NOTIFICATION_PREFERENCES[kind];
}

/**
 * Pure presentation. The server must verify ctx.user, stored preferences,
 * current session, and fanout opt-outs. This component never optimistically
 * checks/unchecked a setting before the server commits it.
 */
export function NotificationPreferences({
  values, isLoading, error, onUpdate, onReload,
}: NotificationPreferencesProps) {
  const [busyKind, setBusyKind] = useState<NotificationKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function change(kind: NotificationKind, enabled: boolean): Promise<void> {
    if (busyKind !== null || values === null || isLoading) return;
    setBusyKind(kind);
    setActionError(null);
    try {
      await onUpdate(kind, enabled);
    } catch {
      setActionError("บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <section aria-labelledby="notification-preferences-title" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="notification-preferences-title" className="font-semibold">ตั้งค่าการแจ้งเตือน</h2>
        <Button type="button" size="sm" variant="outline" disabled={isLoading || busyKind !== null}
          onClick={() => { void onReload().catch(() => setActionError("โหลดการตั้งค่าไม่สำเร็จ")); }}>
          รีเฟรช
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        การแจ้งเตือนเรื่องใหม่และเตือนเช็คอินปิดเป็นค่าเริ่มต้น เปิดรับได้ตามต้องการ
      </p>
      {(error || actionError) && (
        <p role="alert" className="text-sm text-destructive">
          {actionError || "ไม่สามารถโหลดการตั้งค่าการแจ้งเตือนได้"}
        </p>
      )}
      {values === null && isLoading && <p className="text-sm text-muted-foreground">กำลังโหลดการตั้งค่า…</p>}
      {(["finance", "novel", "engagement"] as const).map(group => (
        <fieldset key={group} className="space-y-2 rounded-lg border p-3"
          disabled={values === null || isLoading || busyKind !== null || Boolean(error)}>
          <legend className="px-1 text-sm font-medium">
            {group === "finance" ? "การเงินและคำสั่งซื้อ" : group === "novel" ? "นิยาย" : "กิจกรรม"}
          </legend>
          {NOTIFICATION_KINDS.filter(kind => NOTIFICATION_PREFERENCE_DESCRIPTIONS[kind].group === group)
            .map(kind => {
              const description = NOTIFICATION_PREFERENCE_DESCRIPTIONS[kind];
              const checked = effectivePreference(values, kind);
              return (
                <label key={kind} className="flex cursor-pointer items-start justify-between gap-3 rounded-md p-2 hover:bg-accent/30">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{description.label}</span>
                    <span className="block text-xs text-muted-foreground">{description.description}</span>
                  </span>
                  <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    name={kind} checked={checked ?? false} disabled={checked === null}
                    aria-label={description.label}
                    onChange={event => { void change(kind,event.target.checked); }} />
                </label>
              );
            })}
        </fieldset>
      ))}
    </section>
  );
}
