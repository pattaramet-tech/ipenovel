/**
 * P2R3A pure comment-visibility projection (no DB, no I/O).
 *
 * Rules implemented (per the approved P2R2R2 design):
 *  - Roots render when `visible`, OR when hidden/deleted while still having
 *    at least one `visible` reply (the placeholder keeps the thread
 *    readable). A hidden/deleted root with no surviving visible reply does
 *    not appear at all.
 *  - Replies render only when `visible` and their parent renders on this
 *    page (normal root or placeholder root).
 *  - Placeholders NEVER carry message/author/timestamp - only id, status
 *    and placeholder:true - so hidden/deleted content and its author stay
 *    private.
 *  - Pagination is deterministic: roots ordered by id DESC, cursor = last
 *    root id of the page, replies per root by id ASC.
 *  - `pending` never renders in V1 (post-moderation creates comments as
 *    visible; no code path may produce a pending row).
 */
import type { CommentStatus } from "../../shared/engagement/contracts";

export interface CommentRecord {
  id: number;
  parentCommentId: number | null;
  authorUserId: number;
  message: string;
  status: CommentStatus;
  createdAt: string;
}

/** A rendered visible comment (full public projection). */
export interface VisibleCommentView {
  id: number;
  parentCommentId: number | null;
  authorUserId: number;
  message: string;
  createdAt: string;
  status: "visible";
  placeholder: false;
}

/**
 * A hidden/deleted parent kept only because visible replies still need
 * their thread anchor. Deliberately has NO message/author/timestamp.
 */
export interface PlaceholderCommentView {
  id: number;
  parentCommentId: number | null;
  status: "hidden" | "deleted";
  placeholder: true;
}

export type ThreadCommentView = VisibleCommentView | PlaceholderCommentView;

export interface VisibleThreadPage {
  roots: ThreadCommentView[];
  /** Replies grouped under each rendered root, keyed by root id, id ASC. */
  repliesByRootId: Record<number, ThreadCommentView[]>;
  /** Cursor for the next page (previous root id), null when exhausted. */
  nextCursor: number | null;
}

export interface ProjectThreadOptions {
  /** Exclusive upper-bound root cursor from the previous page (optional). */
  cursor?: number | null;
  /** Max rendered roots per page. */
  limit: number;
}

const PLACEHOLDER_STATUSES: ReadonlySet<CommentStatus> = new Set(["hidden", "deleted"] as const);

/**
 * Hard upper bound for rendered roots per page. Public callers pass a
 * limit; anything above this cap is a caller bug (or abuse) and fails
 * closed rather than being silently clamped, so paging behavior stays
 * explicit and predictable.
 */
export const MAX_THREAD_PAGE_SIZE = 50;

function assertSafePositiveInteger(name: string, value: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    // Also rejects NaN, +/-Infinity, fractional and unsafe integers.
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validatePageOptions(options: ProjectThreadOptions): void {
  assertSafePositiveInteger("limit", options.limit);
  if (options.limit > MAX_THREAD_PAGE_SIZE) {
    throw new Error(`limit must not exceed MAX_THREAD_PAGE_SIZE (${MAX_THREAD_PAGE_SIZE})`);
  }
  if (options.cursor !== null && options.cursor !== undefined) {
    assertSafePositiveInteger("cursor", options.cursor);
  }
}

/** Can this root comment render on a page at all? */
export function isRootRenderable(root: CommentRecord, hasVisibleReply: boolean): boolean {
  if (root.parentCommentId !== null) return false; // not a root
  if (root.status === "visible") return true;
  if (PLACEHOLDER_STATUSES.has(root.status)) return hasVisibleReply;
  return false; // pending never renders in V1
}

function toVisibleView(c: CommentRecord): VisibleCommentView {
  return {
    id: c.id,
    parentCommentId: c.parentCommentId,
    authorUserId: c.authorUserId,
    message: c.message,
    createdAt: c.createdAt,
    status: "visible",
    placeholder: false,
  };
}

function toPlaceholderView(root: CommentRecord): PlaceholderCommentView {
  // Intentionally minimal: no message, authorUserId, or createdAt.
  return {
    id: root.id,
    parentCommentId: root.parentCommentId,
    status: root.status as "hidden" | "deleted",
    placeholder: true,
  };
}

/**
 * Project one novel's comment records into a deterministic visible-thread
 * page. Input may contain any statuses and both roots and replies - the
 * projection decides what renders. Records are expected to belong to a
 * single novel; the caller enforces that at query time.
 */
export function projectVisibleThread(
  records: CommentRecord[],
  options: ProjectThreadOptions
): VisibleThreadPage {
  validatePageOptions(options);

  const roots = records.filter((r) => r.parentCommentId === null);
  const replies = records.filter((r) => r.parentCommentId !== null && r.status === "visible");

  const visibleReplyCountByRoot = new Map<number, number>();
  for (const reply of replies) {
    const parentId = reply.parentCommentId as number;
    visibleReplyCountByRoot.set(parentId, (visibleReplyCountByRoot.get(parentId) ?? 0) + 1);
  }

  // Deterministic candidate ordering regardless of input order: id DESC.
  const renderableRoots = roots
    .filter((r) => isRootRenderable(r, (visibleReplyCountByRoot.get(r.id) ?? 0) > 0))
    .filter((r) => (options.cursor == null ? true : r.id < options.cursor))
    .sort((a, b) => b.id - a.id)
    .slice(0, options.limit);

  const pageRootIds = new Set(renderableRoots.map((r) => r.id));

  const rootViews: ThreadCommentView[] = renderableRoots.map((r) =>
    r.status === "visible" ? toVisibleView(r) : toPlaceholderView(r)
  );

  const repliesByRootId: Record<number, ThreadCommentView[]> = {};
  for (const rootId of Array.from(pageRootIds)) repliesByRootId[rootId] = [];
  for (const reply of replies.sort((a, b) => a.id - b.id)) {
    const parentId = reply.parentCommentId as number;
    if (pageRootIds.has(parentId)) {
      repliesByRootId[parentId].push(toVisibleView(reply));
    }
    // Replies whose parent is NOT on this page are simply out of page
    // scope - they render on whichever page carries their parent.
  }

  const lastRoot = renderableRoots[renderableRoots.length - 1];
  const exhausted = renderableRoots.length < options.limit;
  return {
    roots: rootViews,
    repliesByRootId,
    nextCursor: exhausted || lastRoot === undefined ? null : lastRoot.id,
  };
}
