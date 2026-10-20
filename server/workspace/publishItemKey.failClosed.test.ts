import { describe, expect, it } from "vitest";
import { classifyPublishItemKey } from "./editorialIdentityContract.domain";
import { assertEditorialPublishRequestCurrent } from "./editorialPublish.service";
import { createPublishDryRun } from "./publishDryRun.service";
import type { WorkspacePublishProviderRequest } from "./publishExecution.domain";

const sourceSha256 = "a".repeat(64);

function request(itemKey: string): WorkspacePublishProviderRequest {
  return {
    requestKey: "request-1",
    workspaceId: 1,
    publishRunId: 1,
    destinationId: 1,
    targetType: "novel",
    targetId: 1,
    itemKey,
    episodeId: 1,
    sourceSha256,
  };
}

describe("reserved editorial-stage keys fail closed before a database call", () => {
  it("rejects every non-canonical editorial-stage prefix in dry run and preflight", async () => {
    for (const itemKey of ["editorial-stage_abc", "editorial-stageX", "editorial-stage/abc"]) {
      expect(classifyPublishItemKey(itemKey)).toEqual({ kind: "malformed-editorial" });
      await expect(createPublishDryRun({
        actorUserId: 1,
        workspaceId: 1,
        destinationId: 1,
        snapshotId: 1,
        items: [{ itemKey, sourceSha256 }],
      })).rejects.toMatchObject({
        code: "PUBLISH_PLAN_INVALID",
        message: "Malformed editorial publish item key.",
      });
      await expect(assertEditorialPublishRequestCurrent(request(itemKey))).rejects.toMatchObject({
        code: "PUBLISH_STATE_CONFLICT",
        message: "Malformed editorial publish item key.",
      });
    }
    expect(classifyPublishItemKey("chapter-1")).toEqual({ kind: "legacy" });
    await expect(assertEditorialPublishRequestCurrent(request("chapter-1"))).resolves.toEqual({
      editorial: false,
    });
  });
});
