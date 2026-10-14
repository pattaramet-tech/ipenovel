import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { auth } = vi.hoisted(() => ({
  auth: { role: "author" as string | null, loading: false },
}));
vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ loading: auth.loading, user: auth.role ? { role: auth.role } : null }),
}));
vi.mock("./WorkspacePage", () => ({ default: () => "PLATFORM_ADMIN_WORKSPACE" }));
vi.mock("./AuthorWorkspacePage", () => ({ default: () => "AUTHOR_OWN_READ_ONLY_WORKSPACE" }));

import WorkspaceRoutePage from "./WorkspaceRoutePage";

describe("IPE-070R4A-R2 rendered Workspace route dispatch", () => {
  it("renders Author read-only component for Authors, not the Admin editor", () => {
    auth.role = "author";
    auth.loading = false;
    const html = renderToStaticMarkup(createElement(WorkspaceRoutePage));
    expect(html).toContain("AUTHOR_OWN_READ_ONLY_WORKSPACE");
    expect(html).not.toContain("PLATFORM_ADMIN_WORKSPACE");
  });

  it("preserves original Workspace for Platform Admin", () => {
    auth.role = "admin";
    auth.loading = false;
    const html = renderToStaticMarkup(createElement(WorkspaceRoutePage));
    expect(html).toContain("PLATFORM_ADMIN_WORKSPACE");
    expect(html).not.toContain("AUTHOR_OWN_READ_ONLY_WORKSPACE");
  });

  it("never mounts an editor while authentication is loading", () => {
    auth.loading = true;
    auth.role = "admin";
    const html = renderToStaticMarkup(createElement(WorkspaceRoutePage));
    expect(html).toContain("Loading Workspace");
    expect(html).not.toContain("PLATFORM_ADMIN_WORKSPACE");
    auth.loading = false;
  });
});
