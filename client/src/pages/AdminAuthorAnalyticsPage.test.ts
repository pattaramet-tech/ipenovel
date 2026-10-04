import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminAuthorAnalyticsPage.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("AdminAuthorAnalyticsPage source contract", () => {
  it("uses the self-scoped admin.authorAnalytics.summary endpoint", () => {
    expect(source).toContain("trpc.admin.authorAnalytics.summary.useQuery");
    expect(source).not.toMatch(/author(User)?Id\s*:/);
  });

  it("gates the query with the shared admin access resolver", () => {
    expect(source).toContain('resolveAdminAccessState({ loading: authLoading, user, authMeError }) === "allowed"');
    expect(source).toContain("{ enabled: shouldFetch }");
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
    // No author/user id selector exists — the identity is the signed-in admin.
    expect(source).not.toMatch(/author(User)?Id\s*:/);
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
