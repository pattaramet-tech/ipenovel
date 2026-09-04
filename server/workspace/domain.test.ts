import { describe, expect, it } from "vitest";
import {
  buildInitialMigrationOwnership,
  canBindPublicationNovel,
  canManageMembers,
  runWorkspaceSyntheticFixture,
  validateMembershipChange,
  WORKSPACE_CAPABILITIES,
} from "./domain";

describe("workspace M01 domain contract", () => {
  it("keeps membership administration owner-only", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("reviewer")).toBe(false);
    expect(canManageMembers("viewer")).toBe(false);
  });

  it("allows only owners and editors to create read-only publication bindings", () => {
    expect(canBindPublicationNovel("owner")).toBe(true);
    expect(canBindPublicationNovel("editor")).toBe(true);
    expect(canBindPublicationNovel("reviewer")).toBe(false);
    expect(canBindPublicationNovel("viewer")).toBe(false);
  });

  it("fails closed around the sole owner and unsupported owner transfer", () => {
    expect(validateMembershipChange({
      actorUserId: 1, targetUserId: 2, actorRole: "owner",
      currentRole: "owner", nextRole: "viewer", activeOwnerCount: 1,
    })).toBe("LAST_OWNER_MUST_REMAIN");
    expect(validateMembershipChange({
      actorUserId: 1, targetUserId: 2, actorRole: "owner",
      nextRole: "owner", activeOwnerCount: 1,
    })).toBe("OWNER_TRANSFER_NOT_AVAILABLE");
    expect(validateMembershipChange({
      actorUserId: 2, targetUserId: 3, actorRole: "editor",
      nextRole: "viewer", activeOwnerCount: 1,
    })).toBe("OWNER_ROLE_REQUIRED");
  });

  it("uses a deterministic zero-side-effect fixture with Sheets ownership", () => {
    const first = runWorkspaceSyntheticFixture();
    const second = runWorkspaceSyntheticFixture();
    expect(first).toEqual(second);
    expect(first.networkCalls).toBe(0);
    expect(first.liveCredentials).toBe(0);
    expect(first.ownership).toHaveLength(WORKSPACE_CAPABILITIES.length);
    expect(first.ownership.every((entry) => entry.owner === "sheets")).toBe(true);
    expect(first.sideEffects).toEqual({ checkerRuns: 0, aiJobs: 0, publishRuns: 0, outboxEvents: 0 });
  });
});
