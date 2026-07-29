import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { shouldEnableHybridHealthSummary } from "./hybridHealthSummaryGate";

/**
 * Review follow-up (TiDB errno=8176 incident): backend Overview and Summary
 * are each internally sequential, but AdminHybridHealthPage previously
 * enabled both `overview.useQuery` and `summary.useQuery` on the identical
 * `selectedNovelId === null` condition, so the browser could still fire
 * Overview's and Summary's DB-heavy queries in the same render on initial
 * page load. These tests cover the pure gating logic directly, plus a
 * source-text check (this repo has no component/DOM test harness - see
 * authClientStorage.test.ts for the same pattern) that the page actually
 * wires the gate + the required react-query options.
 */
describe("shouldEnableHybridHealthSummary", () => {
  it("initial state (overview loading, no data yet) -> disabled", () => {
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: null,
        hasOverviewData: false,
        isOverviewLoading: true,
        isOverviewError: false,
      })
    ).toBe(false);
  });

  it("overview error -> disabled, even if stale data happens to still be present", () => {
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: null,
        hasOverviewData: false,
        isOverviewLoading: false,
        isOverviewError: true,
      })
    ).toBe(false);
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: null,
        hasOverviewData: true,
        isOverviewLoading: false,
        isOverviewError: true,
      })
    ).toBe(false);
  });

  it("overview success (has data, not loading, no error) -> enabled", () => {
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: null,
        hasOverviewData: true,
        isOverviewLoading: false,
        isOverviewError: false,
      })
    ).toBe(true);
  });

  it("a novel selected (Detail view open) -> disabled regardless of overview state", () => {
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: 42,
        hasOverviewData: true,
        isOverviewLoading: false,
        isOverviewError: false,
      })
    ).toBe(false);
  });

  it("overview still loading despite having previous data (e.g. a background refetch) -> disabled", () => {
    expect(
      shouldEnableHybridHealthSummary({
        selectedNovelId: null,
        hasOverviewData: true,
        isOverviewLoading: true,
        isOverviewError: false,
      })
    ).toBe(false);
  });
});

describe("AdminHybridHealthPage - summary query wiring (source-text assertions)", () => {
  const pageSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminHybridHealthPage.tsx"),
    "utf8"
  );

  it("gates the summary query with shouldEnableHybridHealthSummary, not the same condition as overview", () => {
    expect(pageSource).toMatch(/shouldEnableHybridHealthSummary\(/);
    expect(pageSource).toMatch(/enabled:\s*shouldLoadSummary/);
    // Overview's own enabled condition must NOT be reused verbatim for summary.
    const summaryQueryBlock = pageSource.slice(pageSource.indexOf("hybridHealth.summary.useQuery"));
    expect(summaryQueryBlock).not.toMatch(/enabled:\s*selectedNovelId === null/);
  });

  it("summary query disables retry and refetchOnWindowFocus", () => {
    const summaryQueryBlock = pageSource.slice(
      pageSource.indexOf("hybridHealth.summary.useQuery"),
      pageSource.indexOf("hybridHealth.summary.useQuery") + 400
    );
    expect(summaryQueryBlock).toMatch(/NO_RETRY_QUERY_OPTIONS/);
    expect(pageSource).toMatch(/retry:\s*false/);
    expect(pageSource).toMatch(/refetchOnWindowFocus:\s*false/);
  });

  it("summary query sets staleTime to 5 minutes (300000ms), matching the server's in-process cache TTL", () => {
    expect(pageSource).toMatch(/SUMMARY_STALE_TIME_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
    const summaryQueryBlock = pageSource.slice(
      pageSource.indexOf("hybridHealth.summary.useQuery"),
      pageSource.indexOf("hybridHealth.summary.useQuery") + 400
    );
    expect(summaryQueryBlock).toMatch(/staleTime:\s*SUMMARY_STALE_TIME_MS/);
    expect(5 * 60 * 1000).toBe(300000);
  });

  it("overview query also disables retry and refetchOnWindowFocus", () => {
    const overviewQueryBlock = pageSource.slice(
      pageSource.indexOf("hybridHealth.overview.useQuery"),
      pageSource.indexOf("hybridHealth.overview.useQuery") + 300
    );
    expect(overviewQueryBlock).toMatch(/NO_RETRY_QUERY_OPTIONS/);
  });
});
