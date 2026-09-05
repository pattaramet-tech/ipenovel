import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  novels,
  users,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  addOrUpdateMember,
  bindPublicationNovel,
  createWorkspace,
  getWorkspaceDetail,
  listMigrationOwnership,
  listReadOnlyBindings,
  WorkspaceServiceError,
} from "./service";

/**
 * These tests intentionally call the production service against the isolated
 * TEST_DATABASE_URL connection supplied by vitest.integration.setupfile.ts.
 * No provider adapter, Apps Script, or Google credential is involved.
 */
describe.sequential("workspace M01 membership and read-only binding integration", () => {
  it("enforces tenant membership, including for a platform admin", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const owner = await createTestUser();
    const member = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const first = await createWorkspace(owner.id, "Tenant A");
    const second = await createWorkspace(owner.id, "Tenant B");

    try {
      await addOrUpdateMember({
        actorUserId: owner.id,
        workspaceId: first.workspaceId,
        userId: member.id,
        role: "viewer",
      });

      await expect(getWorkspaceDetail(member.id, second.workspaceId))
        .rejects.toMatchObject<Partial<WorkspaceServiceError>>({ code: "MEMBERSHIP_REQUIRED" });
      await expect(getWorkspaceDetail(admin.id, first.workspaceId))
        .rejects.toMatchObject<Partial<WorkspaceServiceError>>({ code: "MEMBERSHIP_REQUIRED" });
      await expect(addOrUpdateMember({
        actorUserId: member.id,
        workspaceId: first.workspaceId,
        userId: admin.id,
        role: "viewer",
      })).rejects.toMatchObject<Partial<WorkspaceServiceError>>({ code: "OWNER_ROLE_REQUIRED" });

      const detail = await getWorkspaceDetail(member.id, first.workspaceId);
      expect(detail.workspace.id).toBe(first.workspaceId);
      expect(detail.members.map((row: { userId: number }) => row.userId)).toEqual(
        expect.arrayContaining([owner.id, member.id])
      );
    } finally {
      await testDb.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, first.workspaceId));
      await testDb.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, second.workspaceId));
      await testDb.delete(users).where(eq(users.id, owner.id));
      await testDb.delete(users).where(eq(users.id, member.id));
      await testDb.delete(users).where(eq(users.id, admin.id));
    }
  });

  it("keeps publication-novel bindings read-only, tenant-scoped, idempotent, and Sheets-owned", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Binding tenant");

    try {
      const firstBind = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const secondBind = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });

      expect(firstBind.created).toBe(true);
      expect(secondBind).toEqual({ workspaceNovelId: firstBind.workspaceNovelId, created: false });

      const bindings = await listReadOnlyBindings(owner.id, workspace.workspaceId);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.binding.sourceKind).toBe("synthetic");
      expect(bindings[0]?.binding.sourceKey).toBe(`publication-novel:${novel.id}`);
      expect(bindings[0]?.novel.id).toBe(novel.id);

      const ownership = await listMigrationOwnership(owner.id, workspace.workspaceId);
      expect(ownership).toHaveLength(5);
      expect(ownership.every((row) => row.entry.owner === "sheets")).toBe(true);
      expect(ownership.every((row) => row.entry.cutoverEpoch === 0)).toBe(true);

      await expect(listReadOnlyBindings(outsider.id, workspace.workspaceId))
        .rejects.toMatchObject<Partial<WorkspaceServiceError>>({ code: "MEMBERSHIP_REQUIRED" });
      await expect(listMigrationOwnership(outsider.id, workspace.workspaceId))
        .rejects.toMatchObject<Partial<WorkspaceServiceError>>({ code: "MEMBERSHIP_REQUIRED" });
    } finally {
      await testDb.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await testDb.delete(novels).where(eq(novels.id, novel.id));
      await testDb.delete(users).where(eq(users.id, owner.id));
      await testDb.delete(users).where(eq(users.id, outsider.id));
    }
  });
});
