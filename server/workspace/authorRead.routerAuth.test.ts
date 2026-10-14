import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../_core/context";
import { appRouter } from "../routers";

function contextFor(role: "user" | "author" | "admin" | null): TrpcContext {
  return {
    user: role == null ? null : {
      id: 76101,
      openId: "r4a-no-db-guard",
      email: "r4a@example.test",
      name: "Access test",
      loginMethod: "test",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("R4A direct tRPC role gates (no database connection required)", () => {
  it.each(["admin", "user", null] as const)(
    "rejects %s at the separate Author-only read API before any DB lookup", async (role) => {
      const caller = appRouter.createCaller(contextFor(role));
      await expect(caller.workspace.authorRead.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.workspace.authorRead.detail({ workspaceId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.workspace.authorRead.draft({ workspaceId: 1, workItemId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("preserves all old platform-admin gates for an Author", async () => {
    const caller = appRouter.createCaller(contextFor("author"));
    await expect(caller.workspace.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.detail({ workspaceId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.editorial.sourceDraft({ workspaceId: 1, workItemId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.aiQueue.queue({ workspaceId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
