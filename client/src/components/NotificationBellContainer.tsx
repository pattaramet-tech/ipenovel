import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  createBulkOperationKeyManager,
  makeBulkOperationKey,
  type BulkActionKind,
} from "./bulkOperationKeys";
import {
  NotificationCenter,
  type NotificationFilter,
  type NotificationItem,
} from "./NotificationCenter";
import {
  NotificationPreferences,
  effectivePreference,
} from "./NotificationPreferences";
import type { NotificationKind } from "@shared/notificationKindCatalog";

/**
 * R40R58 LOCAL UI INTEGRATION GATE. The notification UI ships wired but
 * DEFAULT-OFF: it only renders in an environment that explicitly opts in at
 * build time (VITE_NOTIFICATIONS_UI_ENABLED=true). This is a UX gate only -
 * the server's protectedProcedure + notification gate remain the only
 * security boundary, and a hidden bell never means hidden API access.
 */
const UI_GATE = import.meta.env.VITE_NOTIFICATIONS_UI_ENABLED === "true";

const PAGE_SIZE = 20;

/**
 * Stable operation key for the mark-all/delete-all bulk API contract
 * (^[A-Za-z0-9_-]{8,96}$). Minted once per logical user action; a server
 * retry of the same operation reuses the key so a replay can never sweep a
 * second cutoff.
 */
// R40R59: bulk keys are PER ACTION KIND (the server's (actorUserId,
// operationKey) identity is kind-immutable - a cross-kind replay throws
// "kind mismatch"); retries of an uncertain outcome reuse the key, a
// confirmed success frees the kind for a fresh key, and an identity change
// drops every key. See bulkOperationKeys.ts + its unit tests.

/**
 * Authenticated container wiring the existing controlled NotificationCenter
 * presentation to the real server API. Server authority is absolute:
 *   - data comes only from trpc.notifications.* (never fabricated client
 *     data, never a locally computed unread count),
 *   - pagination is the server's signed cursor,
 *   - no optimistic mutation is ever shown as success before the server
 *     commits,
 *   - cached notification data is dropped whenever the signed-in identity
 *     changes (login, logout, account switch) so rows of one account are
 *     never rendered for another.
 * Opening an item marks it read only - the server publishes no navigation
 * target, and no URL is ever derived from event payloads.
 */
export function NotificationBellContainer() {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const identityKey = isAuthenticated ? `u${user?.id ?? "?"}` : "guest";
  const keyManager = useMemo(
    () => createBulkOperationKeyManager(kind => makeBulkOperationKey(kind, user?.id)),
    // re-created per identity so keys are never shared across accounts
    [user?.id]
  );

  // Identity changed (login, logout, account switch): drop every cached
  // notification query AND every pending bulk operation key so no account
  // ever replays another account's operation.
  useEffect(() => {
    queryClient.removeQueries({ queryKey: ["notifications"] });
    keyManager.reset();
  }, [identityKey, queryClient, keyManager]);

  const enabled = UI_GATE && isAuthenticated;

  const unread = trpc.notifications.unreadCount.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const list = trpc.notifications.list.useInfiniteQuery(
    { category: filter, limit: PAGE_SIZE },
    { enabled, refetchOnWindowFocus: false, retry: 1, getNextPageParam: lastPage => lastPage.nextCursor ?? undefined },
  );

  const items: readonly NotificationItem[] = useMemo(
    () =>
      (list.data ? list.data.pages.flatMap(page => page.items) : []).map(item => ({
        ...item,
        // over HTTP these arrive as JSON strings; the inferred server type is
        // Date - normalize both so the presentation contract holds
        createdAt:
          item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt),
        readAt:
          item.readAt === null || item.readAt === undefined
            ? null
            : item.readAt instanceof Date
              ? item.readAt.toISOString()
              : String(item.readAt),
      })),
    [list.data],
  );
  const loadError = unread.isError || list.isError ? "โหลดการแจ้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง" : null;

  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => {
      void unread.refetch();
      void list.refetch();
    },
  });
  const bulkMutation = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => {
      keyManager.confirmSuccess("mark_all_read");
      void unread.refetch();
      void list.refetch();
    },
  });
  const deleteAllMutation = trpc.notifications.deleteAll.useMutation({
    onSuccess: () => {
      keyManager.confirmSuccess("delete_all");
      void unread.refetch();
      void list.refetch();
    },
  });

  if (!enabled) return null;

  return (
    <NotificationCenter
      open={open}
      onOpenChange={next => {
        setOpen(next);
      }}
      items={items}
      activeFilter={filter}
      onFilterChange={next => {
        setFilter(next);
      }}
      hasMore={list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      onLoadMore={async () => {
        await list.fetchNextPage();
      }}
      unreadCount={unread.data ? unread.data.count : null}
      loading={unread.isLoading || list.isLoading}
      loadError={loadError}
      onRefresh={async () => {
        await Promise.all([unread.refetch(), list.refetch()]);
      }}
      onMarkRead={async id => {
        await markRead.mutateAsync({ id });
      }}
      onMarkAllRead={async () => {
        await bulkMutation.mutateAsync({ operationKey: keyManager.begin("mark_all_read") });
      }}
      onDeleteAll={async () => {
        await deleteAllMutation.mutateAsync({ operationKey: keyManager.begin("delete_all") });
      }}
      onOpenItem={async id => {
        // The server publishes no navigation target for inbox rows, so the
        // only approved "open" action is marking the row read. No URL is
        // ever derived from event payloads.
        await markRead.mutateAsync({ id });
      }}
    />
  );
}

/**
 * Authenticated container for the existing NotificationPreferences
 * presentation, bound to the real server preference API with the same
 * account-isolation rules as the bell. Render null when the UI gate is off
 * or the viewer is not signed in.
 */
export function NotificationPreferencesContainer() {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const identityKey = isAuthenticated ? `u${user?.id ?? "?"}` : "guest";

  useEffect(() => {
    queryClient.removeQueries({ queryKey: ["notifications"] });
  }, [identityKey, queryClient]);

  const enabled = UI_GATE && isAuthenticated;
  const preferences = trpc.notifications.preferences.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const setPreference = trpc.notifications.setPreference.useMutation({
    onSuccess: () => {
      void preferences.refetch();
    },
  });

  if (!enabled) return null;

  return (
    <NotificationPreferences
      values={preferences.data ?? null}
      isLoading={preferences.isLoading}
      error={preferences.isError ? "โหลดการตั้งค่าไม่สำเร็จ" : null}
      onUpdate={async (kind: NotificationKind, next: boolean) => {
        await setPreference.mutateAsync({ kind, enabled: next });
      }}
      onReload={async () => {
        await preferences.refetch();
      }}
    />
  );
}

/** Exposed for the acceptance tests: the build-time UI gate state. */
export function notificationUiGateEnabled(): boolean {
  return UI_GATE;
}

// Re-exported so the acceptance harness can assert effective defaults
// without reaching into the presentation component's internals.
export { effectivePreference };
