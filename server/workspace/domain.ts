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

export const WORKSPACE_MIGRATION_FIXTURE_ID = "workspace-m01-synthetic-v1";

export function runWorkspaceSyntheticFixture() {
  const initialOwnership = buildInitialMigrationOwnership();
  return {
    fixtureId: WORKSPACE_MIGRATION_FIXTURE_ID,
    networkCalls: 0,
    liveCredentials: 0,
    bindings: [{
      sourceKind: "synthetic" as const,
      sourceKey: "fixture:novel_101:source",
      role: "source" as const,
      status: "active" as const,
    }],
    ownership: initialOwnership,
    sideEffects: {
      checkerRuns: 0,
      aiJobs: 0,
      publishRuns: 0,
      outboxEvents: 0,
    },
  };
}
