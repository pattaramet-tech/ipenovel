import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminAuthorAnalyticsPage.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

// IPE-070: the ONE legitimate author-target field in this page is the
// admin drill-down input for admin.authorSales.author. Everything
// self-scoped (summary/profile) must never carry an id.
const authorIdOccurrences = source.match(/author(User)?Id\s*:/g) ?? [];

describe("AdminAuthorAnalyticsPage source contract", () => {
  it("uses the self-scoped admin.authorAnalytics.summary endpoint for the author view", () => {
    expect(source).toContain("trpc.admin.authorAnalytics.summary.useQuery");
    // The summary input stays identity-free: period/month/date bounds only.
    const summaryInput = source.slice(
      source.indexOf("trpc.admin.authorAnalytics.summary.useQuery"),
      source.indexOf("{ enabled: shouldFetch && !isAdmin && rangeGateOpen }")
    );
    expect(summaryInput).not.toMatch(/author(User)?Id\s*:/);
    expect(summaryInput).toContain("period");
  });

  it("enables analytics and profile queries for a catalog operator, not the platform-admin gate", () => {
    expect(source).toContain('resolveCatalogFetchState({ loading: authLoading, user, authMeError }) === "allowed"');
    expect(source).not.toContain("resolveAdminAccessState");
    expect(source).toContain("trpc.admin.authorAnalytics.summary.useQuery");
    expect(source).toContain("enabled: shouldFetch");
  });

  it("labels wishlist as a current-state metric rather than period sales", () => {
    expect(source).toContain("Current Wishlists");
    expect(source).toContain("Current Wishlists is a current-state count and is not period-filtered.");
  });

  it("shows order/payment and wallet-direct sales separately", () => {
    expect(source).toContain("Order / payment");
    expect(source).toContain("Wallet direct");
  });
});

describe("IPE-063R1 author profile section", () => {
  it("edits only the pen name through the self-scoped authorProfile endpoints", () => {
    expect(source).toContain("trpc.admin.authorProfile.get.useQuery");
    expect(source).toContain("trpc.admin.authorProfile.update.useMutation");
    expect(source).toContain("updateProfileMutation.mutate({");
    // No author/user id reaches the profile mutation — the identity is the
    // signed-in user; the only authorId field allowed anywhere is the admin
    // drill-down below.
    const mutateInput = source.slice(
      source.indexOf("updateProfileMutation.mutate({"),
      source.indexOf("});", source.indexOf("updateProfileMutation.mutate({"))
    );
    expect(mutateInput).toContain("authorName");
    expect(mutateInput).not.toMatch(/author(User)?Id\s*:/);
    expect(source).toContain('data-testid="save-author-name"');
  });

  it("shows the effective author name and labels the account-name fallback", () => {
    expect(source).toContain('data-testid="author-effective-name"');
    expect(source).toContain("(using account name)");
    expect(source).toContain("ชื่อ Author นี้จะแสดงกับนิยายทั้งหมดที่เป็นของบัญชีนี้");
  });

  it("refreshes analytics + profile after save without a full reload", () => {
    expect(source).toContain("await Promise.all([profileQuery.refetch(), refetchSummary()])");
    expect(source).toContain('toast.success(');
    expect(source).not.toContain("window.location.reload");
  });
});

describe("IPE-063R3 analytics error state", () => {
  it("renders a visible error card with retry instead of fake zero metrics", () => {
    expect(source).toContain('data-testid="author-analytics-error"');
    expect(source).toContain('data-testid="author-analytics-retry"');
    expect(source).toContain("โหลดข้อมูล Author Analytics ไม่สำเร็จ");
    expect(source).toContain("refetchSummary()");
    // Error branch must come BEFORE the loading/success render and must not
    // fall through to the metric grid. (The admin cross-author branches
    // precede the self-view block and carry their own error cards.)
    const errorIdx = source.indexOf('data-testid="author-analytics-error"');
    const zeroMetrics = source.indexOf('data?.totalNovels ?? 0', errorIdx);
    expect(errorIdx).toBeGreaterThan(-1);
    expect(zeroMetrics).toBeGreaterThan(errorIdx);
  });

  it("never reports an empty-novel claim from an undefined dataset", () => {
    // The empty-novel message is only reachable in the success branch.
    const emptyIdx = source.indexOf("You do not have any novels assigned to this Author account yet.");
    const errorIdx = source.indexOf('data-testid="author-analytics-error"');
    expect(emptyIdx).toBeGreaterThan(errorIdx);
  });

  it("renders error cards with retry for the admin cross-author queries too", () => {
    expect(source).toContain('data-testid="author-sales-authors-error"');
    expect(source).toContain('data-testid="author-sales-authors-retry"');
    expect(source).toContain('data-testid="author-sales-author-error"');
    expect(source).toContain('data-testid="author-sales-author-retry"');
  });
});

describe("IPE-070 admin sales-by-selected-date section", () => {
  it("gates the cross-author report behind the admin role client-side", () => {
    expect(source).toContain("const isAdmin = user?.role === \"admin\";");
    expect(source).toContain("trpc.admin.authorSales.authors.useQuery");
    expect(source).toContain("trpc.admin.authorSales.author.useQuery");
    // The summary (self) query is disabled for admins; the cross-author
    // queries are disabled for everyone else.
    expect(source).toContain("{ enabled: shouldFetch && !isAdmin && rangeGateOpen }");
    expect(source).toContain("{ enabled: shouldFetch && isAdmin && rangeGateOpen }");
    expect(source).toContain("enabled: shouldFetch && isAdmin && selectedAuthor !== \"all\" && rangeGateOpen");
  });

  it("sends an author target only inside the admin drill-down query", () => {
    // Exactly one author-target field in the whole page, and it belongs to
    // admin.authorSales.author (server-side adminProcedure re-checks).
    expect(authorIdOccurrences).toHaveLength(1);
    const detailCallIdx = source.indexOf("trpc.admin.authorSales.author.useQuery");
    const authorIdIdx = source.search(/author(User)?Id\s*:/);
    expect(authorIdIdx).toBeGreaterThan(detailCallIdx);
  });

  it("offers an all-authors default and per-author options keyed by owner id", () => {
    expect(source).toContain('data-testid="author-sales-option-all"');
    expect(source).toContain('selectedAuthor === "all" ? "all" : String(selectedAuthor)');
    expect(source).toContain("data-testid={`author-sales-option-${author.authorUserId}`}");
  });

  it("adds a custom date range with start/end calendar inputs and inline validation", () => {
    expect(source).toContain('value: "custom_range", label: "Custom range"');
    expect(source).toContain('data-testid="custom-range-start"');
    expect(source).toContain('data-testid="custom-range-end"');
    expect(source).toContain('data-testid="custom-range-invalid"');
    // The query inputs are only populated from a complete, locally-valid
    // pair; the server re-validates as real Bangkok calendar days.
    expect(source).toContain("customRangeReady");
    expect(source).toContain("rangeStart <= rangeEnd");
    expect(source).toContain("Asia/Bangkok");
  });

  it("never renders metric sections while the custom range is incomplete", () => {
    // An incomplete range keeps the queries disabled; the pending gate must
    // branch BEFORE every data section so no fake zeros can render.
    const pendingIdx = source.indexOf('data-testid="custom-range-pending"');
    const adminAllIdx = source.indexOf('data-testid="author-sales-select-trigger"');
    const selfZeroIdx = source.indexOf('data?.totalNovels ?? 0');
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeLessThan(selfZeroIdx);
    expect(pendingIdx).toBeLessThan(source.indexOf('data-testid="author-sales-authors-error"'));
  });

  it("renders grand totals from the full grouped report, not a Top-N", () => {
    expect(source).toContain("authorsReportQuery.data?.totals.totalRevenue ?? 0");
    expect(source).toContain("ยอดรวมคำนวณจากทุก Author ในตาราง (ไม่ใช่ Top-N) ตามช่วงวันที่เลือก");
    expect(source).toContain("Sales by author");
  });
});
