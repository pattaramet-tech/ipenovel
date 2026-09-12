import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routerSource = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../../client/src/pages/WorkspacePage.tsx", import.meta.url), "utf8");
const accessSource = readFileSync(new URL("./adminAccess.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("./service.ts", import.meta.url), "utf8");

describe("Workspace global platform-admin access contract", () => {
  it("gates every Workspace tRPC surface with the shared platform admin procedure", () => {
    expect(routerSource).toContain('import { adminProcedure, router } from "../_core/trpc";');
    expect(routerSource).not.toContain("authenticatedProcedure");
    expect(routerSource).toContain("list: adminProcedure.query");
    expect(routerSource).toContain("create: adminProcedure");
    expect(routerSource).toContain("requestExecution: adminProcedure");
    expect(routerSource).toContain("cutover: adminProcedure");
    expect(routerSource).toContain("rollback: adminProcedure");
  });

  it("uses platform-admin status, not workspace membership, as the service authorization boundary", () => {
    expect(accessSource).toContain('user.role !== "admin"');
    expect(serviceSource).toContain("await requireWorkspacePlatformAdmin(db, userId)");
    expect(serviceSource).toContain("return rows.map((workspace: any) => ({ workspace, membership: null }))");
  });

  it("guards the /workspace UI and presents equal authority for every platform admin", () => {
    expect(pageSource).toContain('import { useAdminGuard } from "@/hooks/useAdminGuard";');
    expect(pageSource).toContain("const { isAdmin, loading: adminLoading } = useAdminGuard();");
    expect(pageSource).not.toContain("auth.isAuthenticated");
    expect(pageSource).toContain("enabled: isAdmin");
    expect(pageSource).toContain("if (!isAdmin) return null;");
    expect(pageSource).toContain("All platform admins can open every active workspace.");
    expect(pageSource).not.toContain("Membership role:");
  });
});
