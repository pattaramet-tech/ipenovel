import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("M26 NQA Admin UI composition", () => {
  it("mounts the admin-only route and navigation item", () => {
    const app = read("client/src/App.tsx");
    const nav = read("client/src/config/adminNavItems.ts");
    const router = read("server/nqa/admin/router.ts");
    const appRouter = read("server/routers.ts");

    expect(app).toContain('path="/admin/nqa"');
    expect(nav).toContain('href: "/admin/nqa"');
    expect(appRouter).toContain("nqa: nqaAdminRouter");
    expect(router).toContain("authenticatedProcedure.use");
    expect(router).toContain('ctx.user.role !== "admin"');
  });

  it("reuses Workspace Auto-Link APIs instead of duplicating the matcher in React", () => {
    const page = read("client/src/pages/AdminNqaPage.tsx");
    expect(page).toContain("trpc.workspace.nqaNovelLink.status");
    expect(page).toContain("trpc.workspace.nqaNovelLink.preview");
    expect(page).toContain("trpc.workspace.nqaNovelLink.confirmBackfill");
    expect(page).not.toContain("exactNqaNovelTitleCandidates");
  });

  it("keeps QA and writeback behind the NQA gateway and fail-closed remediation", () => {
    const runtime = read("server/nqa/admin/runtime.ts");
    const writeback = read("server/nqa/admin/writeback.ts");
    const control = read("server/nqa/controlPlane.ts");
    const autolink = read("server/workspace/nqaAutolink.runtime.ts");

    expect(runtime).toContain("new NqaMcpGateway");
    expect(runtime).toContain('"nqa.novel.resolve_identity"');
    expect(runtime).toContain('"nqa.qa.run_semantic"');
    expect(runtime).toContain('"nqa.qa.run_deterministic"');
    expect(runtime).toContain("JsonlNqaAdminGatewayAuditSink");
    expect(writeback).toContain('"nqa.result.writeback_preview"');
    expect(writeback).toContain('"nqa.result.writeback_confirm"');
    expect(control).toContain('"nqa.result.writeback_confirm": {');
    expect(control).toContain('requiredPermission: "REMEDIATION"');
    expect(control).toMatch(
      /export const NQA_V1_ENABLED_PERMISSION_TIERS = \[\r?\n\s+"READ",\r?\n\s+"QA_OPERATE",/
    );
    expect(autolink).toContain(
      'const REMEDIATION_ENABLED_ENV = "NQA_AUTOLINK_REMEDIATION_ENABLED"'
    );
    expect(autolink).toContain('env[REMEDIATION_ENABLED_ENV] === "true"');
  });

  it("never exposes Google token values through the UI or persisted run contract", () => {
    const page = read("client/src/pages/AdminNqaPage.tsx");
    const contracts = read("server/nqa/admin/contracts.ts");
    expect(page).not.toMatch(/GOOGLE_(?:READ|WRITE)_ACCESS_TOKEN/);
    expect(contracts).not.toMatch(
      /accessToken|refreshToken|encryptedRefreshToken/
    );
    expect(contracts).toContain("resultFingerprint");
  });
});
