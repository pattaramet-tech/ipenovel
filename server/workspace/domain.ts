export const WORKSPACE_ROLES = ["owner", "editor", "reviewer", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_CAPABILITIES = ["kanban", "checker", "ai_queue", "export", "publish"] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

export const INITIAL_MIGRATION_OWNER = "sheets" as const;

export function canManageMembers(role: WorkspaceRole): boolean {
  return role === "owner";
}

export function canBindPublicationNovel(role: WorkspaceRole): boolean {
  return role === "owner" || role === "editor";
}

export function canViewWorkspace(role: WorkspaceRole): boolean {
  return WORKSPACE_ROLES.includes(role);
}

export function validateMembershipChange(input: {
  actorUserId: number;
  targetUserId: number;
  actorRole: WorkspaceRole;
  currentRole?: WorkspaceRole;
  nextRole: WorkspaceRole;
  activeOwnerCount: number;
}): string | undefined {
  if (!canManageMembers(input.actorRole)) return "OWNER_ROLE_REQUIRED";
  if (input.nextRole === "owner") return "OWNER_TRANSFER_NOT_AVAILABLE";
  if (
    input.currentRole === "owner" &&
    input.activeOwnerCount <= 1
  ) {
    return "LAST_OWNER_MUST_REMAIN";
  }
  if (input.targetUserId === input.actorUserId) {
    return "OWNER_SELF_DEMOTION_NOT_AVAILABLE";
  }
  return undefined;
}

export function buildInitialMigrationOwnership() {
  return WORKSPACE_CAPABILITIES.map((capability) => ({
    capability,
    owner: INITIAL_MIGRATION_OWNER,
    cutoverEpoch: 0,
  }));
}

export const WORKSPACE_MIGRATION_FIXTURE_ID = "workspace-migration-v1";
export const WORKSPACE_MIGRATION_FIXTURE_CLOCK = "2026-01-15T00:00:00Z";

const FIXTURE_DOCUMENTS = [
  { legacyRowId: "row_001", documentId: "doc_alpha", revision: "rev_1", normalizedHash: "sha_alpha_v1", capability: "checker" },
  { legacyRowId: "row_002", documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4", capability: "ai_queue" },
  { legacyRowId: "row_003", documentId: "doc_gamma", revision: "rev_2", normalizedHash: "sha_gamma_v2", capability: "publish" },
] as const;

const FIXTURE_QUARANTINE = ["MISSING_NOVEL_KEY", "UNKNOWN_CAPABILITY", "NOVEL_NOT_BOUND"] as const;

/**
 * Deterministic, in-memory contract for the M00 migration dry run. It models
 * no provider, database, or runtime workflow; its sole purpose is to keep the
 * approved fixture executable while Sheets owns every action capability.
 */
export interface WorkspaceMigrationFixturePreviousRun {
  stableIds: Array<{
    legacyIdentity: string;
    documentIdentityId: string;
    bindingId: string;
    snapshotId: string;
    fingerprintId: string;
  }>;
}

export function runWorkspaceSyntheticFixture(previous?: WorkspaceMigrationFixturePreviousRun) {
  const stableIds = previous?.stableIds ?? FIXTURE_DOCUMENTS.map((entry, index) => ({
    legacyIdentity: `sheet_fixture_001:${entry.legacyRowId}:epoch_001`,
    documentIdentityId: `document_${index + 1}`,
    bindingId: `binding_${index + 1}`,
    snapshotId: `snapshot_${index + 1}`,
    fingerprintId: `fingerprint_${index + 1}`,
  }));
  const isRepeat = Boolean(previous);

  return {
    fixtureId: WORKSPACE_MIGRATION_FIXTURE_ID,
    frozenClock: WORKSPACE_MIGRATION_FIXTURE_CLOCK,
    networkCalls: 0,
    liveCredentials: 0,
    inputRecordsObserved: 7,
    import: isRepeat
      ? { created: 0, updated: 0, unchanged: 3, duplicateIgnored: 1, quarantineUnchanged: 3 }
      : { created: 3, updated: 0, unchanged: 0, duplicateIgnored: 1, quarantineCreated: 3 },
    workspaceNovelBindingsCreatedOrReused: 1,
    documents: FIXTURE_DOCUMENTS,
    stableIds,
    counts: {
      documentIdentities: 3,
      bindings: 3,
      snapshots: 3,
      currentFingerprints: 3,
      migrationRegistryEntries: 3,
      quarantines: 3,
    },
    ownership: FIXTURE_DOCUMENTS.map((entry) => ({
      capability: entry.capability,
      owner: INITIAL_MIGRATION_OWNER,
      cutoverEpoch: "epoch_001",
    })),
    quarantineReasons: FIXTURE_QUARANTINE,
    sideEffects: { checkerRuns: 0, aiJobs: 0, publishRuns: 0, outboxEvents: 0 },
    reconciliation: { missing: 0, unexpected: 0, hashMismatch: 0, ownershipMismatch: 0 },
  };
}
