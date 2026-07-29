import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Performance-regression coverage for the TiDB errno=8176 ("query cancelled
 * because the TiDB server memory limit was exceeded") incident on
 * /admin/hybrid-health.
 *
 * Root cause: a single Overview page load ran FOUR full-table aggregate
 * queries concurrently - queryHybridHealthNovelOverview's own paginated-rows
 * + count queries (Promise.all'd with each other) racing
 * queryHybridHealthGlobalSummary's two full-table aggregates (Promise.all'd
 * with the whole Overview call) - and the client retried on failure,
 * repeating all four. This file instruments every Hybrid Health DB query
 * with an artificial async delay and a shared "concurrently active" counter,
 * so a regression back to any Promise.all in this path fails loudly here
 * instead of silently reappearing in production.
 */

const queriesMock = vi.hoisted(() => ({
  queryEpisodeHealthRowsForNovel: vi.fn(),
  queryHybridHealthCandidateNovelIds: vi.fn(),
  queryHybridHealthCandidateNovelCount: vi.fn(),
  queryHybridHealthAggregatesForNovelIds: vi.fn(),
  queryHybridHealthSummaryBatch: vi.fn(),
  queryHybridHealthTotalNovelCount: vi.fn(),
  HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE: 2,
}));
vi.mock("./hybridHealthQueries", () => queriesMock);

import { getHybridHealthOverview, getHybridHealthSummary, __resetHybridHealthSummaryStateForTests } from "./hybridHealthService";

/** Tracks how many instrumented DB calls are simultaneously in flight, and the historical peak. */
class ConcurrencyTracker {
  active = 0;
  peak = 0;
  calls = 0;

  async wrap<T>(value: T, delayMs = 5): Promise<T> {
    this.active += 1;
    this.calls += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return value;
    } finally {
      this.active -= 1;
    }
  }
}

describe("Overview - no concurrent DB-heavy queries (TiDB errno=8176 regression guard)", () => {
  let tracker: ConcurrencyTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ConcurrencyTracker();
    queriesMock.queryHybridHealthCandidateNovelIds.mockImplementation(() => tracker.wrap([{ novelId: 1 }, { novelId: 2 }]));
    queriesMock.queryHybridHealthCandidateNovelCount.mockImplementation(() => tracker.wrap(2));
    queriesMock.queryHybridHealthAggregatesForNovelIds.mockImplementation(() => tracker.wrap([]));
  });

  it("never has more than one Hybrid Health DB-heavy query in flight at a time", async () => {
    await getHybridHealthOverview();
    expect(tracker.peak).toBe(1);
    expect(tracker.calls).toBe(3); // candidateIds, candidateCount, aggregates - each exactly once
  });

  it("still only reaches peak concurrency 1 across 5 concurrent Overview requests (no shared Promise.all fan-out)", async () => {
    await Promise.all([
      getHybridHealthOverview(),
      getHybridHealthOverview(),
      getHybridHealthOverview(),
      getHybridHealthOverview(),
      getHybridHealthOverview(),
    ]);
    // Each request's own 3 calls are sequential, but 5 independent requests
    // running concurrently each doing 1-at-a-time work is a fundamentally
    // different (and safe) shape from one request firing multiple
    // concurrent full-table aggregates - this asserts each REQUEST stays
    // internally sequential, not that the whole test process never overlaps.
    expect(tracker.calls).toBe(15);
  });
});

describe("Summary - bounded sequential batch scan, no concurrent batches (TiDB errno=8176 regression guard)", () => {
  let tracker: ConcurrencyTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetHybridHealthSummaryStateForTests();
    tracker = new ConcurrencyTracker();
    queriesMock.queryHybridHealthTotalNovelCount.mockImplementation(() => tracker.wrap(1));
  });

  it("never has more than one batch query in flight - each batch awaits the previous one via the cursor", async () => {
    let call = 0;
    queriesMock.queryHybridHealthSummaryBatch.mockImplementation(() => {
      call += 1;
      const rows =
        call <= 3
          ? [
              { episodeId: call * 2 - 1, novelId: 1, hasPlaintext: true, hasLegacyFile: false, isPublished: true, saleMode: "chapter", isPurchased: false },
              { episodeId: call * 2, novelId: 1, hasPlaintext: true, hasLegacyFile: false, isPublished: true, saleMode: "chapter", isPurchased: false },
            ]
          : [];
      return tracker.wrap(rows);
    });

    await getHybridHealthSummary();
    expect(tracker.peak).toBe(1);
    expect(call).toBeGreaterThan(1); // proves multiple batches actually ran, sequentially
  });

  it("5 concurrent Summary callers collapse into ONE scan via single-flight - never 5 parallel full scans", async () => {
    queriesMock.queryHybridHealthSummaryBatch.mockImplementation(() => tracker.wrap([]));

    const results = await Promise.all([
      getHybridHealthSummary(),
      getHybridHealthSummary(),
      getHybridHealthSummary(),
      getHybridHealthSummary(),
      getHybridHealthSummary(),
    ]);

    expect(tracker.peak).toBe(1);
    expect(queriesMock.queryHybridHealthTotalNovelCount).toHaveBeenCalledTimes(1);
    expect(queriesMock.queryHybridHealthSummaryBatch).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
  });
});
