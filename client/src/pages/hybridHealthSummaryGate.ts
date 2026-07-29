/**
 * Whether the Hybrid Content Health Summary query (the KPI cards' bounded
 * batch scan) should be enabled right now. Pure and DOM-free so it can be
 * unit-tested directly (this repo has no component/DOM test harness) - see
 * navbarVisibility.ts for the same pattern.
 *
 * Hotfix follow-up (TiDB errno=8176 memory-limit incident): the backend
 * Overview and Summary procedures are each internally sequential, but
 * AdminHybridHealthPage previously created both `overview.useQuery` and
 * `summary.useQuery` with `enabled: selectedNovelId === null` - identical
 * conditions - so React fired them in the same render, and the Overview's
 * candidate-id/count queries could still run concurrently with the
 * Summary's total-novel-count/batch queries on initial page load. Gating
 * Summary on Overview having already succeeded makes the two requests
 * strictly sequential from the browser's perspective too, not just within
 * each procedure.
 */
export interface HybridHealthSummaryGateParams {
  selectedNovelId: number | null;
  hasOverviewData: boolean;
  isOverviewLoading: boolean;
  isOverviewError: boolean;
}

export function shouldEnableHybridHealthSummary(params: HybridHealthSummaryGateParams): boolean {
  return (
    params.selectedNovelId === null &&
    params.hasOverviewData &&
    !params.isOverviewLoading &&
    !params.isOverviewError
  );
}
