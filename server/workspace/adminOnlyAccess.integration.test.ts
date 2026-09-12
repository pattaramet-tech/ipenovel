import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { novels, users, workspaceMembers, workspaceWorkspaces } from "../../drizzle/schema";
import type { TrpcContext } from "../_core/context";
import { appRouter } from "../routers";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { addOrUpdateMember, createWorkspace } from "./service";

function contextFor(userId: number, role: "user" | "admin"): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `test-session-${userId}`,
      email: `test-session-${userId}@example.test`,
      name: "Workspace authorization test",
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

describe.sequential("workspace global platform-admin authorization", () => {
  it("denies non-admin members but lets any current admin access and operate every workspace without membership", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const adminCreator = await createTestUser({ role: "admin" });
    const normalMember = await createTestUser({ role: "user" });
    const adminPeer = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(adminCreator.id, "Global admin Workspace");

    try {
      await addOrUpdateMember({
        actorUserId: adminCreator.id,
        workspaceId: workspace.workspaceId,
        userId: normalMember.id,
        role: "viewer",
      });

      const peerMembership = await testDb
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceId, workspace.workspaceId),
          eq(workspaceMembers.userId, adminPeer.id)
        ));
      expect(peerMembership).toHaveLength(0);

      const normalMemberCaller = appRouter.createCaller(contextFor(normalMember.id, "user"));
      await expect(normalMemberCaller.workspace.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(normalMemberCaller.workspace.detail({ workspaceId: workspace.workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(normalMemberCaller.workspace.bindings.bindPublicationNovel({
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      const adminPeerCaller = appRouter.createCaller(contextFor(adminPeer.id, "admin"));
      const list = await adminPeerCaller.workspace.list();
      expect(list.some((row: any) => row.workspace.id === workspace.workspaceId)).toBe(true);

      const detail = await adminPeerCaller.workspace.detail({ workspaceId: workspace.workspaceId });
      expect(detail.workspace.id).toBe(workspace.workspaceId);

      const binding = await adminPeerCaller.workspace.bindings.bindPublicationNovel({
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      expect(binding.created).toBe(true);

      const afterOperationMembership = await testDb
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceId, workspace.workspaceId),
          eq(workspaceMembers.userId, adminPeer.id)
        ));
      expect(afterOperationMembership).toHaveLength(0);
    } finally {
      await testDb.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await testDb.delete(novels).where(eq(novels.id, novel.id));
      await testDb.delete(users).where(eq(users.id, adminCreator.id));
      await testDb.delete(users).where(eq(users.id, normalMember.id));
      await testDb.delete(users).where(eq(users.id, adminPeer.id));
    }
  });
});
