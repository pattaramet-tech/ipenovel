import { describe, expect, it, vi } from "vitest";
import {
  MAX_OUTGOING_HANDOFFS,
  MIN_SCROLL_DELTA_TO_SAVE_PX,
  RESUME_MERGE_SKEW_TOLERANCE_MS,
  clampScrollTop,
  createProgressSaveController,
  createResumeVerifier,
  hasResumablePosition,
  mergeResumeSource,
  parseReadingRecoveryRecord,
  parseServerLastReadAt,
  progressSaveRetryDelayMs,
  readReadingRecovery,
  readingRecoveryStorageKey,
  resolveResumeScrollPlan,
  serverProgressToSnapshot,
  shouldSkipProgressSave,
  toRecoveryRecord,
  writeReadingRecovery,
  type ProgressSaveContext,
  type ProgressSaveFlightHandlers,
  type ReadingPositionSnapshot,
  type ReadingRecoveryRecord,
  type ServerReadingProgress,
} from "./readerResumePosition";

class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const snapshot = (overrides: Partial<ReadingPositionSnapshot> = {}): ReadingPositionSnapshot => ({
  percent: 12.5,
  scrollTop: 4000,
  chapterNumber: "3",
  chapterTitle: "บทที่ 3",
  anchorId: "toc-line-42",
  ...overrides,
});

const serverProgress = (overrides: Partial<ServerReadingProgress> = {}): ServerReadingProgress => ({
  progressPercent: 12.5,
  scrollPosition: 4000,
  currentChapterNumber: "3",
  currentChapterTitle: "บทที่ 3",
  anchorKey: "toc-line-42",
  lastReadAt: "2026-10-28T10:00:00.000Z",
  ...overrides,
});

describe("readingRecoveryStorageKey", () => {
  it("namespaces the key by BOTH user and episode", () => {
    expect(readingRecoveryStorageKey(7, 101)).toBe("ipe.readerResume.v1.u7.e101");
    expect(readingRecoveryStorageKey("abc", 202)).toBe("ipe.readerResume.v1.uabc.e202");
    expect(readingRecoveryStorageKey(7, 101)).not.toBe(readingRecoveryStorageKey(8, 101));
    expect(readingRecoveryStorageKey(7, 101)).not.toBe(readingRecoveryStorageKey(7, 102));
  });
});

describe("parseReadingRecoveryRecord", () => {
  it("parses a well-formed record", () => {
    const raw = JSON.stringify(toRecoveryRecord(snapshot(), 1_700_000_000_000));
    expect(parseReadingRecoveryRecord(raw)).toEqual({
      ...snapshot(),
      savedAt: 1_700_000_000_000,
    });
  });

  it("returns null for null/empty input", () => {
    expect(parseReadingRecoveryRecord(null)).toBeNull();
    expect(parseReadingRecoveryRecord("")).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    expect(parseReadingRecoveryRecord("{not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseReadingRecoveryRecord("42")).toBeNull();
    expect(parseReadingRecoveryRecord('"str"')).toBeNull();
    expect(parseReadingRecoveryRecord("null")).toBeNull();
    expect(parseReadingRecoveryRecord("[1,2]")).toBeNull();
  });

  it("returns null for out-of-range or missing numbers", () => {
    const base = toRecoveryRecord(snapshot(), 1_700_000_000_000);
    expect(parseReadingRecoveryRecord(JSON.stringify({ ...base, percent: 150 }))).toBeNull();
    expect(parseReadingRecoveryRecord(JSON.stringify({ ...base, percent: -1 }))).toBeNull();
    expect(parseReadingRecoveryRecord(JSON.stringify({ ...base, percent: "NaN" }))).toBeNull();
    expect(parseReadingRecoveryRecord(JSON.stringify({ ...base, scrollTop: -5 }))).toBeNull();
    expect(parseReadingRecoveryRecord(JSON.stringify({ ...base, savedAt: 0 }))).toBeNull();
    const { percent: _percent, ...noPercent } = base;
    expect(parseReadingRecoveryRecord(JSON.stringify(noPercent))).toBeNull();
  });

  it("coerces absent/empty strings to null but keeps populated ones", () => {
    const parsed = parseReadingRecoveryRecord(
      JSON.stringify({
        percent: 5,
        scrollTop: 100,
        savedAt: 1_700_000_000_000,
        chapterNumber: 9, // non-string is dropped to null, not crashed on
      })
    );
    expect(parsed).toEqual({
      percent: 5,
      scrollTop: 100,
      savedAt: 1_700_000_000_000,
      chapterNumber: null,
      chapterTitle: null,
      anchorId: null,
    });
  });
});

describe("readReadingRecovery / writeReadingRecovery", () => {
  it("round-trips a snapshot through storage under its user+episode key", () => {
    const storage = new FakeStorage();
    expect(writeReadingRecovery(storage, 7, 101, snapshot())).toBe(true);
    const record = readReadingRecovery(storage, 7, 101);
    expect(record).not.toBeNull();
    expect(record?.scrollTop).toBe(4000);
    expect(record?.savedAt).toBeGreaterThan(0);
    // other user / other episode sees nothing of it
    expect(readReadingRecovery(storage, 8, 101)).toBeNull();
    expect(readReadingRecovery(storage, 7, 102)).toBeNull();
  });

  it("reads nothing back when storage holds a corrupt value", () => {
    const storage = new FakeStorage();
    storage.setItem(readingRecoveryStorageKey(7, 101), "junk{");
    expect(readReadingRecovery(storage, 7, 101)).toBeNull();
  });

  it("returns false (not throw) when setItem throws, e.g. private mode/quota", () => {
    const throwing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(writeReadingRecovery(throwing, 7, 101, snapshot())).toBe(false);
  });

  it("tolerates missing storage (null) and a throwing getItem", () => {
    expect(writeReadingRecovery(null, 7, 101, snapshot())).toBe(false);
    expect(readReadingRecovery(null, 7, 101)).toBeNull();
    const throwingRead: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new Error("unavailable");
      },
    };
    expect(readReadingRecovery(throwingRead, 7, 101)).toBeNull();
  });
});

describe("serverProgressToSnapshot / parseServerLastReadAt", () => {
  it("maps server field names onto the snapshot shape and drops junk numerics", () => {
    expect(
      serverProgressToSnapshot({
        progressPercent: 33,
        scrollPosition: 900,
        currentChapterNumber: "12",
        currentChapterTitle: "Chapter 12",
        anchorKey: "toc-line-9",
      })
    ).toEqual({
      percent: 33,
      scrollTop: 900,
      chapterNumber: "12",
      chapterTitle: "Chapter 12",
      anchorId: "toc-line-9",
    });
    expect(serverProgressToSnapshot({ progressPercent: Number.NaN, scrollPosition: -4 })).toEqual({
      percent: 0,
      scrollTop: 0,
      chapterNumber: null,
      chapterTitle: null,
      anchorId: null,
    });
  });

  it("parses lastReadAt from ISO strings, Date instances, and rejects junk", () => {
    const iso = "2026-10-28T10:00:00.000Z";
    expect(parseServerLastReadAt(iso)).toBe(Date.parse(iso));
    expect(parseServerLastReadAt(new Date(iso))).toBe(Date.parse(iso));
    expect(parseServerLastReadAt(null)).toBe(0);
    expect(parseServerLastReadAt(undefined)).toBe(0);
    expect(parseServerLastReadAt("not-a-date")).toBe(0);
  });
});

describe("mergeResumeSource", () => {
  const localAt = Date.parse("2026-10-28T10:00:00.000Z");

  const localRecord = (at: number): ReadingRecoveryRecord => ({ ...snapshot(), savedAt: at });

  it("returns null when neither source exists", () => {
    expect(mergeResumeSource(null, null)).toBeNull();
    expect(mergeResumeSource(undefined, null)).toBeNull();
  });

  it("uses the server position alone when there is no local record", () => {
    const merged = mergeResumeSource(serverProgress(), null);
    expect(merged?.origin).toBe("server");
    expect(merged?.snapshot.anchorId).toBe("toc-line-42");
  });

  it("uses the local record alone when the server has no saved progress", () => {
    const merged = mergeResumeSource(null, localRecord(localAt));
    expect(merged?.origin).toBe("local");
    expect(merged?.snapshot.scrollTop).toBe(4000);
  });

  it("a server position written from ANOTHER device after this device's last write wins", () => {
    const serverNewer = serverProgress({ lastReadAt: new Date(localAt + RESUME_MERGE_SKEW_TOLERANCE_MS + 60_000).toISOString() });
    const merged = mergeResumeSource(serverNewer, localRecord(localAt));
    expect(merged?.origin).toBe("server");
  });

  it("a stale local record never overrides newer cross-device server data", () => {
    // local saved hours before the server write
    const staleLocal = localRecord(localAt);
    const freshServer = serverProgress({ lastReadAt: new Date(localAt + 3 * 3_600_000).toISOString() });
    expect(mergeResumeSource(freshServer, staleLocal)?.origin).toBe("server");
  });

  it("a fresh local record (within clock-skew tolerance) beats the server copy", () => {
    const serverSameMoment = serverProgress({ lastReadAt: new Date(localAt + 5_000).toISOString() });
    expect(mergeResumeSource(serverSameMoment, localRecord(localAt))?.origin).toBe("local");
    // and even when the server clock is slightly ahead, up to the tolerance
    const serverSlightlyAhead = serverProgress({
      lastReadAt: new Date(localAt + RESUME_MERGE_SKEW_TOLERANCE_MS).toISOString(),
    });
    expect(mergeResumeSource(serverSlightlyAhead, localRecord(localAt))?.origin).toBe("local");
  });

  it("an exact tie goes to local (this device's exact pixel position)", () => {
    const tie = serverProgress({ lastReadAt: new Date(localAt).toISOString() });
    expect(mergeResumeSource(tie, localRecord(localAt))?.origin).toBe("local");
  });

  it("a server position with no usable lastReadAt only wins when local is absent", () => {
    const noTimestamp = serverProgress({ lastReadAt: null });
    expect(mergeResumeSource(noTimestamp, null)?.origin).toBe("server");
    expect(mergeResumeSource(noTimestamp, localRecord(localAt))?.origin).toBe("local");
  });

  it("a local record stamped in the FUTURE (clock skewed forward) never shadows the server", () => {
    const now = localAt;
    // savedAt 10 minutes in the future, server wrote 1 minute ago: without
    // the future-skew guard this local record would "win" on timestamps and
    // old data would overwrite newer cross-device data without evidence.
    const futureLocal = localRecord(now + 10 * 60_000);
    const recentServer = serverProgress({ lastReadAt: new Date(now - 60_000).toISOString() });
    expect(mergeResumeSource(recentServer, futureLocal, now)?.origin).toBe("server");
  });

  it("a local record merely seconds ahead of `now` (normal jitter) still wins", () => {
    const now = localAt;
    const jitterLocal = localRecord(now + 5_000);
    const serverSameMoment = serverProgress({ lastReadAt: new Date(now - 60_000).toISOString() });
    expect(mergeResumeSource(serverSameMoment, jitterLocal, now)?.origin).toBe("local");
  });
});

describe("hasResumablePosition", () => {
  it("false for null and for an all-zero record (opened, never scrolled)", () => {
    expect(hasResumablePosition(null)).toBe(false);
    expect(
      hasResumablePosition({ percent: 0, scrollTop: 0, chapterNumber: null, chapterTitle: null, anchorId: null })
    ).toBe(false);
  });

  it("true for percent > 0", () => {
    expect(hasResumablePosition(snapshot({ percent: 0.4, scrollTop: 0 }))).toBe(true);
  });

  it("true when percent is 0 but a scroll position was saved (legacy rows)", () => {
    expect(hasResumablePosition(snapshot({ percent: 0, scrollTop: 1200 }))).toBe(true);
  });

  it("true for chapter-only positions (package mid-chapter with no px data)", () => {
    expect(hasResumablePosition(snapshot({ percent: 0, scrollTop: 0, chapterNumber: "5" }))).toBe(true);
    expect(hasResumablePosition(snapshot({ percent: 0, scrollTop: 0, anchorId: "toc-line-7" }))).toBe(true);
  });
});

describe("shouldSkipProgressSave", () => {
  const last = { percent: 10, scrollTop: 1000, chapterNumber: "2" };

  it("never skips a forced flush (visibilitychange hidden / pagehide / retry)", () => {
    expect(shouldSkipProgressSave(last, snapshot({ percent: 10, scrollTop: 1000, chapterNumber: "2" }), { force: true })).toBe(false);
  });

  it("saves when there is no previous mark (first save for the episode)", () => {
    expect(shouldSkipProgressSave(null, snapshot())).toBe(false);
  });

  it("saves when the chapter changed even at the same percent", () => {
    expect(shouldSkipProgressSave(last, snapshot({ percent: 10, scrollTop: 1000, chapterNumber: "3" }))).toBe(false);
    expect(shouldSkipProgressSave(last, snapshot({ percent: 10, scrollTop: 1000, chapterNumber: null }))).toBe(false);
  });

  it("saves when the percent delta reached 1 point", () => {
    expect(shouldSkipProgressSave(last, snapshot({ percent: 11, scrollTop: 1100, chapterNumber: "2" }))).toBe(false);
    expect(shouldSkipProgressSave(last, snapshot({ percent: 9, scrollTop: 900, chapterNumber: "2" }))).toBe(false);
  });

  it("saves sub-1% movement whose scroll offset moved materially (the old percent-only gate dropped these)", () => {
    expect(
      shouldSkipProgressSave(last, snapshot({ percent: 10.4, scrollTop: 1000 + MIN_SCROLL_DELTA_TO_SAVE_PX, chapterNumber: "2" }))
    ).toBe(false);
  });

  it("still dedupes a genuinely negligible move (sub-1% AND sub-threshold px, same chapter)", () => {
    expect(
      shouldSkipProgressSave(last, snapshot({ percent: 10.2, scrollTop: 1000 + 5, chapterNumber: "2" }))
    ).toBe(true);
    expect(
      shouldSkipProgressSave(last, snapshot({ percent: 10.2, scrollTop: 1000 - 5, chapterNumber: "2" }))
    ).toBe(true);
  });

  it("honors a custom percent-delta threshold", () => {
    const tinyMove = snapshot({ percent: 10.5, scrollTop: 1000, chapterNumber: "2" });
    expect(shouldSkipProgressSave(last, tinyMove, { minPercentDelta: 5 })).toBe(true);
    expect(shouldSkipProgressSave(last, tinyMove)).toBe(true); // default 1 also skips this
    const biggerMove = snapshot({ percent: 15.5, scrollTop: 1000, chapterNumber: "2" });
    expect(shouldSkipProgressSave(last, biggerMove, { minPercentDelta: 5 })).toBe(false);
  });
});

describe("clampScrollTop", () => {
  it("passes through in-range values", () => {
    expect(clampScrollTop(500, 3000, 800)).toBe(500);
  });

  it("clamps negatives to 0 and overshoot to scrollHeight - clientHeight", () => {
    expect(clampScrollTop(-20, 3000, 800)).toBe(0);
    expect(clampScrollTop(99999, 3000, 800)).toBe(2200);
  });

  it("collapses to 0 when nothing overflows (content fits one screen)", () => {
    expect(clampScrollTop(500, 1000, 1000)).toBe(0);
    expect(clampScrollTop(500, 900, 1000)).toBe(0);
  });
});

describe("resolveResumeScrollPlan", () => {
  it("prefers the exact saved scroll offset when the container is measurable", () => {
    expect(resolveResumeScrollPlan(snapshot({ scrollTop: 4000 }), { scrollHeight: 20000, clientHeight: 800 })).toEqual({
      kind: "scrollTop",
      value: 4000,
    });
  });

  it("clamps the offset into the current scrollable range (layout shrank since save)", () => {
    expect(resolveResumeScrollPlan(snapshot({ scrollTop: 15000 }), { scrollHeight: 6000, clientHeight: 800 })).toEqual({
      kind: "scrollTop",
      value: 5200,
    });
  });

  it("falls back to the chapter anchor when the offset clamps away (content now fits)", () => {
    // 900 scrollHeight under a 1000px viewport: nothing overflows, so the
    // saved pixel offset is meaningless -> anchor takes over.
    expect(resolveResumeScrollPlan(snapshot({ scrollTop: 4000, anchorId: "toc-line-42" }), { scrollHeight: 900, clientHeight: 1000 })).toEqual({
      kind: "anchor",
      anchorId: "toc-line-42",
    });
  });

  it("falls back to the anchor when the container isn't measurable yet (metrics null)", () => {
    expect(resolveResumeScrollPlan(snapshot({ scrollTop: 4000, anchorId: "toc-line-42" }), null)).toEqual({
      kind: "anchor",
      anchorId: "toc-line-42",
    });
  });

  it("falls back to the chapter number when no anchor exists", () => {
    expect(
      resolveResumeScrollPlan(snapshot({ scrollTop: 4000, anchorId: null, chapterNumber: "3" }), null)
    ).toEqual({ kind: "chapter", chapterNumber: "3" });
  });

  it("reports none when the position carries nothing usable", () => {
    expect(
      resolveResumeScrollPlan(snapshot({ scrollTop: 0, anchorId: null, chapterNumber: null }), { scrollHeight: 5000, clientHeight: 800 })
    ).toEqual({ kind: "none" });
  });
});

describe("progressSaveRetryDelayMs", () => {
  it("backs off 2s -> 6s -> 18s, capped at 30s", () => {
    expect(progressSaveRetryDelayMs(0)).toBe(2000);
    expect(progressSaveRetryDelayMs(1)).toBe(6000);
    expect(progressSaveRetryDelayMs(2)).toBe(18000);
    expect(progressSaveRetryDelayMs(3)).toBe(30000);
    expect(progressSaveRetryDelayMs(10)).toBe(30000);
  });

  it("treats negative inputs as the first retry", () => {
    expect(progressSaveRetryDelayMs(-3)).toBe(2000);
  });
});

// ============================================================================
// createProgressSaveController - the save lifecycle extracted out of React.
// Every flight below is simulated by capturing the handlers issueSave
// received and settling them manually (deferred-style), the same way the
// tRPC mutation would.
// ============================================================================

const recordedSaves: Array<{
  input: {
    episodeId: number;
    progressPercent: number;
    scrollPosition: number;
    currentChapterNumber?: string;
    currentChapterTitle?: string;
    anchorKey?: string;
  };
  handlers: ProgressSaveFlightHandlers;
}> = [];

function makeControllerDeps(overrides?: {
  context?: Partial<ProgressSaveContext>;
  pending?: ReadingPositionSnapshot | null;
  writeRecovery?: (p: ReadingPositionSnapshot, c: ProgressSaveContext) => void;
  retryDelayMs?: (n: number) => number;
  backgroundRetryDelayMs?: number;
  onAccepted?: (p: ReadingPositionSnapshot) => void;
}) {
  recordedSaves.length = 0;
  const context: ProgressSaveContext = {
    episodeId: 1,
    userId: "u1",
    enabled: true,
    ...overrides?.context,
  };
  let pending: ReadingPositionSnapshot | null =
    overrides?.pending === undefined ? snapshot({ percent: 10, scrollTop: 1000 }) : overrides.pending;
  const accepted: ReadingPositionSnapshot[] = [];
  const recoveryWrites: Array<{ pending: ReadingPositionSnapshot; context: ProgressSaveContext }> = [];
  const controller = createProgressSaveController({
    getContext: () => context,
    getPending: () => pending,
    issueSave: (input, handlers) => {
      recordedSaves.push({ input, handlers });
    },
    onAccepted: (p) => {
      accepted.push(p);
      overrides?.onAccepted?.(p);
    },
    writeRecovery: (p, c) => {
      recoveryWrites.push({ pending: { ...p }, context: { ...c } });
      overrides?.writeRecovery?.(p, c);
    },
    ...(overrides?.retryDelayMs ? { retryDelayMs: overrides.retryDelayMs } : {}),
    ...(overrides?.backgroundRetryDelayMs !== undefined
      ? { backgroundRetryDelayMs: overrides.backgroundRetryDelayMs }
      : {}),
  });
  return {
    controller,
    setContext: (next: Partial<ProgressSaveContext>) => Object.assign(context, next),
    setPending: (next: ReadingPositionSnapshot | null) => {
      pending = next;
    },
    get accepted() {
      return accepted;
    },
    get recoveryWrites() {
      return recoveryWrites;
    },
  };
}

describe("createProgressSaveController - single flight & queue", () => {
  it("issues a save for the pending position and marks success only via onSuccess", () => {
    const d = makeControllerDeps();
    d.controller.flush();
    expect(recordedSaves).toHaveLength(1);
    expect(recordedSaves[0].input.episodeId).toBe(1);
    expect(recordedSaves[0].input.progressPercent).toBe(10);
    // nothing accepted yet
    expect(d.accepted).toEqual([]);
    recordedSaves[0].handlers.onSuccess();
    expect(d.accepted).toHaveLength(1);
    expect(d.controller.getState().lastMark).toEqual({ percent: 10, scrollTop: 1000, chapterNumber: "3" });
  });

  it("holds a second flush while one is airborne, then re-flushes the LATEST pending after a successful settle", () => {
    const d = makeControllerDeps();
    d.controller.flush();
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.flush(true); // queued while flight 1 airborne
    expect(recordedSaves).toHaveLength(1);
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    // queued follow-up flushed AFTER settle, with the newest pending
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.progressPercent).toBe(20);
    expect(recordedSaves[1].input.scrollPosition).toBe(2000);
  });

  it("a failed flight does NOT immediately hand off to the queued flush - the retry timer owns it (backoff respected)", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ retryDelayMs: () => 5000 });
      d.controller.flush();
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.flush(true); // queued
      recordedSaves[0].handlers.onError();
      recordedSaves[0].handlers.onSettled();
      // no immediate re-flush despite the queued flag
      expect(recordedSaves).toHaveLength(1);
      vi.advanceTimersByTime(4999);
      expect(recordedSaves).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(recordedSaves).toHaveLength(2);
      expect(recordedSaves[1].input.progressPercent).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last-saved mark untouched on failure so the retry passes the skip gate", () => {
    const d = makeControllerDeps();
    d.controller.flush();
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    // sub-threshold move would normally be deduped...
    d.setPending(snapshot({ percent: 10.2, scrollTop: 1005 }));
    // ...but a FORCED flush bypasses the gate, then fails:
    d.controller.flush(true);
    recordedSaves[1].handlers.onError();
    recordedSaves[1].handlers.onSettled();
    expect(d.controller.getState().lastMark).toEqual({ percent: 10, scrollTop: 1000, chapterNumber: "3" });
    expect(d.controller.getState().failures).toBe(1);
  });

  it("writes local recovery (under the flushing context) before every attempted save", () => {
    const d = makeControllerDeps();
    d.controller.flush();
    expect(d.recoveryWrites).toHaveLength(1);
    expect(d.recoveryWrites[0].context.episodeId).toBe(1);
    expect(d.recoveryWrites[0].context.userId).toBe("u1");
  });

  it("survives a storage failure (writeRecovery throwing) - the save still issues", () => {
    const d = makeControllerDeps({
      writeRecovery: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    });
    expect(() => d.controller.flush()).not.toThrow();
    expect(recordedSaves).toHaveLength(1);
  });

  it("disabled context (logged out / not readable) never issues anything", () => {
    const d = makeControllerDeps({ context: { enabled: false } });
    d.controller.flush(true);
    expect(recordedSaves).toHaveLength(0);
    expect(d.recoveryWrites).toHaveLength(0);
  });

  it("non-force flush queued while a flight is airborne is HONORED after settle (not dropped)", () => {
    const d = makeControllerDeps();
    d.controller.flush(); // flight 1 (percent 10), stays airborne
    d.setPending(snapshot({ percent: 42, scrollTop: 4200 }));
    d.controller.flush(); // ordinary debounce-style flush - queued
    expect(d.controller.getState().queued).toEqual({ force: false, generation: 0 });
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.progressPercent).toBe(42);
  });

  it("BACKOFF GATE: while the retry timer runs, debounce/periodic (non-force) flushes are held back; a forced lifecycle flush passes and refreshes recovery", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ retryDelayMs: () => 5000 });
      d.controller.flush();
      recordedSaves[0].handlers.onError();
      recordedSaves[0].handlers.onSettled();
      expect(d.controller.getState().awaitingRetry).toBe(true);

      // pending moves (new scroll) and the debounced flush fires mid-backoff:
      d.setPending(snapshot({ percent: 22, scrollTop: 2200 }));
      d.controller.flush(); // non-force
      expect(recordedSaves).toHaveLength(1); // held back, no backoff bypass
      // local recovery is STILL refreshed synchronously by that flush:
      expect(d.recoveryWrites.at(-1)?.pending.percent).toBe(22);

      // a forced lifecycle flush (visibilitychange hidden / pagehide) passes:
      d.controller.flush(true);
      expect(recordedSaves).toHaveLength(2);
      recordedSaves[1].handlers.onSuccess();
      recordedSaves[1].handlers.onSettled();

      // and the retry timer still fires at its own delay, force-flushing:
      vi.advanceTimersByTime(5000);
      expect(recordedSaves).toHaveLength(3);
      expect(recordedSaves[2].input.progressPercent).toBe(22);
      expect(d.controller.getState().awaitingRetry).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backoff window is cleared by a later success", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ retryDelayMs: () => 5000 });
      d.controller.flush();
      recordedSaves[0].handlers.onError();
      recordedSaves[0].handlers.onSettled();
      expect(d.controller.getState().awaitingRetry).toBe(true);
      vi.advanceTimersByTime(5000); // retry fires and succeeds
      recordedSaves[1].handlers.onSuccess();
      recordedSaves[1].handlers.onSettled();
      expect(d.controller.getState().awaitingRetry).toBe(false);
      expect(d.controller.getState().failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createProgressSaveController - generation fencing (episode/user change)", () => {
  it("P1 regression: episode A save airborne -> switch to B (reset) -> A settles -> it must NOT flush B's pending nor touch marks", () => {
    const d = makeControllerDeps({ context: { episodeId: 1 } });
    d.controller.flush(); // flight for episode 1, percent 10
    expect(recordedSaves).toHaveLength(1);

    // navigation: reset (generation bump), then episode B's own scrolling:
    d.controller.reset();
    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 55, scrollTop: 5500, chapterNumber: "8" }));

    // flight 1 (episode 1) finally settles - success first...
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    // ...and it must NOT have accepted/marked for the new generation:
    expect(d.accepted).toEqual([]);
    expect(d.controller.getState().lastMark).toBeNull();
    // and no queued follow-up may fire for episode 2's pending:
    expect(recordedSaves).toHaveLength(1);

    // episode B's own flush then works normally, under episode 2's context:
    d.controller.flush();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(2);
    expect(recordedSaves[1].input.progressPercent).toBe(55);
  });

  it("stale onError must not schedule a retry into the new generation", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1 } });
      d.controller.flush();
      d.controller.reset(); // navigate away before the failure lands
      d.setContext({ episodeId: 2 });
      recordedSaves[0].handlers.onError();
      recordedSaves[0].handlers.onSettled();
      vi.advanceTimersByTime(60_000);
      // nothing from generation 1 ever fires again - including no retry
      expect(recordedSaves).toHaveLength(1);
      expect(d.controller.getState().failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose(contextOverride) force-saves the OUTGOING episode's pending under its own context, then fences it", () => {
    // simulate the cleanup path: refs already point at episode 2, but the
    // cleanup closure still knows episode 1 + its user
    const d = makeControllerDeps({ context: { episodeId: 2, userId: "u1" } });
    d.setPending(snapshot({ percent: 33, scrollTop: 3300 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    expect(recordedSaves).toHaveLength(1);
    expect(recordedSaves[0].input.episodeId).toBe(1);
    expect(recordedSaves[0].input.progressPercent).toBe(33);
    expect(d.recoveryWrites[0].context.episodeId).toBe(1);
    // generation fenced: a late settle of the dispose-flight is inert
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(d.accepted).toEqual([]);
    expect(d.controller.getState().generation).toBe(1);
  });

  it("a pending sub-threshold move is still force-saved by dispose (navigation never drops position)", () => {
    const d = makeControllerDeps();
    d.controller.flush(); // first save accepted below
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    // tiny move (< 1% AND < 48px) - the debounce would have deduped it:
    d.setPending(snapshot({ percent: 10.2, scrollTop: 1005 }));
    d.controller.dispose();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.scrollPosition).toBe(1005);
  });

  it("CROSS-GENERATION QUEUE: A's stale flight settling serves B's already-queued flush through the CURRENT context - B saves without another scroll", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.controller.flush(); // A's flight (percent 10), stays airborne
    d.controller.reset(); // navigate to B
    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 55, scrollTop: 5500, chapterNumber: "8" }));

    // B's own scroll debounce fires while A is still airborne -> queued
    // under B's generation (non-force, like a real debounce):
    d.controller.flush();
    expect(recordedSaves).toHaveLength(1);
    expect(d.controller.getState().queued).toEqual({ force: false, generation: 1 });

    // A settles - STALE flight, but CURRENT queue: B's flush is served
    // immediately, re-dispatched through the CURRENT context.
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(2);
    expect(recordedSaves[1].input.progressPercent).toBe(55);
    expect(d.controller.getState().queued).toBeNull();
  });

  it("a queue belonging to a DEAD generation is never served by any settle", () => {
    const d = makeControllerDeps({ context: { episodeId: 1 } });
    d.controller.flush(); // A's flight airborne
    d.controller.flush(true); // queue under generation 0
    expect(d.controller.getState().queued).toEqual({ force: true, generation: 0 });
    // navigation happens: dispose force-flushes (still queued behind the
    // airborne flight, still generation 0), then bumps the generation and
    // drops that dead-generation queue.
    d.controller.dispose();
    expect(d.controller.getState().queued).toBeNull();
    // A's flight settles afterwards - nothing may re-fire for any generation:
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(1); // only the original flight
  });

  it("USER SWITCH mid-flight: dispose saves the outgoing user's pending under their own context; the stale flight stays inert", () => {
    const d = makeControllerDeps({ context: { episodeId: 5, userId: "user-a" } });
    d.controller.flush();
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    const acceptedForUserA = d.accepted.length; // 1

    // user-a keeps reading (new pending, debounce not fired yet)...
    d.setPending(snapshot({ percent: 66, scrollTop: 6600 }));
    // ...then the account switches: cleanup dispose-flushes user-a's
    // pending under user-a's context even though refs already moved on.
    d.controller.dispose({ episodeId: 5, userId: "user-a", enabled: true });
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(5);
    expect(recordedSaves[1].input.progressPercent).toBe(66);
    expect(d.recoveryWrites.at(-1)?.context.userId).toBe("user-a");

    // The still-airborne user-a flight settling after the switch may
    // neither mark, accept, nor flush anything for whoever reads next.
    d.setContext({ userId: "user-b" });
    d.setPending(snapshot({ percent: 12, scrollTop: 1200 }));
    recordedSaves[1].handlers.onSuccess();
    recordedSaves[1].handlers.onSettled();
    expect(d.accepted.length).toBe(acceptedForUserA); // nothing new accepted
    expect(recordedSaves).toHaveLength(2); // no follow-up flight fired
    expect(d.controller.getState().lastMark).toBeNull(); // generation reset cleared the mark
  });
});

// ============================================================================
// createProgressSaveController - outgoing-episode handoff (R3)
// ============================================================================

describe("createProgressSaveController - outgoing-episode handoff (R3)", () => {
  it("P1: A's save (10%) airborne + A's latest 20% -> navigate (dispose) -> A settles -> the LATEST 20% is saved under episode A's context as a silent background flight", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // A's 10% flight, stays airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 })); // read on to 20%

    // navigate away: the 20% snapshot is parked (NOT lost with the pending
    // reset that follows in the caller), under A's own context
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    expect(d.controller.getState().outgoingQueue).toEqual([
      expect.objectContaining({
        context: { episodeId: 1, userId: "u1", enabled: true },
        snapshot: snapshot({ percent: 20, scrollTop: 2000 }),
        retriesUsed: 0,
      }),
    ]);

    // A's original flight settles -> handoff fires immediately
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(1);
    expect(recordedSaves[1].input.progressPercent).toBe(20);
    expect(recordedSaves[1].input.scrollPosition).toBe(2000);

    // background success must not touch the CURRENT generation's mark or
    // surface an "accepted" position (that would mark A's numbers for B)
    recordedSaves[1].handlers.onSuccess();
    recordedSaves[1].handlers.onSettled();
    expect(d.accepted).toEqual([]);
    expect(d.controller.getState().lastMark).toBeNull();
    expect(d.controller.getState().outgoingQueue).toHaveLength(0);
  });

  it("ORDERING: the outgoing handoff lands BEFORE episode B's queued save; B then saves normally", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // A@10% airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // park 20%

    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 55, scrollTop: 5500, chapterNumber: "8" }));
    d.controller.flush(); // B's debounce while A still airborne -> queued
    expect(recordedSaves).toHaveLength(1);

    // A@10% settles -> handoff A@20% fires FIRST...
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(1);
    expect(recordedSaves[1].input.progressPercent).toBe(20);

    // ...and only after the HANDOFF flight settles does B's queued save go out
    recordedSaves[1].handlers.onSuccess();
    recordedSaves[1].handlers.onSettled();
    expect(recordedSaves).toHaveLength(3);
    expect(recordedSaves[2].input.episodeId).toBe(2);
    expect(recordedSaves[2].input.progressPercent).toBe(55);
  });

  it("USER SWITCH: the outgoing handoff is never sent under the NEW user's session (dropped; recovery already holds it)", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "user-a" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // user-a's flight airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "user-a", enabled: true });
    // synchronous recovery under user-a happened at dispose:
    expect(d.recoveryWrites.some((w) => w.context.userId === "user-a" && w.pending.percent === 20)).toBe(true);

    // the account switches before the flight settles
    d.setContext({ episodeId: 1, userId: "user-b" });
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    // no handoff may fire with user-a's data on user-b's session:
    expect(recordedSaves).toHaveLength(1);
    expect(d.controller.getState().outgoingQueue).toHaveLength(0);
  });

  it("KNOWN LIMIT: if the airborne flight never settles (app closed), no handoff fires - nothing self-sends", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush();
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    // no settle -> exactly the original flight exists; the server keeps
    // 10% while local recovery holds 20% (documented limitation)
    expect(recordedSaves).toHaveLength(1);
  });

  it("background handoff retry retries ITS OWN context+snapshot (not the current pending)", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, retryDelayMs: () => 4000 });
      d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
      d.controller.flush();
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
      d.setContext({ episodeId: 2 });
      d.setPending(snapshot({ percent: 77, scrollTop: 7700 }));

      recordedSaves[0].handlers.onSettled(); // A@10% settles -> handoff A@20% fires
      expect(recordedSaves).toHaveLength(2);
      expect(recordedSaves[1].input.progressPercent).toBe(20);

      // handoff fails -> retries with ITS OWN episode 1 / 20% payload
      recordedSaves[1].handlers.onError();
      recordedSaves[1].handlers.onSettled();
      vi.advanceTimersByTime(4000);
      expect(recordedSaves).toHaveLength(3);
      expect(recordedSaves[2].input.episodeId).toBe(1);
      expect(recordedSaves[2].input.progressPercent).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DEDUPE: if the airborne flight already carries the exact pending position, dispose parks nothing (no duplicate API call)", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    const pos = snapshot({ percent: 10, scrollTop: 1000 });
    d.setPending(pos);
    d.controller.flush(); // airborne WITH this exact position
    // pending unchanged (user never scrolled past the debounce flush)
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    expect(d.controller.getState().outgoingQueue).toHaveLength(0);

    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(1); // no second save for the same position
  });
});

// ============================================================================
// createProgressSaveController - R4: bounded multi-episode handoff queue +
// isolated background retry
// ============================================================================

describe("createProgressSaveController - R4 outgoing queue & retry isolation", () => {
  it("REGRESSION (P1): A10 in-flight -> A20 outgoing -> B30 outgoing -> C: A settling must deliver BOTH A20 and B30, in order", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // A@10 airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // park A@20

    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 30, scrollTop: 3000 }));
    d.controller.dispose({ episodeId: 2, userId: "u1", enabled: true }); // park B@30

    d.setContext({ episodeId: 3 });
    d.setPending(null); // C not read yet
    d.controller.dispose({ episodeId: 3, userId: "u1", enabled: true }); // nothing parked
    expect(d.controller.getState().outgoingQueue).toHaveLength(2);

    // A@10 settles -> A@20 handoff fires; then ITS settle -> B@30 fires.
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(1);
    expect(recordedSaves[1].input.progressPercent).toBe(20);
    recordedSaves[1].handlers.onSuccess();
    recordedSaves[1].handlers.onSettled();
    expect(recordedSaves).toHaveLength(3);
    expect(recordedSaves[2].input.episodeId).toBe(2);
    expect(recordedSaves[2].input.progressPercent).toBe(30);
    expect(d.controller.getState().outgoingQueue).toHaveLength(0);
  });

  it("BOUNDED: parking more episodes than the cap keeps the queue at MAX_OUTGOING_HANDOFFS (oldest dropped)", () => {
    const d = makeControllerDeps({ context: { episodeId: 0, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // keep one flight airborne the whole time
    for (let ep = 1; ep <= MAX_OUTGOING_HANDOFFS + 3; ep++) {
      d.setPending(snapshot({ percent: 5 * ep, scrollTop: 500 * ep }));
      d.controller.dispose({ episodeId: ep, userId: "u1", enabled: true });
    }
    const q = d.controller.getState().outgoingQueue;
    expect(q).toHaveLength(MAX_OUTGOING_HANDOFFS);
    // the OLDEST handoffs (lowest episode ids) were the ones dropped
    expect(q.map((e) => e.context.episodeId)).toEqual(
      Array.from({ length: MAX_OUTGOING_HANDOFFS }, (_, i) => i + 4)
    );
  });

  it("PER-EPISODE DEDUPE: re-parking the same episode replaces its entry (latest wins within an episode)", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    d.setContext({ episodeId: 1 });
    d.setPending(snapshot({ percent: 25, scrollTop: 2500 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
    const q = d.controller.getState().outgoingQueue;
    expect(q).toHaveLength(1);
    expect(q[0].snapshot.percent).toBe(25);
  });

  it("PER-ENTRY USER GUARD: a foreign-user handoff is dropped while a same-user one later in the queue still fires", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "user-a" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // user-a's flight airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "user-a", enabled: true }); // park A@20 (user-a)

    // account switch, then user-b reads + navigates: B@30 parked under user-b
    d.setContext({ episodeId: 2, userId: "user-b" });
    d.setPending(snapshot({ percent: 30, scrollTop: 3000 }));
    d.controller.dispose({ episodeId: 2, userId: "user-b", enabled: true });

    // settle: A@20 must be dropped (cross-user), B@30 must still fire
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.episodeId).toBe(2);
    expect(recordedSaves[1].input.progressPercent).toBe(30);
  });

  it("REGRESSION (P2): background handoff failure does NOT hold or drop the current episode's queued save", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // A@10 airborne
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // park A@20

    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 55, scrollTop: 5500 }));
    d.controller.flush(); // B's debounce while A@10 airborne -> queued
    expect(d.controller.getState().queued).toEqual({ force: false, generation: 1 });

    // A@10 settles -> A@20 handoff fires -> it FAILS
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    recordedSaves[1].handlers.onError();
    recordedSaves[1].handlers.onSettled();

    // B@55 must go out IMMEDIATELY (not dropped, not waiting behind the
    // handoff's isolated retry)...
    expect(recordedSaves).toHaveLength(3);
    expect(recordedSaves[2].input.episodeId).toBe(2);
    expect(recordedSaves[2].input.progressPercent).toBe(55);

    // ...and the foreground backoff state was never touched by the
    // background failure (an ordinary flush still fires straight away):
    expect(d.controller.getState().awaitingRetry).toBe(false);
    expect(d.controller.getState().failures).toBe(0);
  });

  it("ISOLATED BOUNDED RETRY: the handoff retries once on its own timer with its own payload, then stops", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, backgroundRetryDelayMs: 300 });
      d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
      d.controller.flush();
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
      recordedSaves[0].handlers.onSettled(); // A@10 settles -> A@20 handoff fires
      expect(recordedSaves).toHaveLength(2);

      // handoff fails -> isolated retry scheduled at its OWN delay; the
      // foreground budget is untouched (awaitingRetry stays false):
      recordedSaves[1].handlers.onError();
      recordedSaves[1].handlers.onSettled();
      expect(d.controller.getState().awaitingRetry).toBe(false);

      // mid-wait, an ordinary foreground save fires and succeeds independently:
      d.setContext({ episodeId: 2 });
      d.setPending(snapshot({ percent: 42, scrollTop: 4200 }));
      d.controller.flush(true);
      recordedSaves[2].handlers.onSuccess();
      recordedSaves[2].handlers.onSettled();

      vi.advanceTimersByTime(299);
      expect(recordedSaves).toHaveLength(3);
      vi.advanceTimersByTime(1);
      // retry fires with the HANDOFF's own episode-1/20% payload:
      expect(recordedSaves).toHaveLength(4);
      expect(recordedSaves[3].input.episodeId).toBe(1);
      expect(recordedSaves[3].input.progressPercent).toBe(20);

      // retry fails too -> bounded: no further retry ever fires
      recordedSaves[3].handlers.onError();
      recordedSaves[3].handlers.onSettled();
      vi.advanceTimersByTime(60_000);
      expect(recordedSaves).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("STALENESS: a handoff (or its retry) whose episode already has a NEWER confirmed save never fires", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, backgroundRetryDelayMs: 300 });
      d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
      d.controller.flush(); // A@10 airborne
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // park A@20

      // A@10 settles -> A@20 handoff fires -> fails (retry pending)
      recordedSaves[0].handlers.onSettled();
      recordedSaves[1].handlers.onError();
      recordedSaves[1].handlers.onSettled();

      // user RETURNS to episode A and reads to 40% - the foreground save
      // succeeds while the handoff retry is still waiting:
      d.setContext({ episodeId: 1 });
      d.setPending(snapshot({ percent: 40, scrollTop: 4000 }));
      d.controller.flush(true);
      recordedSaves[2].handlers.onSuccess();
      recordedSaves[2].handlers.onSettled();

      // the pending retry of A@20 must be dropped as stale (A@40 already
      // confirmed) - never overwrite the newer position with 20%:
      vi.advanceTimersByTime(60_000);
      expect(recordedSaves).toHaveLength(3);
      expect(recordedSaves.map((s) => s.input.progressPercent)).toEqual([10, 20, 40]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// createProgressSaveController - R5: background flights never regress
// local recovery; per-entry independent bounded handoff retries
// ============================================================================

describe("createProgressSaveController - R5 data safety", () => {
  it("REGRESSION (P1): a background handoff never rewrites local recovery - a newer in-episode position survives it", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // A@10 airborne (foreground flush wrote recovery A@10)
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // parks A@20, writes recovery A@20

    // the user RETURNS to episode A and reads on to 40%: the ordinary
    // flush writes recovery A@40 (even though it queues behind the
    // airborne A@10 - recovery is written before the queue check)
    d.setContext({ episodeId: 1 });
    d.setPending(snapshot({ percent: 40, scrollTop: 4000 }));
    d.controller.flush(true);
    const ep1Writes = () => d.recoveryWrites.filter((w) => w.context.episodeId === 1);
    expect(ep1Writes().at(-1)?.pending.percent).toBe(40);

    // A@10 settles -> the A@20 handoff fires as a background flight...
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled();
    expect(recordedSaves).toHaveLength(2);
    expect(recordedSaves[1].input.progressPercent).toBe(20);
    // ...and it must NOT have stamped the OLD 20% over the 40% recovery:
    expect(ep1Writes().at(-1)?.pending.percent).toBe(40);
    // (the queued A@40 follow-up then lands normally, foreground)
    recordedSaves[1].handlers.onSuccess();
    recordedSaves[1].handlers.onSettled();
    expect(recordedSaves[2].input.progressPercent).toBe(40);
    expect(ep1Writes().at(-1)?.pending.percent).toBe(40);
  });

  it("P1 (app-close during handoff): the ONLY recovery writes are the foreground flushes and dispose itself - no handoff writes", () => {
    const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" } });
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // recovery write #1 (foreground A@10)
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // recovery write #2 (dispose A@20 - the true latest)
    const writesBeforeHandoff = d.recoveryWrites.length;

    // handoff fires and even FAILS: no additional recovery write may occur
    recordedSaves[0].handlers.onSettled();
    recordedSaves[1].handlers.onError();
    recordedSaves[1].handlers.onSettled();
    expect(d.recoveryWrites.length).toBe(writesBeforeHandoff);
    // so a reopen right after the app dies mid-handoff merges against the
    // true latest snapshot (A@20 from dispose) - never an extra
    // backwards-stamped copy.
  });

  it("REGRESSION (P2): A20 failing then B30 failing keeps BOTH pending retries - neither cancels the other, FIFO order", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, backgroundRetryDelayMs: 300 });
      d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
      d.controller.flush(); // A@10 airborne
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true }); // park A@20
      d.setContext({ episodeId: 2 });
      d.setPending(snapshot({ percent: 30, scrollTop: 3000 }));
      d.controller.dispose({ episodeId: 2, userId: "u1", enabled: true }); // park B@30

      // A@10 settles -> A@20 handoff fires -> fails (retry A queued)...
      recordedSaves[0].handlers.onSuccess();
      recordedSaves[0].handlers.onSettled();
      recordedSaves[1].handlers.onError();
      recordedSaves[1].handlers.onSettled();
      // ...its settle serves B@30 -> also fails (retry B queued AFTER A's)
      recordedSaves[2].handlers.onError();
      recordedSaves[2].handlers.onSettled();
      expect(recordedSaves).toHaveLength(3);

      // first retry pass: A@20 only (single-flight), FIFO before B@30
      vi.advanceTimersByTime(300);
      expect(recordedSaves).toHaveLength(4);
      expect(recordedSaves[3].input.episodeId).toBe(1);
      expect(recordedSaves[3].input.progressPercent).toBe(20);
      recordedSaves[3].handlers.onSuccess();
      recordedSaves[3].handlers.onSettled();

      // second pass: B@30's retry still happens - it was never cancelled
      vi.advanceTimersByTime(300);
      expect(recordedSaves).toHaveLength(5);
      expect(recordedSaves[4].input.episodeId).toBe(2);
      expect(recordedSaves[4].input.progressPercent).toBe(30);
      recordedSaves[4].handlers.onSuccess();
      recordedSaves[4].handlers.onSettled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("P2: a busy foreground save delays queued retries instead of dropping them", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, backgroundRetryDelayMs: 300 });
      d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
      d.controller.flush();
      d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
      d.controller.dispose({ episodeId: 1, userId: "u1", enabled: true });
      recordedSaves[0].handlers.onSettled(); // A@20 handoff fires
      recordedSaves[1].handlers.onError(); // -> retry queued
      recordedSaves[1].handlers.onSettled();

      // a FOREGROUND save takes the slot right before the retry timer fires
      d.setContext({ episodeId: 2 });
      d.setPending(snapshot({ percent: 60, scrollTop: 6000 }));
      d.controller.flush(true);
      expect(recordedSaves[2].input.progressPercent).toBe(60);

      // retry pass fires while the foreground save is airborne: it must be
      // rescheduled (not dropped, not fired over the slot)...
      vi.advanceTimersByTime(300);
      expect(recordedSaves).toHaveLength(3);
      // ...and once the foreground flight settles, the next pass delivers it
      recordedSaves[2].handlers.onSuccess();
      recordedSaves[2].handlers.onSettled();
      vi.advanceTimersByTime(300);
      expect(recordedSaves).toHaveLength(4);
      expect(recordedSaves[3].input.episodeId).toBe(1);
      expect(recordedSaves[3].input.progressPercent).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// createProgressSaveController - R6: background retries survive
// navigation-driven generation bumps (generation guard split by flight kind)
// ============================================================================

describe("createProgressSaveController - R6 retry across generations", () => {
  const runScenarioToFailure = (d: ReturnType<typeof makeControllerDeps>, userId: string) => {
    // A@10 in-flight -> park A@20 -> A@10 settles -> A@20 handoff in-flight
    d.setPending(snapshot({ percent: 10, scrollTop: 1000 }));
    d.controller.flush(); // flight[0]: A@10, gen 0
    d.setPending(snapshot({ percent: 20, scrollTop: 2000 }));
    d.controller.dispose({ episodeId: 1, userId, enabled: true }); // park A@20, gen -> 1
    recordedSaves[0].handlers.onSuccess();
    recordedSaves[0].handlers.onSettled(); // serve -> flight[1]: A@20 background, gen 1

    // read B to 30% and navigate on (B->C): park B@30, gen -> 2 - the
    // A@20 flight is now stale-generation while STILL airborne
    d.setContext({ episodeId: 2 });
    d.setPending(snapshot({ percent: 30, scrollTop: 3000 }));
    d.controller.dispose({ episodeId: 2, userId, enabled: true });
    return recordedSaves[1];
  };

  it("REGRESSION: A20 failing after a generation bump still gets its policy retry; B30 sends in order; retry capped at 1; recovery never regresses", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "u1" }, backgroundRetryDelayMs: 300 });
      const handoffFlight = runScenarioToFailure(d, "u1");
      expect(d.controller.getState().generation).toBe(2); // flight[1] is gen-stale

      // A@20 FAILS - despite generation !== flightGeneration, its retry
      // must be scheduled (the entry's own context/snapshot is what counts)
      handoffFlight.handlers.onError();
      handoffFlight.handlers.onSettled();

      // its settle serves B@30 in order (background failure never holds
      // the outgoing queue)
      expect(recordedSaves).toHaveLength(3);
      expect(recordedSaves[2].input.episodeId).toBe(2);
      expect(recordedSaves[2].input.progressPercent).toBe(30);
      recordedSaves[2].handlers.onSuccess();
      recordedSaves[2].handlers.onSettled();

      // the A@20 retry fires after its delay, under episode 1's context
      vi.advanceTimersByTime(300);
      expect(recordedSaves).toHaveLength(4);
      expect(recordedSaves[3].input.episodeId).toBe(1);
      expect(recordedSaves[3].input.progressPercent).toBe(20);

      // capped at ONE retry: failing again schedules nothing further
      recordedSaves[3].handlers.onError();
      recordedSaves[3].handlers.onSettled();
      vi.advanceTimersByTime(60_000);
      expect(recordedSaves).toHaveLength(4);

      // local recovery for episode 1 only ever got the foreground A@10
      // write and the dispose-time A@20 write - no background writes
      const ep1 = d.recoveryWrites.filter((w) => w.context.episodeId === 1);
      expect(ep1.map((w) => w.pending.percent)).toEqual([10, 20]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("USER SWITCH: the scheduled cross-generation retry is dropped at fire time when the session user changed", () => {
    vi.useFakeTimers();
    try {
      const d = makeControllerDeps({ context: { episodeId: 1, userId: "user-a" }, backgroundRetryDelayMs: 300 });
      const handoffFlight = runScenarioToFailure(d, "user-a");
      handoffFlight.handlers.onError();
      handoffFlight.handlers.onSettled(); // retry scheduled; B@30 in flight
      recordedSaves[2].handlers.onSuccess();
      recordedSaves[2].handlers.onSettled();

      // the account switches while the A@20 retry is still waiting
      d.setContext({ episodeId: 9, userId: "user-b" });
      vi.advanceTimersByTime(60_000);
      // user-a's A@20 must never be sent on user-b's session
      expect(recordedSaves).toHaveLength(3);
      expect(recordedSaves.map((s) => s.input.progressPercent)).toEqual([10, 20, 30]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// createResumeVerifier - user intent vs. layout shift
// ============================================================================

describe("createResumeVerifier", () => {
  const target = snapshot({ percent: 40, scrollTop: 4000 });

  const makeVerifier = (windowMs = 2000) => {
    const applyCalls: ReadingPositionSnapshot[] = [];
    let now = 1_000_000;
    const verifier = createResumeVerifier({
      apply: (t) => {
        applyCalls.push(t);
        return t.scrollTop;
      },
      now: () => now,
      windowMs,
    });
    return { verifier, applyCalls, advance: (ms: number) => (now += ms) };
  };

  it("re-asserts the target on every step while the window is open (layout shifts don't cancel)", () => {
    const v = makeVerifier();
    v.verifier.arm(target);
    v.verifier.step();
    v.verifier.step();
    v.advance(500);
    v.verifier.step();
    expect(v.applyCalls).toHaveLength(3);
    expect(v.verifier.isActive()).toBe(true);
    expect(v.verifier.getEndReason()).toBeNull();
  });

  it("LAYOUT SHIFT regression: a scrollTop change with no explicit input signal is NOT treated as the user - restore continues", () => {
    const v = makeVerifier();
    v.verifier.arm(target);
    v.verifier.step();
    // (no notifyUserIntent - the old heuristic read the container itself;
    // the verifier deliberately has no such input)
    v.verifier.step();
    expect(v.verifier.isActive()).toBe(true);
    expect(v.applyCalls).toHaveLength(2);
  });

  it("explicit user intent (wheel/touch/pointer/nav-key/TOC click) ends the window immediately and stops re-applying", () => {
    const v = makeVerifier();
    v.verifier.arm(target);
    v.verifier.step();
    v.verifier.notifyUserIntent();
    expect(v.verifier.isActive()).toBe(false);
    expect(v.verifier.getEndReason()).toBe("user");
    v.verifier.step(); // inert
    expect(v.applyCalls).toHaveLength(1);
  });

  it("the window expires on its own after windowMs and the last step ends it", () => {
    const v = makeVerifier(2000);
    v.verifier.arm(target);
    v.advance(1999);
    v.verifier.step();
    expect(v.verifier.isActive()).toBe(true);
    v.advance(2);
    v.verifier.step();
    expect(v.verifier.isActive()).toBe(false);
    expect(v.verifier.getEndReason()).toBe("expired");
  });

  it("cancel() ends the window as manual and notifyUserIntent when unarmed is a no-op", () => {
    const v = makeVerifier();
    expect(() => v.verifier.notifyUserIntent()).not.toThrow();
    v.verifier.arm(target);
    v.verifier.cancel();
    expect(v.verifier.getEndReason()).toBe("manual");
    v.verifier.step();
    expect(v.applyCalls).toHaveLength(0);
  });

  it("re-arming after an ended window starts fresh (intent from the previous window cleared)", () => {
    const v = makeVerifier();
    v.verifier.arm(target);
    v.verifier.notifyUserIntent();
    v.verifier.arm(target);
    expect(v.verifier.isActive()).toBe(true);
    v.verifier.step();
    expect(v.applyCalls).toHaveLength(1);
  });
});
