import { and, eq, isNull } from "drizzle-orm";
import { workspaceMembers, workspaceWorkspaces } from "../../drizzle/schema";

// IPE-PLUGIN-001D-R2 - shared Workspace editorial access guard.
//
// Resolves the caller's EFFECTIVE role in a Workspace directly from the
// database (never from client input) and enforces a policy grade:
//
//   1. workspace must be status='active' AND deletedAt IS NULL,
//   2. ownerUserId === actorUserId  -> effective role "owner" (membership row
//      NOT required),
//   3. otherwise an ACTIVE workspaceMembers row must exist
//      (invited/suspended/removed do not count) and its role becomes the
//      effective role,
//   4. the policy grade is enforced:
//        plugin_read         -> owner/editor/reviewer/viewer
//        plugin_edit         -> owner/editor
//        plugin_checker_run  -> owner/editor
//
// Fail-closed mapping for callers:
//   NOT_FOUND  - workspace missing/inactive/deleted, or the actor has NO
//                effective membership (non-member/invited/suspended/removed
//                are indistinguishable from nonexistent - no existence
//                oracle),
//   FORBIDDEN  - actor IS an effective member but their role is below the
//                policy grade (denied, distinct from NOT_FOUND).
//
// The "workspace_route" policy is deliberately NOT handled here: Workspace
// routes keep their platform-admin semantics via
// requireWorkspacePlatformAdmin, unchanged.

export type EditorialAccessPolicy =
  | "workspace_route"
  | "plugin_read"
  | "plugin_edit"
  | "plugin_checker_run";

export type EditorialPluginPolicy = Exclude<EditorialAccessPolicy, "workspace_route">;

export type EditorialEffectiveRole = "owner" | "editor" | "reviewer" | "viewer";

export class EditorialAccessError extends Error {
  /** Plugin tool layer maps this code to a DENIED outcome. */
  readonly code = "EDIT_FORBIDDEN";

  constructor() {
    super("Editorial access was denied for this Workspace member role.");
    this.name = "EditorialAccessError";
  }
}

export type EditorialAccessDecision =
  | { allowed: true; effectiveRole: EditorialEffectiveRole }
  | { allowed: false; reason: "NOT_FOUND" }
  | { allowed: false; reason: "FORBIDDEN" };

const ROLE_GRADE: Record<EditorialEffectiveRole, number> = {
  owner: 3,
  editor: 2,
  reviewer: 1,
  viewer: 0,
};

const POLICY_MIN_GRADE: Record<EditorialPluginPolicy, number> = {
  plugin_read: 0,
  plugin_edit: 2,
  plugin_checker_run: 2,
};

/**
 * Resolves the effective editorial role for one actor in one Workspace and
 * enforces the plugin policy grade. The plugin tenant proof (pack lineage)
 * remains the OUTER boundary; this resolver is the service-side
 * defense-in-depth role check and NEVER trusts client input.
 */
export async function resolveEditorialPluginAccess(
  db: any,
  input: {
    actorUserId: number;
    workspaceId: number;
    policy: EditorialPluginPolicy;
  }
): Promise<EditorialAccessDecision> {
  const [workspace] = await db
    .select({ ownerUserId: workspaceWorkspaces.ownerUserId })
    .from(workspaceWorkspaces)
    .where(
      and(
        eq(workspaceWorkspaces.id, input.workspaceId),
        eq(workspaceWorkspaces.status, "active"),
        isNull(workspaceWorkspaces.deletedAt)
      )
    )
    .limit(1);
  if (!workspace) return { allowed: false, reason: "NOT_FOUND" };

  if (workspace.ownerUserId === input.actorUserId) {
    return { allowed: true, effectiveRole: "owner" };
  }

  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userId, input.actorUserId),
        eq(workspaceMembers.status, "active")
      )
    )
    .limit(1);
  if (!member) return { allowed: false, reason: "NOT_FOUND" };

  if (ROLE_GRADE[member.role as EditorialEffectiveRole] >= POLICY_MIN_GRADE[input.policy]) {
    return { allowed: true, effectiveRole: member.role as EditorialEffectiveRole };
  }
  return { allowed: false, reason: "FORBIDDEN" };
}
