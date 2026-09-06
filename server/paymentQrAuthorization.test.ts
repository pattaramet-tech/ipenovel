import { describe, expect, it, vi } from "vitest";
vi.mock("./_core/accountMergeSessionGate", () => ({
  isCompletedAccountMergeSource: vi.fn().mockResolvedValue(false),
  ACCOUNT_MERGED_RELOGIN_REQUIRED_CODE: "MERGED",
  ACCOUNT_MERGED_RELOGIN_REQUIRED_MESSAGE: "Merged",
}));
vi.mock("./_core/googleMigrationGate", () => ({
  isBlockedByGoogleMigrationGate: vi.fn().mockResolvedValue(false),
  GOOGLE_CONNECTION_REQUIRED_CODE: "GOOGLE_REQUIRED",
  GOOGLE_CONNECTION_REQUIRED_MESSAGE: "Google required",
}));
import { appRouter } from "./routers";
const ctx = (role: string | null) => ({ user: role ? { id: 7, role } : null, req: { headers: {} }, res: {} }) as any;
describe("QR router authorization and generic-settings bypass", () => {
  it("exposes settings through the actual application router for admin only", async () => {
    const caller = appRouter.createCaller(ctx("user"));
    await expect(caller.admin.settings.paymentQr.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.settings.paymentQr.update({ mode: "static", expectedRevision: 0, reason: "denied" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["paymentQr.config", "paymentQr.audit.fake", "paymentQr.mode"])("rejects generic setting writes to %s", async key => {
    const caller = appRouter.createCaller(ctx("admin"));
    await expect(caller.admin.settings.set({ key, value: "{}" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("requires a session for the runtime QR endpoint", async () => {
    await expect(appRouter.createCaller(ctx(null)).paymentQr.get({ kind: "wallet", amount: "1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
