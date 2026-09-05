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
  if (input.currentRole === "owner" && input.activeOwnerCount <= 1) {
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
export const WORKSPACE_MIGRATION_FIXTURE_SPREADSHEET_ID = "sheet_fixture_001";
export const WORKSPACE_MIGRATION_FIXTURE_EPOCH = "epoch_001";
export const WORKSPACE_MIGRATION_FIXTURE_WORKSPACE_ID = "ws_001";
export const WORKSPACE_MIGRATION_FIXTURE_NOVEL_ID = "novel_101";

type FixtureCapability = "checker" | "ai_queue" | "publish";
type FixtureQuarantineReason =
  | "MISSING_NOVEL_KEY"
  | "UNKNOWN_CAPABILITY"
  | "NOVEL_NOT_BOUND";

interface FixtureRow {
  legacyRowId: string;
  novelId: string;
  capability: string;
  actionOwner: typeof INITIAL_MIGRATION_OWNER;
  documentId: string;
  revision: string;
  normalizedHash: string;
}

interface FixtureDocumentMetadata {
  documentId: string;
  revision: string;
  normalizedHash: string;
}

interface FixtureStableIds {
  legacyIdentity: string;
  documentIdentityId: string;
  bindingId: string;
  snapshotId: string;
  fingerprintId: string;
  registryId: string;
}

interface FixtureQuarantine {
  legacyIdentity: string;
  quarantineId: string;
  reason: FixtureQuarantineReason;
}

export interface WorkspaceMigrationFixtureState {
  workspaceNovelBindingId?: string;
  stableIds: FixtureStableIds[];
  quarantines: FixtureQuarantine[];
}

/** Exact, committed M00 fixture input. It contains no credentials or body text. */
export const WORKSPACE_MIGRATION_FIXTURE_ROWS: readonly FixtureRow[] = [
  { legacyRowId: "row_001", novelId: "novel_101", capability: "checker", actionOwner: "sheets", documentId: "doc_alpha", revision: "rev_1", normalizedHash: "sha_alpha_v1" },
  { legacyRowId: "row_002", novelId: "novel_101", capability: "ai_queue", actionOwner: "sheets", documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4" },
  { legacyRowId: "row_003", novelId: "novel_101", capability: "publish", actionOwner: "sheets", documentId: "doc_gamma", revision: "rev_2", normalizedHash: "sha_gamma_v2" },
  { legacyRowId: "row_002", novelId: "novel_101", capability: "ai_queue", actionOwner: "sheets", documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4" },
  { legacyRowId: "row_004", novelId: "", capability: "checker", actionOwner: "sheets", documentId: "doc_orphan", revision: "rev_1", normalizedHash: "sha_orphan" },
  { legacyRowId: "row_005", novelId: "novel_101", capability: "unknown_action", actionOwner: "sheets", documentId: "doc_unknown", revision: "rev_1", normalizedHash: "sha_unknown" },
  { legacyRowId: "row_006", novelId: "novel_999", capability: "checker", actionOwner: "sheets", documentId: "doc_unbound", revision: "rev_1", normalizedHash: "sha_unbound" },
];

export const WORKSPACE_MIGRATION_FIXTURE_DOCS: readonly FixtureDocumentMetadata[] = [
  { documentId: "doc_alpha", revision: "rev_1", normalizedHash: "sha_alpha_v1" },
  { documentId: "doc_beta", revision: "rev_4", normalizedHash: "sha_beta_v4" },
  { documentId: "doc_gamma", revision: "rev_2", normalizedHash: "sha_gamma_v2" },
];

function legacyIdentity(row: FixtureRow): string {
  return `${WORKSPACE_MIGRATION_FIXTURE_SPREADSHEET_ID}:${row.legacyRowId}:${WORKSPACE_MIGRATION_FIXTURE_EPOCH}`;
}

function quarantineReason(row: FixtureRow): FixtureQuarantineReason | undefined {
  if (!row.novelId) return "MISSING_NOVEL_KEY";
  if (!WORKSPACE_CAPABILITIES.includes(row.capability as WorkspaceCapability)) {
    return "UNKNOWN_CAPABILITY";
  }
  if (row.novelId !== WORKSPACE_MIGRATION_FIXTURE_NOVEL_ID) {
    return "NOVEL_NOT_BOUND";
  }
  return undefined;
}

function stableIdsFor(row: FixtureRow, index: number): FixtureStableIds {
  const identity = legacyIdentity(row);
  const suffix = index + 1;
  return {
    legacyIdentity: identity,
    documentIdentityId: `document_${suffix}`,
    bindingId: `binding_${suffix}`,
    snapshotId: `snapshot_${suffix}`,
    fingerprintId: `fingerprint_${suffix}`,
    registryId: `registry_${suffix}`,
  };
}

function quarantineFor(row: FixtureRow): FixtureQuarantine {
  const reason = quarantineReason(row);
  if (!reason) throw new Error("Expected a quarantine reason");
  const identity = legacyIdentity(row);
  return {
    legacyIdentity: identity,
    quarantineId: `quarantine:${identity}:${reason}`,
    reason,
  };
}

/**
 * Runs the committed M00 migration fixture entirely in memory. It deliberately
 * exposes only mock Docs metadata, never document bodies or provider adapters.
 */
export function runWorkspaceSyntheticFixture(
  previous?: WorkspaceMigrationFixtureState,
) {
  const existing = previous ?? { stableIds: [], quarantines: [] };
  const stableIds = [...existing.stableIds];
  const quarantines = [...existing.quarantines];
  const seenInputIdentities = new Set<string>();
  let created = 0;
  let unchanged = 0;
  let duplicateIgnored = 0;
  let quarantineCreated = 0;
  let quarantineUnchanged = 0;

  for (const row of WORKSPACE_MIGRATION_FIXTURE_ROWS) {
    const identity = legacyIdentity(row);
    if (seenInputIdentities.has(identity)) {
      duplicateIgnored += 1;
      continue;
    }
    seenInputIdentities.add(identity);

    const reason = quarantineReason(row);
    if (reason) {
      const quarantine = quarantineFor(row);
      if (quarantines.some((entry) => entry.quarantineId === quarantine.quarantineId)) {
        quarantineUnchanged += 1;
      } else {
        quarantines.push(quarantine);
        quarantineCreated += 1;
      }
      continue;
    }

    const metadata = WORKSPACE_MIGRATION_FIXTURE_DOCS.find(
      (entry) => entry.documentId === row.documentId,
    );
    if (
      !metadata ||
      metadata.revision !== row.revision ||
      metadata.normalizedHash !== row.normalizedHash
    ) {
      throw new Error(`Mock Docs metadata mismatch for ${row.documentId}`);
    }

    if (stableIds.some((entry) => entry.legacyIdentity === identity)) {
      unchanged += 1;
    } else {
      stableIds.push(stableIdsFor(row, stableIds.length));
      created += 1;
    }
  }

  const state: WorkspaceMigrationFixtureState = {
    workspaceNovelBindingId:
      existing.workspaceNovelBindingId ?? "workspace_novel_binding_1",
    stableIds,
    quarantines,
  };
  const isRepeat = Boolean(previous);
  const importedDocuments = WORKSPACE_MIGRATION_FIXTURE_ROWS.slice(0, 3).map(
    ({ legacyRowId, documentId, revision, normalizedHash, capability }) => ({
      legacyRowId,
      documentId,
      revision,
      normalizedHash,
      capability: capability as FixtureCapability,
    }),
  );

  return {
    fixtureId: WORKSPACE_MIGRATION_FIXTURE_ID,
    frozenClock: WORKSPACE_MIGRATION_FIXTURE_CLOCK,
    source: {
      spreadsheetId: WORKSPACE_MIGRATION_FIXTURE_SPREADSHEET_ID,
      epoch: WORKSPACE_MIGRATION_FIXTURE_EPOCH,
      workspaceId: WORKSPACE_MIGRATION_FIXTURE_WORKSPACE_ID,
      novelId: WORKSPACE_MIGRATION_FIXTURE_NOVEL_ID,
    },
    inputRows: WORKSPACE_MIGRATION_FIXTURE_ROWS,
    mockDocsMetadata: WORKSPACE_MIGRATION_FIXTURE_DOCS,
    inputRecordsObserved: WORKSPACE_MIGRATION_FIXTURE_ROWS.length,
    import: isRepeat
      ? { created, updated: 0, unchanged, duplicateIgnored, quarantineUnchanged }
      : { created, updated: 0, unchanged, duplicateIgnored, quarantineCreated },
    workspaceNovelBindingsCreatedOrReused: 1,
    workspaceNovelBindingId: state.workspaceNovelBindingId,
    documents: importedDocuments,
    stableIds: state.stableIds,
    quarantines: state.quarantines,
    counts: {
      documentIdentities: state.stableIds.length,
      bindings: state.stableIds.length,
      snapshots: state.stableIds.length,
      currentFingerprints: state.stableIds.length,
      migrationRegistryEntries: state.stableIds.length,
      quarantines: state.quarantines.length,
    },
    ownership: importedDocuments.map((entry) => ({
      capability: entry.capability,
      owner: INITIAL_MIGRATION_OWNER,
      cutoverEpoch: WORKSPACE_MIGRATION_FIXTURE_EPOCH,
    })),
    sideEffects: {
      checkerRuns: 0,
      aiJobs: 0,
      publishRuns: 0,
      outboxEvents: 0,
      publishItems: 0,
    },
    networkCalls: 0,
    liveCredentials: 0,
    reconciliation: {
      missing: 0,
      unexpected: 0,
      hashMismatch: 0,
      ownershipMismatch: 0,
    },
    noNewRecords: isRepeat
      ? {
          snapshots: 0,
          bindings: 0,
          registryEntries: 0,
          quarantines: 0,
          jobs: 0,
          checkerRuns: 0,
          outboxEvents: 0,
          publishItems: 0,
        }
      : undefined,
    state,
  };
}
