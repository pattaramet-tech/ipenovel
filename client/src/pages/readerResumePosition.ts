/**
 * Reader resume-position support logic, kept DOM-free (storage is injected)
 * so it can be unit-tested in the node environment like the other pure
 * client modules (see readerChromePresentation.ts).
 *
 * Responsibilities split out of ReaderPage.tsx:
 * - Local recovery records in localStorage, namespaced per user AND episode,
 *   so closing the app before the saveProgress mutation lands never loses
 *   the position (and two users sharing a device never see each other's).
 * - Deciding which resume source wins when the server position (possibly
 *   written from another device) and the local recovery record disagree:
 *   newest wins, so a stale local record can never overwrite newer
 *   cross-device data (and vice versa).
 * - The skip-save gate. The old percent-only check (<1% == skip) dropped
 *   real movement on long packages, where 1% of scrollHeight is thousands
 *   of pixels - the scrollTop delta closes that hole.
 * - Mapping a chosen position onto a concrete scroll plan: exact scrollTop
 *   first, chapter anchor as fallback when the pixel position can't be
 *   honored (container not measurable / clamped away / layout changed).
 */

export interface ReadingPositionSnapshot {
  /** 0..100 progress through the episode content. */
  percent: number;
  /** Pixel scrollTop within the reader's scroll container. */
  scrollTop: number;
  chapterNumber: string | null;
  chapterTitle: string | null;
  anchorId: string | null;
}

export interface ReadingRecoveryRecord extends ReadingPositionSnapshot {
  /** Epoch ms (client clock) at the moment the record was written. */
  savedAt: number;
}

/** Shape returned by reader.getProgress (subset - all fields optional-safe). */
export interface ServerReadingProgress {
  progressPercent: number;
  scrollPosition?: number | null;
  currentChapterNumber?: string | null;
  currentChapterTitle?: string | null;
  anchorKey?: string | null;
  lastReadAt?: string | Date | null;
}

export type ResumeSource =
  | { origin: "server"; snapshot: ReadingPositionSnapshot; at: number }
  | { origin: "local"; snapshot: ReadingPositionSnapshot; at: number };

const RECOVERY_STORAGE_PREFIX = "ipe.readerResume.v1";

/**
 * Minimum scrollTop movement (px) that counts as "position changed" even
 * when the percent delta is below MIN_PERCENT_DELTA_TO_SAVE. A couple of
 * text lines - small on screen, but on a long package it's a position the
 * reader genuinely expects to come back to.
 */
export const MIN_SCROLL_DELTA_TO_SAVE_PX = 48;

/**
 * Clock-skew tolerance for server-vs-local merge. Server lastReadAt and the
 * local savedAt come from different clocks; when they're within this window
 * the local record wins (it is this device's own freshest position). Only a
 * server position newer by more than the tolerance - i.e. genuinely written
 * from elsewhere after this device's last write - overrides local.
 */
export const RESUME_MERGE_SKEW_TOLERANCE_MS = 30_000;

export interface SavedProgressMark {
  percent: number;
  scrollTop: number;
  chapterNumber: string | null;
}

export function readingRecoveryStorageKey(userId: string | number, episodeId: number): string {
  return `${RECOVERY_STORAGE_PREFIX}.u${userId}.e${episodeId}`;
}

const finiteNumber = (value: unknown, min: number, max: number): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Parse and validate a recovery record from localStorage. Any corruption
 * (missing/corrupt JSON, out-of-range numbers, wrong shape) yields null so
 * callers fall back to the server position instead of a half-usable record.
 */
export function parseReadingRecoveryRecord(raw: string | null): ReadingRecoveryRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const percent = finiteNumber(record.percent, 0, 100);
  const scrollTop = finiteNumber(record.scrollTop, 0, Number.MAX_SAFE_INTEGER);
  const savedAt = finiteNumber(record.savedAt, 1, Number.MAX_SAFE_INTEGER);
  if (percent === null || scrollTop === null || savedAt === null) return null;

  return {
    percent,
    scrollTop,
    chapterNumber: stringOrNull(record.chapterNumber),
    chapterTitle: stringOrNull(record.chapterTitle),
    anchorId: stringOrNull(record.anchorId),
    savedAt,
  };
}

export function readReadingRecovery(
  storage: Pick<Storage, "getItem"> | null | undefined,
  userId: string | number,
  episodeId: number
): ReadingRecoveryRecord | null {
  if (!storage) return null;
  try {
    return parseReadingRecoveryRecord(storage.getItem(readingRecoveryStorageKey(userId, episodeId)));
  } catch {
    return null;
  }
}

/**
 * Safe localStorage access. Touching window.localStorage ITSELF throws
 * SecurityError in some hardened WebViews / old private modes (not just the
 * getItem/setItem calls) - every reader access must go through this so a
 * locked-down storage degrades to "no local recovery", never a crash.
 */
export function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function toRecoveryRecord(snapshot: ReadingPositionSnapshot, now: number): ReadingRecoveryRecord {
  return { ...snapshot, savedAt: now };
}

/**
 * Persist a recovery record. Returns whether the write landed - private
 * mode / quota-exceeded storage throws, and the reader must keep working
 * (just without the local safety net) in that case.
 */
export function writeReadingRecovery(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  userId: string | number,
  episodeId: number,
  snapshot: ReadingPositionSnapshot
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      readingRecoveryStorageKey(userId, episodeId),
      JSON.stringify(toRecoveryRecord(snapshot, Date.now()))
    );
    return true;
  } catch {
    return false;
  }
}

export function serverProgressToSnapshot(server: ServerReadingProgress): ReadingPositionSnapshot {
  return {
    percent: finiteNumber(server.progressPercent, 0, 100) ?? 0,
    scrollTop: finiteNumber(server.scrollPosition, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    chapterNumber: stringOrNull(server.currentChapterNumber),
    chapterTitle: stringOrNull(server.currentChapterTitle),
    anchorId: stringOrNull(server.anchorKey),
  };
}

/** Date instance / ISO string / junk -> epoch ms (0 when unusable). */
export function parseServerLastReadAt(value: string | Date | null | undefined): number {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof value === "string" && value.length > 0) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * Pick the resume source when both a server position and a local recovery
 * record exist. Newest wins, with the skew tolerance above; exact ties also
 * go to local (this device's exact pixel position beats a server copy of
 * the same moment). A server position with no usable lastReadAt only wins
 * when there is no local record at all. A local record stamped in the
 * FUTURE (device clock skewed forward) is treated as unreliable evidence -
 * it must not shadow a server position without trustworthy proof of being
 * newer.
 */
export function mergeResumeSource(
  server: ServerReadingProgress | null | undefined,
  local: ReadingRecoveryRecord | null,
  now: number = Date.now()
): ResumeSource | null {
  if (!server && !local) return null;
  if (server && !local) {
    return { origin: "server", snapshot: serverProgressToSnapshot(server), at: parseServerLastReadAt(server.lastReadAt) };
  }
  if (!server && local) {
    return { origin: "local", snapshot: local, at: local.savedAt };
  }
  // both present (non-null asserted via the guards above)
  const s = server as ServerReadingProgress;
  const l = local as ReadingRecoveryRecord;
  const serverAt = parseServerLastReadAt(s.lastReadAt);
  const localStampedInFuture = l.savedAt - now > RESUME_MERGE_SKEW_TOLERANCE_MS;
  if (serverAt - l.savedAt > RESUME_MERGE_SKEW_TOLERANCE_MS || (localStampedInFuture && serverAt > 0)) {
    return { origin: "server", snapshot: serverProgressToSnapshot(s), at: serverAt };
  }
  return { origin: "local", snapshot: l, at: l.savedAt };
}

/**
 * Whether there is anything worth resuming to. Deliberately broader than
 * "percent > 0": legacy rows can carry progressPercent 0 with a real saved
 * scrollPosition, and a package position may be chapter-only. All-zero
 * records (episode opened, never scrolled) are NOT resumable.
 */
export function hasResumablePosition(snapshot: ReadingPositionSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return (
    snapshot.percent > 0 ||
    snapshot.scrollTop > 0 ||
    snapshot.anchorId !== null ||
    snapshot.chapterNumber !== null
  );
}

export interface ShouldSkipSaveOptions {
  /** Critical flushes (visibilitychange hidden / pagehide / retry) never skip. */
  force?: boolean;
  /** Percent-delta threshold; defaults to 1 point. */
  minPercentDelta?: number;
}

/**
 * Whether a pending save can be dropped as a near-duplicate of the last
 * ACCEPTED save. Skips only when the chapter is unchanged AND the percent
 * delta is under the threshold AND the scrollTop delta is under
 * MIN_SCROLL_DELTA_TO_SAVE_PX.
 */
export function shouldSkipProgressSave(
  last: SavedProgressMark | null,
  pending: ReadingPositionSnapshot,
  options?: ShouldSkipSaveOptions
): boolean {
  if (options?.force) return false;
  if (!last) return false;
  if (last.chapterNumber !== pending.chapterNumber) return false;
  const minPercentDelta = options?.minPercentDelta ?? 1;
  if (Math.abs(last.percent - pending.percent) >= minPercentDelta) return false;
  if (Math.abs(last.scrollTop - pending.scrollTop) >= MIN_SCROLL_DELTA_TO_SAVE_PX) return false;
  return true;
}

/** Clamp a saved scrollTop into the container's currently scrollable range. */
export function clampScrollTop(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(max, Math.max(0, scrollTop));
}

export type ResumeScrollPlan =
  | { kind: "scrollTop"; value: number }
  | { kind: "anchor"; anchorId: string }
  | { kind: "chapter"; chapterNumber: string }
  | { kind: "none" };

/**
 * Decide HOW to restore a chosen position: the exact scroll offset first
 * (what the reader actually saw), chapter anchor second (robust to layout
 * changes - font size, banner, images loading), chapter number last (TOC
 * lookup by the caller). metrics null = container not measurable yet.
 */
export function resolveResumeScrollPlan(
  chosen: ReadingPositionSnapshot,
  metrics: { scrollHeight: number; clientHeight: number } | null
): ResumeScrollPlan {
  if (metrics && chosen.scrollTop > 0) {
    const clamped = clampScrollTop(chosen.scrollTop, metrics.scrollHeight, metrics.clientHeight);
    if (clamped > 0) return { kind: "scrollTop", value: clamped };
    // clamped to 0 = content currently fits one screen; a saved offset from
    // a larger layout is meaningless here, fall through to anchors.
  }
  if (chosen.anchorId) return { kind: "anchor", anchorId: chosen.anchorId };
  if (chosen.chapterNumber) return { kind: "chapter", chapterNumber: chosen.chapterNumber };
  return { kind: "none" };
}

/**
 * Backoff for retrying a failed saveProgress mutation: 2s, 6s, 18s, then
 * capped at 30s. Reset to the start of the sequence on any success.
 */
export function progressSaveRetryDelayMs(consecutiveFailures: number): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  return Math.min(30_000, 2_000 * Math.pow(3, n));
}

// ============================================================================
// Progress-save controller
// ----------------------------------------------------------------------------
// Owns the entire save lifecycle OUTSIDE React so its behavior cannot be
// perturbed by re-renders (the old wiring depended on the tRPC mutation
// RESULT object, whose identity changes every render - that churned the
// effect dependencies and tore down a freshly-armed scroll debounce on
// every setLivePercent re-render). Invariants, all unit-tested:
//
//  - Single flight: at most one saveProgress mutation airborne; later
//    flushes are queued (tagged with their asking generation, upgrading to
//    force) and re-flushed on settle, so a slow OLD save can never land
//    after a NEW one (server is last-write-wins).
//  - Generation fencing: reset()/dispose() bump a generation. Callbacks of
//    an airborne flight belonging to an older generation never touch marks,
//    timers, or the queue. A stale flight's settle serves a CURRENT-
//    generation queue only, re-dispatching through the CURRENT context -
//    so episode B's queued save fires right after A's flight lands,
//    without the user scrolling again, and never under A's context.
//  - Backoff: failures retry via 2s/6s/18s/30s; while the retry timer runs,
//    ordinary (debounce/periodic) flushes are held back - only forced
//    lifecycle flushes pass. A same-generation queued immediate re-flush
//    only runs after a SUCCESSFUL flight (a failed one lets the retry
//    timer own the follow-up - no hot loop while offline).
//  - Success-only marking: lastMark updates in onSuccess only, so failed
//    saves are never deduped away and the retry still passes the gate.
//  - dispose(): best-effort force flush (with an explicit context override,
//    because at cleanup time refs may already point at the NEXT episode),
//    then reset. If the outgoing episode's save is still airborne, its
//    LATEST position is parked as an outgoing handoff - ONE slot per
//    episode+user (latest wins within an episode, FIFO across episodes,
//    bounded overall), so navigating A -> B -> C during one airborne flight
//    loses neither A's nor B's handoff. Handoffs fire as background
//    flights as settles free the slot - ordered before the new
//    generation's saves, under the outgoing context, only while the
//    session user is still the same (a user switch drops it: local
//    recovery already holds it, and sending it under the new user's
//    session would be a cross-user write), and only if no NEWER save of
//    the same episode has already been confirmed (staleness ruler - an
//    old handoff, including its bounded isolated retry, can never
//    overwrite a newer confirmed position). Background retries are
//    ISOLATED from the foreground backoff (separate timer/state, capped at
//    MAX_BACKGROUND_HANDOFF_RETRIES) and never hold or drop the current
//    generation's queue. KNOWN LIMIT: if the app closes before the
//    airborne flight settles, the handoff never fires - the server keeps
//    the older position while this device's local recovery holds the
//    newest one (other devices see the old position until this device
//    re-opens the episode and saves again).
// ============================================================================

export interface ProgressSaveContext {
  episodeId: number;
  userId: string | number | null;
  enabled: boolean;
}

export interface ProgressSaveInput {
  episodeId: number;
  progressPercent: number;
  scrollPosition: number;
  currentChapterNumber?: string;
  currentChapterTitle?: string;
  anchorKey?: string;
}

export interface ProgressSaveFlightHandlers {
  onSuccess(): void;
  onError(): void;
  onSettled(): void;
}

export interface ProgressSaveControllerDeps {
  getContext(): ProgressSaveContext;
  getPending(): ReadingPositionSnapshot | null;
  issueSave(input: ProgressSaveInput, handlers: ProgressSaveFlightHandlers): void;
  /** Success side effects (mark indicator state). Called only on a same-generation success. */
  onAccepted(pending: ReadingPositionSnapshot): void;
  writeRecovery(pending: ReadingPositionSnapshot, context: ProgressSaveContext): void;
  retryDelayMs?(consecutiveFailures: number): number;
  /** Isolated backoff for background (outgoing-handoff) retries. Defaults to 2s. */
  backgroundRetryDelayMs?: number;
  minPercentDelta?: number;
}

/** One parked outgoing-episode handoff (see the controller's comments). */
export interface OutgoingHandoff {
  context: ProgressSaveContext;
  snapshot: ReadingPositionSnapshot;
  /** Controller-wide sequence number at park time - the staleness ruler. */
  parkSeq: number;
  retriesUsed: number;
}

/**
 * Upper bound on parked outgoing handoffs. Navigation bursts during one
 * airborne flight can queue a handoff per episode; beyond this cap the
 * OLDEST entry (least valuable - local recovery still holds every one of
 * them) is dropped to keep memory/eventual work bounded.
 */
export const MAX_OUTGOING_HANDOFFS = 8;

/**
 * Retries a background handoff gets before it is abandoned to local
 * recovery. Bounded on purpose: handoffs are strictly best-effort (the
 * snapshot lives in local recovery regardless), and unbounded retries of
 * an old position must never compete forever with current saves.
 */
export const MAX_BACKGROUND_HANDOFF_RETRIES = 1;

export interface ProgressSaveControllerState {
  generation: number;
  inFlight: boolean;
  /** Pending queued follow-up flush (which generation asked, and whether forced). */
  queued: { force: boolean; generation: number } | null;
  /**
   * Parked outgoing-episode handoffs (FIFO across episodes, latest-wins
   * within one episode/user), fired as background flights once the
   * airborne save settles.
   */
  outgoingQueue: OutgoingHandoff[];
  /** True while a failed FOREGROUND save's backoff timer is running. */
  awaitingRetry: boolean;
  failures: number;
  lastMark: SavedProgressMark | null;
}

/** Positional equality for the outgoing-handoff dedupe (see dispose). */
export function sameReadingPosition(a: ReadingPositionSnapshot, b: ReadingPositionSnapshot): boolean {
  return (
    a.percent === b.percent &&
    a.scrollTop === b.scrollTop &&
    a.chapterNumber === b.chapterNumber &&
    a.anchorId === b.anchorId
  );
}

export interface ProgressSaveController {
  flush(force?: boolean): void;
  /** Bump generation; drop timers/queue/marks. The pending snapshot is the caller's and is not touched. */
  reset(): void;
  /** Best-effort force flush under the given (outgoing) context, then reset. */
  dispose(contextOverride?: ProgressSaveContext): void;
  getState(): ProgressSaveControllerState;
}

export function createProgressSaveController(deps: ProgressSaveControllerDeps): ProgressSaveController {
  let generation = 0;
  let inFlight = false;
  // Queued follow-up flush, tagged with the generation that asked for it.
  // Tagging matters: a flight from an OLD generation may settle while a
  // NEW generation has already queued its own flush - the old flight's
  // settle must serve that queue (through current-context validation),
  // never drop it, and never serve a queue belonging to a dead generation.
  let queued: { force: boolean; generation: number } | null = null;
  // Outgoing-episode handoffs (R3, queue-of-them R4): when dispose() runs
  // while the outgoing episode's save is still airborne, the episode's
  // LATEST position (which the caller's pending ref is about to be reset
  // away from) is parked here, under a COPY of the outgoing episode/user
  // context. One slot PER episode/user (latest wins within an episode,
  // FIFO across episodes, bounded overall) - navigating A -> B -> C during
  // one airborne flight must not lose A's handoff to B's. Entries fire as
  // BACKGROUND flights as settles free the single-flight slot, ordered
  // ahead of the current generation's queue. Local recovery holds every
  // parked snapshot either way (written synchronously at dispose), but
  // recovery alone never syncs OTHER devices.
  const outgoingQueue: OutgoingHandoff[] = [];
  // True while a failed FOREGROUND save's backoff retry timer is running:
  // ordinary (debounce/periodic) flushes must not bypass the backoff during
  // that window. Forced lifecycle flushes may - local recovery is always
  // written and the mutation is best-effort anyway.
  let awaitingRetry = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMark: SavedProgressMark | null = null;
  // Snapshot of the most recently ISSUED flight, for the dispose() dedupe:
  // if the outgoing episode's latest pending position is exactly what the
  // airborne flight already carries, no handoff is needed (no duplicate
  // API call for a position already in flight).
  let lastIssued: { episodeId: number; snapshot: ReadingPositionSnapshot } | null = null;

  // Monotonic controller-wide sequence, handed out at every flight issue
  // and every handoff park. lastConfirmedSeqByEpisode records the seq of
  // the latest SUCCESSFUL save per episode - the staleness ruler that
  // keeps an OLD handoff (or its retry) from ever overwriting a NEWER
  // position of the same episode that already reached the server.
  let seqCounter = 0;
  const lastConfirmedSeqByEpisode = new Map<number, number>();

  // Background-handoff retry state, deliberately ISOLATED from the
  // foreground failures/awaitingRetry/retryTimer above: a handoff failure
  // must never consume or delay the current episode's backoff budget.
  // Retries are QUEUED PER ENTRY (bounded by MAX_BACKGROUND_HANDOFF_RETRIES
  // per entry and the handoff-queue cap): a second handoff's failure must
  // never cancel or overwrite a first handoff's pending retry.
  const backgroundRetryQueue: OutgoingHandoff[] = [];
  let backgroundRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const retryDelay = (n: number) => (deps.retryDelayMs ?? progressSaveRetryDelayMs)(n);
  const backgroundRetryDelay = () => deps.backgroundRetryDelayMs ?? 2000;

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    awaitingRetry = false;
  };

  const clearBackgroundRetryTimer = () => {
    if (backgroundRetryTimer !== null) {
      clearTimeout(backgroundRetryTimer);
      backgroundRetryTimer = null;
    }
    backgroundRetryQueue.length = 0;
  };

  /** Park a handoff: one slot per episode+user (latest wins), bounded overall. */
  const pushOutgoing = (entry: OutgoingHandoff) => {
    const idx = outgoingQueue.findIndex(
      (e) => e.context.episodeId === entry.context.episodeId && e.context.userId === entry.context.userId
    );
    if (idx >= 0) {
      outgoingQueue[idx] = entry;
      return;
    }
    outgoingQueue.push(entry);
    if (outgoingQueue.length > MAX_OUTGOING_HANDOFFS) {
      // Drop the OLDEST parked handoff (least valuable - its local
      // recovery record still holds the snapshot) to stay bounded.
      outgoingQueue.shift();
    }
  };

  /** Whether an entry is still allowed to fire: same session user, not stale. */
  const handoffIsServeable = (entry: OutgoingHandoff): boolean => {
    const current = deps.getContext();
    if (entry.context.userId == null || current.userId !== entry.context.userId) return false;
    if ((lastConfirmedSeqByEpisode.get(entry.context.episodeId) ?? -1) > entry.parkSeq) return false;
    return true;
  };

  /**
   * Serve parked handoffs from the head of the queue. Returns true when a
   * background flight took the single-flight slot (the rest wait for that
   * flight's settle); entries that are foreign-user or stale are dropped
   * on the spot and serving continues.
   */
  const serveOutgoingQueue = (): boolean => {
    while (outgoingQueue.length > 0) {
      const entry = outgoingQueue[0];
      if (!handoffIsServeable(entry)) {
        outgoingQueue.shift();
        continue;
      }
      flushWithContext(entry.context, true, entry.snapshot, { background: true, handoff: entry });
      // flushWithContext is synchronous: if it issued, it owns the slot.
      outgoingQueue.shift();
      if (inFlight) return true;
    }
    return false;
  };

  /** Queue a failed handoff for its bounded retry - never cancels another entry's pending retry. */
  const scheduleBackgroundRetry = (entry: OutgoingHandoff) => {
    backgroundRetryQueue.push(entry);
    if (backgroundRetryTimer === null) {
      backgroundRetryTimer = setTimeout(serveBackgroundRetryQueue, backgroundRetryDelay());
    }
  };

  /**
   * One pass over the pending handoff retries: at most one fires per pass
   * (single-flight); entries that went foreign-user or stale are dropped;
   * anything left (slot busy) is rescheduled - so a busy foreground save
   * delays retries without ever dropping them on the floor.
   */
  const serveBackgroundRetryQueue = () => {
    backgroundRetryTimer = null;
    while (backgroundRetryQueue.length > 0) {
      if (inFlight) break;
      const entry = backgroundRetryQueue.shift();
      if (!entry || !handoffIsServeable(entry)) continue;
      flushWithContext(entry.context, true, entry.snapshot, { background: true, handoff: entry });
      if (inFlight) break;
    }
    if (backgroundRetryQueue.length > 0 && backgroundRetryTimer === null) {
      backgroundRetryTimer = setTimeout(serveBackgroundRetryQueue, backgroundRetryDelay());
    }
  };

  const flushWithContext = (
    context: ProgressSaveContext,
    force: boolean,
    snapshotOverride?: ReadingPositionSnapshot | null,
    opts?: { background?: boolean; handoff?: OutgoingHandoff }
  ) => {
    if (!context.enabled || !context.episodeId) return;
    const pending = snapshotOverride ?? deps.getPending();
    if (!pending) return;
    const background = opts?.background === true;
    const handoffEntry = opts?.handoff;

    // Local recovery FIRST, synchronously - if the app dies before the
    // mutation even leaves (or lands), the next open still finds this
    // device's freshest position under this context's user+episode key.
    // Guarded: a failing storage layer (SecurityError/quota) must degrade
    // to "no local recovery", never break the API save itself.
    //
    // BACKGROUND (handoff) flights deliberately skip this write: dispose()
    // already wrote this exact snapshot's recovery synchronously at park
    // time, and by the time a handoff fires the user may be BACK in the
    // same episode with a newer position - a handoff write would stamp the
    // OLD snapshot with a fresh savedAt and wrongly win the merge on the
    // next open (recovering backwards).
    if (!background) {
      try {
        deps.writeRecovery(pending, context);
      } catch {
        // storage unavailable - the save proceeds without the safety net
      }
    }

    // Background flights (the outgoing-episode handoffs) are always forced
    // and never wait behind the backoff gate or enter the queue.
    if (!background && awaitingRetry && !force) {
      // A failed save is inside its backoff window - debounce/periodic
      // flushes wait it out (recovery above is already fresh). Forced
      // lifecycle flushes fall through: they're the last chance before an
      // app switch/close.
      return;
    }

    if (inFlight) {
      if (background && handoffEntry) {
        // Not reachable through the intended flow (background flights
        // launch from a settle point, where the slot is free) - but if it
        // ever happens, park it back so the next settle serves it in order.
        pushOutgoing(handoffEntry);
        return;
      }
      queued = queued
        ? { force: queued.force || force, generation: queued.generation }
        : { force, generation };
      return;
    }

    if (
      !background &&
      shouldSkipProgressSave(lastMark, pending, {
        force,
        minPercentDelta: deps.minPercentDelta,
      })
    ) {
      return;
    }

    inFlight = true;
    let flightFailed = false;
    const flightGeneration = generation;
    const flightSeq = ++seqCounter;
    lastIssued = { episodeId: context.episodeId, snapshot: { ...pending } };
    deps.issueSave(
      {
        episodeId: context.episodeId,
        progressPercent: pending.percent,
        scrollPosition: pending.scrollTop,
        currentChapterNumber: pending.chapterNumber ?? undefined,
        currentChapterTitle: pending.chapterTitle ?? undefined,
        anchorKey: pending.anchorId ?? undefined,
      },
      {
        onSuccess: () => {
          // Confirm per-episode even when the generation moved on - a
          // later handoff of the SAME episode must be recognizable as
          // stale against this confirmation. (Generation mismatches only
          // suppress marks/indicators, not the staleness record.)
          lastConfirmedSeqByEpisode.set(context.episodeId, flightSeq);
          if (generation !== flightGeneration) return;
          if (!background) {
            failures = 0;
            lastMark = {
              percent: pending.percent,
              scrollTop: pending.scrollTop,
              chapterNumber: pending.chapterNumber,
            };
            deps.onAccepted(pending);
          }
          // A background (handoff) success stays silent: local recovery
          // already holds this snapshot, and the CURRENT generation's
          // mark/indicator must never be touched with the OUTGOING
          // episode's numbers.
        },
        onError: () => {
          flightFailed = true;
          if (background && handoffEntry) {
            // ISOLATED background retry: the foreground failures/
            // awaitingRetry/retryTimer state is deliberately untouched - a
            // handoff failure must never consume or delay the current
            // episode's backoff budget. The retry is QUEUED PER ENTRY
            // (bounded at one per entry) - scheduling one handoff's retry
            // must never cancel another's.
            //
            // Deliberately NOT generation-guarded, unlike the foreground
            // path below: a handoff retry replays the entry's OWN captured
            // context/snapshot, so it stays valid across navigation-driven
            // generation bumps. The REAL safety checks (session user,
            // staleness, single-flight) run when the retry fires - that is
            // where a genuine user switch drops it.
            if (handoffEntry.retriesUsed < MAX_BACKGROUND_HANDOFF_RETRIES) {
              handoffEntry.retriesUsed += 1;
              scheduleBackgroundRetry(handoffEntry);
            }
            return;
          }
          if (generation !== flightGeneration) return;
          failures += 1;
          clearRetryTimer();
          // Silent retry with backoff; only onSuccess is ever surfaced as
          // "saved". Local recovery already holds the position regardless.
          awaitingRetry = true;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            awaitingRetry = false;
            // An ordinary flight retries with the CURRENT context and the
            // freshest pending (the generation guard above and the
            // reset-on-navigation clearing this timer keep that safe).
            flushWithContext(deps.getContext(), true);
          }, retryDelay(failures - 1));
        },
        onSettled: () => {
          inFlight = false;
          // Outgoing-episode handoffs FIRST, before this generation's
          // queued save: each parked snapshot is sent under ITS OWN
          // episode/user context (never written across boundaries), FIFO
          // across episodes, validated against the CURRENT session user
          // and the same-episode staleness ruler.
          if (outgoingQueue.length > 0 && serveOutgoingQueue()) return;
          const q = queued;
          queued = null;
          if (!q) return;
          // Current-generation validation: a queue armed by a dead
          // generation dies with it (its generation's reset already
          // dropped it; this is belt-and-braces for the dispose path).
          if (q.generation !== generation) return;
          if (generation !== flightGeneration) {
            // STALE flight, CURRENT queue: the flight belongs to the
            // previous episode/user, but the queue was armed afterwards by
            // the new generation's own flush trigger (e.g. episode B's
            // scroll debounce while A's flight was still airborne). Serving
            // it re-dispatches through the CURRENT context - B's pending
            // gets saved without waiting for the user to scroll again.
            flushWithContext(deps.getContext(), q.force);
            return;
          }
          // Same-generation handoff, immediately only on success - EXCEPT
          // for a failed BACKGROUND flight: its retry is isolated and must
          // not hold (or drop) the current generation's queue; only a
          // failed FOREGROUND flight defers the follow-up to its own
          // retry timer (with backoff).
          if (!flightFailed || background) flushWithContext(deps.getContext(), q.force);
        },
      }
    );
  };

  return {
    flush(force = false) {
      flushWithContext(deps.getContext(), force);
    },
    reset() {
      generation += 1;
      clearRetryTimer();
      clearBackgroundRetryTimer();
      queued = null;
      outgoingQueue.length = 0;
      failures = 0;
      lastMark = null;
      lastIssued = null;
      lastConfirmedSeqByEpisode.clear();
    },
    dispose(contextOverride) {
      const ctx = contextOverride ?? deps.getContext();
      const pending = deps.getPending();
      if (ctx.enabled && ctx.episodeId && pending) {
        // Recovery for the OUTGOING context is written synchronously
        // FIRST: even if the app dies before anything below completes,
        // this device's next open of this episode finds its newest
        // position. (Flush paths below may write it again - harmless.)
        try {
          deps.writeRecovery(pending, ctx);
        } catch {
          // storage unavailable - proceed without the safety net
        }
        if (inFlight) {
          const airborneAlreadyCarriesIt =
            lastIssued !== null &&
            lastIssued.episodeId === ctx.episodeId &&
            sameReadingPosition(lastIssued.snapshot, pending);
          if (!airborneAlreadyCarriesIt) {
            // Park the outgoing episode's LATEST position (one slot per
            // episode+user - latest wins within an episode - bounded
            // overall) for a background flight once the airborne one
            // settles.
            pushOutgoing({
              context: { ...ctx },
              snapshot: { ...pending },
              parkSeq: ++seqCounter,
              retriesUsed: 0,
            });
          }
          // else: the airborne flight already carries this exact position;
          // a handoff would just duplicate the API call.
        } else {
          // Nothing airborne: force-flush the outgoing position now, under
          // the outgoing context (a plain flight of the outgoing
          // generation - its settle lands after the bump below and is
          // intentionally inert for marks).
          flushWithContext(ctx, true, pending);
        }
      }
      // Bump the generation: any still-airborne flight from the outgoing
      // context settles inert for marks/queue, while parked handoffs
      // survive on purpose.
      generation += 1;
      clearRetryTimer();
      queued = null;
      failures = 0;
      lastMark = null;
      lastIssued = null;
    },
    getState() {
      return {
        generation,
        inFlight,
        queued,
        outgoingQueue: outgoingQueue.map((e) => ({ ...e, context: { ...e.context }, snapshot: { ...e.snapshot } })),
        awaitingRetry,
        failures,
        lastMark,
      };
    },
  };
}

// ============================================================================
// Resume verifier
// ----------------------------------------------------------------------------
// Decides, across the settle window after a resume jump, whether to keep
// re-asserting the restored position. User intent is detected ONLY from
// explicit input signals (wheel / touch / pointer / navigation keys / TOC
// click) - a bare scrollTop change is NOT treated as intent, because the
// resume banner unmounting, font swaps and late layout shifts all move the
// viewport without the user touching anything. The old scrollTop-delta
// heuristic mistook exactly those shifts for the reader scrolling away and
// wrongly cancelled the restore.
// ============================================================================

export type ResumeVerifyEndReason = "expired" | "user" | "manual";

export interface ResumeVerifierDeps {
  /** Re-apply the restore. Returns the scrollTop that took effect (null when nothing applied). */
  apply(target: ReadingPositionSnapshot): number | null;
  now?(): number;
  windowMs?: number;
}

export interface ResumeVerifier {
  /** Start a fresh verify window for this restore target. */
  arm(target: ReadingPositionSnapshot): void;
  /** Record explicit user scroll intent; ends the window immediately if armed. */
  notifyUserIntent(): void;
  /** One scheduled verify pass: re-assert unless the window ended. */
  step(): void;
  cancel(): void;
  isActive(): boolean;
  /** Why the window ended (null while active / never armed). */
  getEndReason(): ResumeVerifyEndReason | null;
}

export function createResumeVerifier(deps: ResumeVerifierDeps): ResumeVerifier {
  const windowMs = deps.windowMs ?? 2000;
  let active: { target: ReadingPositionSnapshot; until: number } | null = null;
  let userIntent = false;
  let endReason: ResumeVerifyEndReason | null = null;

  const end = (reason: ResumeVerifyEndReason) => {
    active = null;
    endReason = reason;
  };

  return {
    arm(target) {
      active = { target, until: (deps.now ?? Date.now)() + windowMs };
      userIntent = false;
      endReason = null;
    },
    notifyUserIntent() {
      if (!active) return;
      userIntent = true;
      end("user");
    },
    step() {
      if (!active) return;
      if (userIntent) {
        end("user");
        return;
      }
      if ((deps.now ?? Date.now)() > active.until) {
        end("expired");
        return;
      }
      deps.apply(active.target);
    },
    cancel() {
      if (!active) return;
      end("manual");
    },
    isActive: () => active !== null,
    getEndReason: () => endReason,
  };
}
