import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, workspaceWorkspaces } from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestUser } from "../test-helpers/fixtures";
import { createWorkspace } from "./service";
import {
  getWorkspacePublishOperationalOverview,
  WorkspaceControlCenterError,
} from "./controlCenter.service";

describe.sequential("Workspace Control Center read-only integration", () => {
  it("is membership-gated and returns an empty side-effect-free publish projection for a new workspace", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const workspace = await createWorkspace(owner.id, "Control Center tenant");

    try {
      const overview = await getWorkspacePublishOperationalOverview({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });

      expect(overview).toMatchObject({
        readOnly: true,
        sideEffectsApplied: false,
        ownership: [],
        runs: [],
        transitions: [],
      });

      await expect(getWorkspacePublishOperationalOverview({
        actorUserId: outsider.id,
        workspaceId: workspace.workspaceId,
      })).rejects.toMatchObject<Partial<WorkspaceControlCenterError>>({
        code: "MEMBERSHIP_REQUIRED",
      });
    } finally {
      await testDb.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await testDb.delete(users).where(eq(users.id, owner.id));
      await testDb.delete(users).where(eq(users.id, outsider.id));
    }
  });
});
