import { describe, expect, it } from "vitest";
import {
  buildInitialMigrationOwnership,
  canBindPublicationNovel,
  canManageMembers,
  runWorkspaceSyntheticFixture,
  validateMembershipChange,
  WORKSPACE_MIGRATION_FIXTURE_CLOCK,
  WORKSPACE_MIGRATION_FIXTURE_DOCS,
  WORKSPACE_MIGRATION_FIXTURE_EPOCH,
  WORKSPACE_MIGRATION_FIXTURE_ID,
  WORKSPACE_MIGRATION_FIXTURE_ROWS,
  WORKSPACE_MIGRATION_FIXTURE_SPREADSHEET_ID,
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

  it("executes the exact first-run M00 migration fixture contract", () => {
    const first = runWorkspaceSyntheticFixture();

    expect(first.fixtureId).toBe(WORKSPACE_MIGRATION_FIXTURE_ID);
    expect(first.fixtureId).toBe("workspace-migration-v1");
    expect(first.frozenClock).toBe(WORKSPACE_MIGRATION_FIXTURE_CLOCK);
    expect(first.source).toEqual({
      spreadsheetId: "sheet_fixture_001",
      epoch: "epoch_001",
      workspaceId: "ws_001",
      novelId: "novel_101",
    });
    expect(first.inputRows).toEqual(WORKSPACE_MIGRATION_FIXTURE_ROWS);
    expect(first.inputRows).toHaveLength(7);
    expect(first.inputRows[3]).toEqual(first.inputRows[1]);
    expect(first.mockDocsMetadata).toEqual(WORKSPACE_MIGRATION_FIXTURE_DOCS);
    expect(first.mockDocsMetadata).toEqual([
      { documentId: "doc_alpha", revision: "rev_1", normalizedHash: "sha_alpha_v1" },
      { documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4" },
      { documentId: "doc_gamma", revision: "rev_2", normalizedHash: "sha_gamma_v2" },
    ]);
    expect(first.mockDocsMetadata.every((entry) => !("body" in entry))).toBe(true);

    expect(first.inputRecordsObserved).toBe(7);
    expect(first.import).toEqual({
      created: 3, updated: 0, unchanged: 0, duplicateIgnored: 1, quarantineCreated: 3,
    });
    expect(first.workspaceNovelBindingsCreatedOrReused).toBe(1);
    expect(first.workspaceNovelBindingId).toBe("workspace_novel_binding_1");
    expect(first.documents).toEqual([
      { legacyRowId: "row_001", documentId: "doc_alpha", revision: "rev_1", normalizedHash: "sha_alpha_v1", capability: "checker" },
      { legacyRowId: "row_002", documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4", capability: "ai_queue" },
      { legacyRowId: "row_003", documentId: "doc_gamma", revision: "rev_2", normalizedHash: "sha_gamma_v2", capability: "publish" },
    ]);
    expect(first.stableIds.map((entry) => entry.legacyIdentity)).toEqual([
      "sheet_fixture_001:row_001:epoch_001",
      "sheet_fixture_001:row_002:epoch_001",
      "sheet_fixture_001:row_003:epoch_001",
    ]);
    expect(first.quarantines).toEqual([
      { legacyIdentity: "sheet_fixture_001:row_004:epoch_001", quarantineId: "quarantine:sheet_fixture_001:row_004:epoch_001:MISSING_NOVEL_KEY", reason: "MISSING_NOVEL_KEY" },
      { legacyIdentity: "sheet_fixture_001:row_005:epoch_001", quarantineId: "quarantine:sheet_fixture_001:row_005:epoch_001:UNKNOWN_CAPABILITY", reason: "UNKNOWN_CAPABILITY" },
      { legacyIdentity: "sheet_fixture_001:row_006:epoch_001", quarantineId: "quarantine:sheet_fixture_001:row_006:epoch_001:NOVEL_NOT_BOUND", reason: "NOVEL_NOT_BOUND" },
    ]);
    expect(first.counts).toEqual({
      documentIdentities: 3, bindings: 3, snapshots: 3, currentFingerprints: 3,
      migrationRegistryEntries: 3, quarantines: 3,
    });
    expect(first.ownership).toEqual([
      { capability: "checker", owner: "sheets", cutoverEpoch: "epoch_001" },
      { capability: "ai_queue", owner: "sheets", cutoverEpoch: "epoch_001" },
      { capability: "publish", owner: "sheets", cutoverEpoch: "epoch_001" },
    ]);
    expect(first.networkCalls).toBe(0);
    expect(first.liveCredentials).toBe(0);
    expect(first.sideEffects).toEqual({
      checkerRuns: 0, aiJobs: 0, publishRuns: 0, outboxEvents: 0, publishItems: 0,
    });
    expect(first.reconciliation).toEqual({
      missing: 0, unexpected: 0, hashMismatch: 0, ownershipMismatch: 0,
    });
  });

  it("reconciles the identical second run without new records or changed IDs", () => {
    const first = runWorkspaceSyntheticFixture();
    const second = runWorkspaceSyntheticFixture(first.state);

    expect(second.fixtureId).toBe(WORKSPACE_MIGRATION_FIXTURE_ID);
    expect(second.frozenClock).toBe(WORKSPACE_MIGRATION_FIXTURE_CLOCK);
    expect(second.source.spreadsheetId).toBe(WORKSPACE_MIGRATION_FIXTURE_SPREADSHEET_ID);
    expect(second.source.epoch).toBe(WORKSPACE_MIGRATION_FIXTURE_EPOCH);
    expect(second.import).toEqual({
      created: 0, updated: 0, unchanged: 3, duplicateIgnored: 1, quarantineUnchanged: 3,
    });
    expect(second.stableIds).toEqual(first.stableIds);
    expect(second.quarantines).toEqual(first.quarantines);
    expect(second.workspaceNovelBindingId).toBe(first.workspaceNovelBindingId);
    expect(second.counts).toEqual(first.counts);
    expect(second.noNewRecords).toEqual({
      snapshots: 0, bindings: 0, registryEntries: 0, quarantines: 0,
      jobs: 0, checkerRuns: 0, outboxEvents: 0, publishItems: 0,
    });
    expect(second.sideEffects).toEqual(first.sideEffects);
    expect(second.networkCalls).toBe(0);
    expect(second.liveCredentials).toBe(0);
    expect(second.reconciliation).toEqual({
      missing: 0, unexpected: 0, hashMismatch: 0, ownershipMismatch: 0,
    });
  });
});
