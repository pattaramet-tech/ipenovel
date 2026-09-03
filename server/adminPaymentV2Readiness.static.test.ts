import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const routers = fs.readFileSync(path.resolve(process.cwd(), "server/routers.ts"), "utf8");

describe("IPE-021-D admin Payment V2 readiness exposure", () => {
  it("exposes a read-only admin.payments.v2Readiness query backed by the fail-closed readiness service", () => {
    expect(routers).toMatch(/payments:\s*router\(\{[\s\S]*?v2Readiness:\s*adminProcedure\.query/);
    expect(routers).toMatch(/return getPaymentApprovalV2GlobalReadiness\(\);/);
    expect(routers).not.toMatch(/v2Readiness:\s*(?:publicProcedure|protectedProcedure)\b/);
  });
});
