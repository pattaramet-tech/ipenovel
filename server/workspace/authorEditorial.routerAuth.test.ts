import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../_core/context";
import { appRouter } from "../routers";

function contextFor(role: "user" | "author" | "admin" | null): TrpcContext {
  return {
    user: role == null ? null : {
      id: 76102,
      openId: "r4b-no-db-guard",
      email: "r4b@example.test",
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

const scope = { workspaceId: 1, workItemId: 1 };

describe("IPE-070R4B author editorial role gates", () => {
  it.each(["admin", "user", null] as const)(
    "rejects %s before any author editorial lookup",
    async (role) => {
      const caller = appRouter.createCaller(contextFor(role));
      await expect(caller.workspace.authorEditorial.surface(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.workspace.authorEditorial.runChecker(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.workspace.authorEditorial.stage({
        ...scope,
        approvalId: 1,
        expectedDraftId: 1,
        expectedDraftVersion: 1,
        expectedDraftSha256: "a".repeat(64),
        idempotencyKey: "stage-denied",
      })).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("keeps Admin editorial and publish routes closed to an Author", async () => {
    const caller = appRouter.createCaller(contextFor("author"));
    await expect(caller.workspace.editorial.editorEdit({
      workspaceId: 1,
      workItemId: 1,
      expectedDraftId: 1,
      expectedDraftVersion: 1,
      expectedDraftSha256: "a".repeat(64),
      command: {
        kind: "replace_paragraph",
        paragraphKey: "b".repeat(64),
        expectedParagraphFingerprint: "c".repeat(64),
        expectedText: "old",
        replacementText: "new",
      },
      idempotencyKey: "admin-edit-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.editorial.approveDraft({
      workspaceId: 1,
      workItemId: 1,
      expectedDraftId: 1,
      expectedDraftVersion: 1,
      expectedDraftSha256: "a".repeat(64),
      expectedCheckerRunId: 1,
      expectedQcEvidenceSha256: "d".repeat(64),
      idempotencyKey: "admin-approve-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.editorial.stageEpisodeDraft({
      workspaceId: 1,
      workItemId: 1,
      approvalId: 1,
      expectedDraftId: 1,
      expectedDraftVersion: 1,
      expectedDraftSha256: "a".repeat(64),
      idempotencyKey: "admin-stage-denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.workspace.editorial.requestPublish({
      workspaceId: 1,
      workItemId: 1,
      expectedStageSetSha256: "e".repeat(64),
      expectedStagedDraftSha256: "f".repeat(64),
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: 1,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect("publish" in caller.workspace.authorEditorial).toBe(false);
    expect("requestPublish" in caller.workspace.authorEditorial).toBe(false);
  });
});
