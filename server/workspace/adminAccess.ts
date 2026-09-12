import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";

export class WorkspaceAdminAccessError extends Error {
  constructor(
    readonly code: "ADMIN_REQUIRED",
    message = "Platform admin access is required for Workspace."
  ) {
    super(message);
    this.name = "WorkspaceAdminAccessError";
  }
}

/**
 * Workspace is an Admin-only back-office capability. Membership rows are
 * retained for compatibility/history only and are not an authorization
 * boundary. Every current platform admin gets the same Workspace authority.
 *
 * The router also uses adminProcedure; this database re-check is intentional
 * defense in depth so direct service callers cannot bypass a role downgrade
 * by relying on a stale session object.
 */
export async function requireWorkspacePlatformAdmin(db: any, userId: number) {
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.role !== "admin") {
    throw new WorkspaceAdminAccessError("ADMIN_REQUIRED");
  }

  return;
}
