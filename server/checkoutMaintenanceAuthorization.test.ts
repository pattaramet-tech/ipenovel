import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

function userContext(): TrpcContext {
  return {
    user: {
      id: 42,
      openId: "test-user",
      email: "test@example.invalid",
      name: "Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("checkout maintenance admin authorization", () => {
  it("does not let a non-admin read the editable setting", async () => {
    const caller = appRouter.createCaller(userContext());
    await expect(caller.admin.settings.getCheckoutMaintenance()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("does not let a non-admin update the setting", async () => {
    const caller = appRouter.createCaller(userContext());
    await expect(
      caller.admin.settings.updateCheckoutMaintenance({
        enabled: true,
        scope: "all_checkout",
        severity: "error",
        title: "Maintenance",
        message: "Try again later",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
